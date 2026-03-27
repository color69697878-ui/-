import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";
import { Converter } from "opencc-js";

dotenv.config();

console.log("🚀 BOT v5.1 SMART START");

/* =========================
   OPENCC
========================= */

const toTraditional = Converter({ from: "cn", to: "tw" });

function toTraditionalChinese(text = "") {
  try {
    return toTraditional(String(text || ""));
  } catch {
    return String(text || "");
  }
}

/* =========================
   ENV CHECK
========================= */

const REQUIRED_ENVS = [
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "OPENAI_API_KEY",
  "OWNER_USER_ID",
];

for (const key of REQUIRED_ENVS) {
  if (!process.env[key]) {
    console.error(`❌ 缺少環境變數: ${key}`);
  }
}

/* =========================
   LINE
========================= */

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

/* =========================
   OPENAI
========================= */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 15000,
  maxRetries: 0,
});

/* =========================
   APP
========================= */

const app = express();
const PORT = Number(process.env.PORT || 3000);
const OWNER = process.env.OWNER_USER_ID || "";

/* =========================
   DB
========================= */

const DB_FILE = "./groups.json";

function createDefaultDB() {
  return {
    allowed: [],
    pending: [],
    styles: {},
    dicts: {},
    globalDict: {},
    userLangHints: {},
    settings: {},
  };
}

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const init = createDefaultDB();
      fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2), "utf8");
      return init;
    }

    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object") {
      return createDefaultDB();
    }

    if (!Array.isArray(parsed.allowed)) parsed.allowed = [];
    if (!Array.isArray(parsed.pending)) parsed.pending = [];
    if (!parsed.styles || typeof parsed.styles !== "object") parsed.styles = {};
    if (!parsed.dicts || typeof parsed.dicts !== "object") parsed.dicts = {};
    if (!parsed.globalDict || typeof parsed.globalDict !== "object") parsed.globalDict = {};
    if (!parsed.userLangHints || typeof parsed.userLangHints !== "object") parsed.userLangHints = {};
    if (!parsed.settings || typeof parsed.settings !== "object") parsed.settings = {};

    return parsed;
  } catch (e) {
    console.error("❌ DB 讀取失敗，改用空資料:", e?.message || e);
    return createDefaultDB();
  }
}

let db = loadDB();

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("❌ DB 儲存失敗:", e?.message || e);
    return false;
  }
}

function ensureDBShape(id) {
  if (!db || typeof db !== "object") db = createDefaultDB();
  if (!Array.isArray(db.allowed)) db.allowed = [];
  if (!Array.isArray(db.pending)) db.pending = [];
  if (!db.styles || typeof db.styles !== "object") db.styles = {};
  if (!db.dicts || typeof db.dicts !== "object") db.dicts = {};
  if (!db.globalDict || typeof db.globalDict !== "object") db.globalDict = {};
  if (!db.userLangHints || typeof db.userLangHints !== "object") db.userLangHints = {};
  if (!db.settings || typeof db.settings !== "object") db.settings = {};

  if (id) {
    if (!db.styles[id]) db.styles[id] = "auto";
    if (!db.dicts[id] || typeof db.dicts[id] !== "object") db.dicts[id] = {};
    if (!db.userLangHints[id] || typeof db.userLangHints[id] !== "object") db.userLangHints[id] = {};
    if (!db.settings[id] || typeof db.settings[id] !== "object") {
      db.settings[id] = { autoLangMemory: true };
    }
    if (typeof db.settings[id].autoLangMemory !== "boolean") {
      db.settings[id].autoLangMemory = true;
    }
  }
}

/* =========================
   CACHE
========================= */

const translationCache = new Map();
const CACHE_TTL = 1000 * 60 * 10;
const CACHE_MAX = 700;

const recentMessageMap = new Map();
const DEDUPE_TTL = 4000;

const inflightByChat = new Map();
const MAX_INFLIGHT_PER_CHAT = 2;

const profileCache = new Map();
const PROFILE_TTL = 1000 * 60 * 60 * 12;
const PROFILE_CACHE_MAX = 2000;

function now() {
  return Date.now();
}

function pruneCacheMap(map, ttl, maxSize = 1000) {
  const t = now();

  for (const [k, v] of map.entries()) {
    const ts = typeof v === "object" && v?.ts ? v.ts : v;
    if (!ts || t - ts > ttl) {
      map.delete(k);
    }
  }

  if (map.size <= maxSize) return;

  const entries = [...map.entries()].sort((a, b) => {
    const aTs = typeof a[1] === "object" && a[1]?.ts ? a[1].ts : a[1];
    const bTs = typeof b[1] === "object" && b[1]?.ts ? b[1].ts : b[1];
    return aTs - bTs;
  });

  const removeCount = map.size - maxSize;
  for (let i = 0; i < removeCount; i++) {
    map.delete(entries[i][0]);
  }
}

function getCachedItem(map, key, ttl) {
  const item = map.get(key);
  if (!item) return null;
  if (now() - item.ts > ttl) {
    map.delete(key);
    return null;
  }
  return item.value;
}

function setCachedItem(map, key, value, ttl, maxSize) {
  pruneCacheMap(map, ttl, maxSize);
  map.set(key, { value, ts: now() });
}

function getCachedTranslation(key) {
  return getCachedItem(translationCache, key, CACHE_TTL);
}

function setCachedTranslation(key, value) {
  setCachedItem(translationCache, key, value, CACHE_TTL, CACHE_MAX);
}

function isDuplicateMessage(chatId, text) {
  const key = `${chatId}__${text}`;
  pruneCacheMap(recentMessageMap, DEDUPE_TTL, 1000);

  if (recentMessageMap.has(key)) return true;

  recentMessageMap.set(key, now());
  return false;
}

function enterInflight(chatId) {
  const count = inflightByChat.get(chatId) || 0;
  if (count >= MAX_INFLIGHT_PER_CHAT) return false;
  inflightByChat.set(chatId, count + 1);
  return true;
}

function leaveInflight(chatId) {
  const count = inflightByChat.get(chatId) || 0;
  if (count <= 1) {
    inflightByChat.delete(chatId);
    return;
  }
  inflightByChat.set(chatId, count - 1);
}

/* =========================
   BASIC HELPERS
========================= */

function safeGetId(event) {
  try {
    return (
      event?.source?.groupId ||
      event?.source?.roomId ||
      event?.source?.userId ||
      "default"
    );
  } catch {
    return "default";
  }
}

function getPushTarget(event) {
  return (
    event?.source?.groupId ||
    event?.source?.roomId ||
    event?.source?.userId ||
    ""
  );
}

function isGroupOrRoom(event) {
  return event?.source?.type === "group" || event?.source?.type === "room";
}

function isOwner(event) {
  return (event?.source?.userId || "") === OWNER;
}

function normalizeDictKey(text = "") {
  return String(text || "").trim();
}

function safeText(text) {
  return String(text || "").replace(/\0/g, "").slice(0, 5000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* =========================
   AUTH / STYLE / SETTINGS
========================= */

function isAllowed(id) {
  ensureDBShape();
  return db.allowed.includes(id);
}

function addPending(id) {
  if (!id) return;
  ensureDBShape(id);

  if (!db.pending.includes(id)) {
    db.pending.push(id);
    saveDB();
  }
}

function approveGroup(id) {
  if (!id) return false;
  ensureDBShape(id);

  db.pending = db.pending.filter((x) => x !== id);
  if (!db.allowed.includes(id)) db.allowed.push(id);
  if (!db.styles[id]) db.styles[id] = "auto";

  saveDB();
  return true;
}

function rejectGroup(id) {
  if (!id) return false;
  ensureDBShape(id);
  db.pending = db.pending.filter((x) => x !== id);
  saveDB();
  return true;
}

function getStyle(id) {
  ensureDBShape(id);
  return db.styles[id] || "auto";
}

function setStyle(id, style) {
  ensureDBShape(id);
  db.styles[id] = style;
  saveDB();
}

function getChatSettings(id) {
  ensureDBShape(id);
  return db.settings[id] || { autoLangMemory: true };
}

function setAutoLangMemory(id, enabled) {
  ensureDBShape(id);
  db.settings[id].autoLangMemory = !!enabled;
  saveDB();
}

/* =========================
   DICT
========================= */

function getDict(id) {
  ensureDBShape(id);
  return db.dicts[id] || {};
}

function setDict(id, source, target) {
  ensureDBShape(id);
  const k = normalizeDictKey(source);
  const v = String(target || "").trim();
  if (!k || !v) return false;
  db.dicts[id][k] = v;
  saveDB();
  return true;
}

function deleteDict(id, source) {
  ensureDBShape(id);
  const k = normalizeDictKey(source);
  if (!(k in db.dicts[id])) return false;
  delete db.dicts[id][k];
  saveDB();
  return true;
}

function buildDictList(id) {
  const dict = getDict(id);
  const entries = Object.entries(dict);

  if (!entries.length) return "目前此群組沒有自訂詞典";

  return `此群組自訂詞典：\n\n${entries
    .slice(0, 100)
    .map(([k, v], i) => `${i + 1}. ${k} => ${v}`)
    .join("\n")}`;
}

function getGlobalDict() {
  ensureDBShape();
  return db.globalDict || {};
}

function setGlobalDict(source, target) {
  ensureDBShape();
  const k = normalizeDictKey(source);
  const v = String(target || "").trim();
  if (!k || !v) return false;
  db.globalDict[k] = v;
  saveDB();
  return true;
}

function deleteGlobalDict(source) {
  ensureDBShape();
  const k = normalizeDictKey(source);
  if (!(k in db.globalDict)) return false;
  delete db.globalDict[k];
  saveDB();
  return true;
}

function buildGlobalDictList() {
  const dict = getGlobalDict();
  const entries = Object.entries(dict);

  if (!entries.length) return "目前沒有全域詞典";

  return `全域詞典：\n\n${entries
    .slice(0, 200)
    .map(([k, v], i) => `${i + 1}. ${k} => ${v}`)
    .join("\n")}`;
}

/* =========================
   PROFILE
========================= */

function buildProfileCacheKey(event) {
  const source = event?.source || {};
  const chatId = source.groupId || source.roomId || source.userId || "default";
  const userId = source.userId || "nouser";
  const type = source.type || "unknown";
  return `${type}:${chatId}:${userId}`;
}

async function fetchLineProfile(event) {
  const source = event?.source || {};
  const userId = source.userId;

  if (!userId) return null;

  const cacheKey = buildProfileCacheKey(event);
  const cached = getCachedItem(profileCache, cacheKey, PROFILE_TTL);
  if (cached !== null) return cached;

  try {
    let profile = null;

    if (source.type === "user") {
      profile = await client.getProfile(userId);
    } else if (source.type === "group" && source.groupId) {
      profile = await client.getGroupMemberProfile(source.groupId, userId);
    } else if (source.type === "room" && source.roomId) {
      profile = await client.getRoomMemberProfile(source.roomId, userId);
    }

    const name = String(profile?.displayName || "").trim();
    const iconUrl = String(profile?.pictureUrl || "").trim();

    if (!name || !iconUrl) {
      setCachedItem(profileCache, cacheKey, null, PROFILE_TTL, PROFILE_CACHE_MAX);
      return null;
    }

    const sender = {
      name: name.slice(0, 20),
      iconUrl,
    };

    setCachedItem(profileCache, cacheKey, sender, PROFILE_TTL, PROFILE_CACHE_MAX);
    return sender;
  } catch (e) {
    console.error("❌ 取得 LINE profile 失敗:", {
      message: e?.message || e,
      sourceType: source.type,
      groupId: source.groupId,
      roomId: source.roomId,
      userId,
    });

    setCachedItem(profileCache, cacheKey, null, PROFILE_TTL, PROFILE_CACHE_MAX);
    return null;
  }
}

/* =========================
   IGNORE / SKIP RULES
========================= */

function isEmojiOrPunctuationOnly(text = "") {
  const t = String(text || "").trim();
  if (!t) return true;

  return /^[\p{Emoji}\p{Extended_Pictographic}\p{Emoji_Presentation}\s~`!@#$%^&*()_\-+=[\]{}\\|;:'",.<>/?，。！？、；：（）【】《》「」『』…—><]+$/u.test(
    t
  );
}

function shouldIgnoreText(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (isEmojiOrPunctuationOnly(t)) return true;

  if (
    /^[\p{Emoji}\p{Extended_Pictographic}\s!-/:-@[-`{-~]+$/u.test(t) &&
    t.length <= 20
  ) {
    return true;
  }

  return false;
}

function shouldSkipTranslateToken(text = "") {
  const t = String(text || "").trim().toUpperCase();
  return /^(?:\d+\s*)?(IN|OUT)(?:\s*\d+)?$/.test(t);
}

function shouldSkipMentionMessage(event) {
  const text = String(event?.message?.text || "").trim();
  const mention = event?.message?.mention;

  if (mention?.mentionees?.length) {
    const cleaned = text
      .replace(/@\S+/g, "")
      .replace(
        /[\p{Emoji}\p{Extended_Pictographic}\p{Emoji_Presentation}\s~`!@#$%^&*()_\-+=[\]{}\\|;:'",.<>/?，。！？、；：（）【】《》「」『』…—><]+/gu,
        ""
      )
      .trim();

    if (!cleaned) return true;
  }

  if (/^@\S+$/.test(text)) return true;

  return false;
}

function shouldSkipTranslateByContent(event) {
  const message = event?.message || {};
  const text = String(message?.text || "").trim();

  if (message?.type && message.type !== "text") return true;
  if (shouldIgnoreText(text)) return true;
  if (shouldSkipTranslateToken(text)) return true;
  if (shouldSkipMentionMessage(event)) return true;

  return false;
}

/* =========================
   ADDRESS / ROUTE
========================= */

function looksLikeAddress(text = "") {
  const t = String(text || "").trim();

  // 只有很像「純地址」才略過
  // 不要把 2號房 / 3樓 / 紅色的門 這種指示句誤判
  const pureAddressPattern =
    /^(?:台灣|臺灣)?[\u4E00-\u9FFF\d\s\-]+(?:市|縣)(?:[\u4E00-\u9FFF\d\s\-]+(?:區|鄉|鎮|市))?(?:[\u4E00-\u9FFF\d\s\-]+(?:路|街|大道))(?:\d+段)?(?:\d+巷)?(?:\d+弄)?(?:\d+號)(?:\d+樓)?$/;

  return pureAddressPattern.test(t);
}

/* =========================
   LANGUAGE / MEMORY
========================= */

function hasThai(text = "") {
  return /[\u0E00-\u0E7F]/.test(text);
}

function hasChinese(text = "") {
  return /[\u4E00-\u9FFF]/.test(text);
}

function hasEnglish(text = "") {
  return /[a-zA-Z]/.test(text);
}

function containsThai(text = "") {
  return /[\u0E00-\u0E7F]/.test(String(text || ""));
}

function containsChinese(text = "") {
  return /[\u4E00-\u9FFF]/.test(String(text || ""));
}

function detectLang(text = "") {
  const hasTh = hasThai(text);
  const hasZh = hasChinese(text);
  const hasEn = hasEnglish(text);

  if (hasTh && !hasZh) return "th";
  if (hasZh && !hasTh) return "zh";
  if (!hasTh && !hasZh && hasEn) return "en";
  if (hasTh && hasZh) return "mixed";
  return "unknown";
}

function getTargetLanguage(lang) {
  if (lang === "zh") return "泰文";
  if (lang === "th") return "繁體中文";
  return "繁體中文";
}

function isLikelyBilingualBlock(text = "") {
  const lines = String(text)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (lines.length < 2) return false;

  let hasZhLine = false;
  let hasThLine = false;

  for (const line of lines) {
    if (hasChinese(line)) hasZhLine = true;
    if (hasThai(line)) hasThLine = true;
  }

  return hasZhLine && hasThLine;
}

function updateUserLangHint(event, lang) {
  const chatId = safeGetId(event);
  const userId = event?.source?.userId || "";
  if (!userId) return;
  if (!["zh", "th", "en"].includes(lang)) return;

  ensureDBShape(chatId);

  const prev = db.userLangHints[chatId][userId];
  const same = prev && prev.lang === lang;
  db.userLangHints[chatId][userId] = {
    lang,
    ts: now(),
    count: same ? Math.min((prev.count || 0) + 1, 50) : 1,
  };
  saveDB();
}

function getUserLangHint(event) {
  const chatId = safeGetId(event);
  const userId = event?.source?.userId || "";
  if (!userId) return null;

  ensureDBShape(chatId);

  const item = db.userLangHints?.[chatId]?.[userId];
  if (!item) return null;

  if (now() - (item.ts || 0) > 1000 * 60 * 60 * 24 * 7) {
    return null;
  }

  return item;
}

function detectLangSmart(text = "", event = null) {
  const direct = detectLang(text);
  if (direct !== "unknown" && direct !== "mixed") return direct;

  if (!event) return direct;

  const chatId = safeGetId(event);
  const settings = getChatSettings(chatId);
  if (!settings.autoLangMemory) return direct;

  const hint = getUserLangHint(event);
  if (hint?.lang && hint.count >= 2) {
    return hint.lang;
  }

  return direct;
}

/* =========================
   VALIDATION / QUESTION
========================= */

function isTranslationValid(sourceText = "", translatedText = "", target = "") {
  const src = String(sourceText || "").trim();
  const out = String(translatedText || "").trim();

  if (!out) return false;
  if (src === out) return false;

  if (target === "泰文") return containsThai(out);
  if (target === "繁體中文") return containsChinese(out);

  return true;
}

function forceValidFinalOutput(sourceText = "", outputText = "", sourceLang = "") {
  const src = String(sourceText || "").trim();
  const out = String(outputText || "").trim();

  if (!out) return "";

  if (src === out) return "";

  if (sourceLang === "zh" && !containsThai(out)) return "";
  if (sourceLang === "th" && !containsChinese(out)) return "";

  return out;
}

function looksLikeQuestion(text = "") {
  const t = String(text || "").trim();
  return /[?？]|(嗎|吗|呢)$|(ใช่ไหม|ไหม|หรือเปล่า|เหรอ|หรอ|มั้ย)/.test(t);
}

function forceQuestionMarkByTarget(text = "", target = "", sourceText = "") {
  const out = String(text || "").trim();
  const src = String(sourceText || "").trim();

  if (!looksLikeQuestion(src)) return out;
  if (/[?？]$/.test(out)) return out;

  if (target === "泰文") return `${out}？`;
  if (target === "繁體中文") return `${out}？`;

  return out;
}

/* =========================
   PROTECTION
========================= */

const KEYWORD_PLACEHOLDERS = {
  "突然": "__KW_TURAN__",
  "剛剛": "__KW_GANGGANG__",
  "刚刚": "__KW_GANGGANG__",
  "剛才": "__KW_GANGGANG__",
  "刚才": "__KW_GANGGANG__",
  "現在": "__KW_NOW__",
  "现在": "__KW_NOW__",
};

const KEYWORD_BY_TARGET = {
  "繁體中文": {
    "__KW_TURAN__": "突然",
    "__KW_GANGGANG__": "剛剛",
    "__KW_NOW__": "現在",
  },
  "泰文": {
    "__KW_TURAN__": "ทันใดนั้น",
    "__KW_GANGGANG__": "เมื่อกี้",
    "__KW_NOW__": "ตอนนี้",
  },
};

function protectKeywords(text = "") {
  let t = String(text || "");
  for (const [source, token] of Object.entries(KEYWORD_PLACEHOLDERS)) {
    t = t.replace(new RegExp(source, "g"), token);
  }
  return t;
}

function restoreKeywordsByTarget(text = "", target = "繁體中文") {
  let t = String(text || "");
  const map = KEYWORD_BY_TARGET[target] || {};

  for (const [token, translated] of Object.entries(map)) {
    t = t.replace(new RegExp(token, "g"), translated);
  }

  return t;
}

const PROTECTED_TERMS = [
  "Kitty",
  "kitty",
  "Nana",
  "nana",
  "Ploy",
  "ploy",
  "Praew",
  "praew",
  "Asok",
  "asok",
  "Bangkok",
  "bangkok",
  "LINE",
  "Facebook",
  "Instagram",
  "桃園",
  "中壢",
  "板橋",
  "台北",
  "臺北",
];

function escapeRegExp(text = "") {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function protectProperNouns(text = "") {
  let out = String(text || "");
  const tokens = [];

  for (let i = 0; i < PROTECTED_TERMS.length; i++) {
    const term = PROTECTED_TERMS[i];
    const token = `__PN_${i}__`;
    const regex = new RegExp(escapeRegExp(term), "g");

    if (regex.test(out)) {
      out = out.replace(regex, token);
      tokens.push([token, term]);
    }
  }

  return { text: out, tokens };
}

function restoreProperNouns(text = "", tokens = []) {
  let out = String(text || "");

  for (const [token, term] of tokens) {
    out = out.replace(new RegExp(escapeRegExp(token), "g"), term);
  }

  return out;
}

function normalizeForPhoneContext(text = "") {
  const t = String(text || "").trim();

  const rules = [
    [/ก่อนวางสาย/g, "ก่อน挂電話"],
    [/วางสาย/g, "挂電話"],
    [/ตัดสาย/g, "挂電話"],
    [/ก่อนวาง/g, "掛電話前"],
  ];

  let out = t;
  for (const [pattern, replacement] of rules) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/* =========================
   PROTECTED PHRASES
========================= */

function protectedPhraseTranslate(text, lang) {
  const t = String(text || "").trim();

  if (lang === "th") {
    const thMap = {
      "แค่ต้องการมือถือคืน ฉันไม่ได้คุยกับเธอตั้งแต่เมื่อคืน":
        "我只是想把手機拿回來，我從昨天晚上就沒跟她聯絡了",
      "ฉันไม่ได้คุยกับเธอตั้งแต่เมื่อคืน":
        "我從昨天晚上就沒跟她聯絡了",
      "ฉันไม่ได้คุยกับเขาตั้งแต่เมื่อคืน":
        "我從昨天晚上就沒跟他聯絡了",
      "ขอมือถือคืน": "把手機還給我",
      "ขอคืน": "把東西還給我",
      "เอาคืน": "拿回來",
      "เอามือถือคืน": "把手機拿回來",
      "แค่ต้องการมือถือคืน": "我只是想把手機拿回來",
      "เธอมาถึงกี่วันแล้วคะ": "她來幾天了？",
      "เธอมาถึงกี่วันแล้วค่ะ": "她來幾天了？",
      "เธอมาถึงกี่วันแล้ว": "她來幾天了？",
      "เขามาถึงกี่วันแล้วคะ": "她來幾天了？",
      "เขามาถึงกี่วันแล้วค่ะ": "她來幾天了？",
      "เขามาถึงกี่วันแล้ว": "她來幾天了？",
      "คุณบอกเค้าแล้วหรอคะ": "妳跟她說了嗎？",
      "คุณบอกเค้าแล้วหรอค่ะ": "妳跟她說了嗎？",
      "คุณบอกเขาแล้วหรอคะ": "妳跟她說了嗎？",
      "คุณบอกเขาแล้วหรือคะ": "妳跟她說了嗎？",
      "เธอนอนหรอ": "她睡了嗎？",
      "เธอนอนแล้วหรอ": "她睡了嗎？",
      "เขานอนหรอ": "她睡了嗎？",
      "เขานอนแล้วหรอ": "她睡了嗎？",
      "เธอมาแล้วหรอ": "她到了嗎？",
      "เธอมาแล้วหรอคะ": "她到了嗎？",
      "เขามาแล้วหรอ": "她到了嗎？",
      "เขามาแล้วหรอคะ": "她到了嗎？",
      "เธออยู่ไหน": "她在哪裡？",
      "เขาอยู่ไหน": "她在哪裡？",
      "เค้าอยู่ไหน": "她在哪裡？",
      "ตอนนี้ฉันยังอยู่เถวหยวนอยู่เลยค่ะ": "我現在還在桃園這邊喔",
      "ตอนนี้ฉันยังอยู่เถาหยวนอยู่เลยค่ะ": "我現在還在桃園這邊喔",
      "ตอนนี้ฉันยังอยู่แถวเถาหยวนอยู่เลยค่ะ": "我現在還在桃園這邊喔",
      "พรุ่งนี้เข้าไปร้านใหม่": "明天去新的店",
      "พรุ่งนี้ไปร้านใหม่": "明天去新的店",
      "พรุ่งนี้เข้าไปที่ร้านใหม่": "明天去新的店",
      "พรุ่งนี้เช้าไปร้านใหม่": "明天早上去新的店",
      "ฉันบอกคุณก่อนวางตลอด": "我每次掛電話前都會先跟你說",
      "ฉันบอกคุณก่อนวาง": "我會先跟你說再掛電話",
      "ก่อนวาง": "掛電話之前",
      "วางสาย": "掛電話",
      "ตัดสาย": "掛電話",
      "ไม่ใช่คุณคิดจะวางก็วาง": "不是你想掛電話就掛",
      "ไม่ใช่คิดจะวางก็วาง": "不是想掛就掛",
    };

    if (thMap[t]) return thMap[t];
  }

  if (lang === "zh") {
    const zhMap = {
      "我從昨天晚上就沒跟她說話了": "ฉันไม่ได้คุยกับเธอตั้งแต่เมื่อคืน",
      "我從昨晚就沒跟她聯絡了": "ฉันไม่ได้คุยกับเธอตั้งแต่เมื่อคืน",
      "我只是想把手機拿回來": "แค่ต้องการเอามือถือคืน",
      "把手機還給我": "ขอมือถือคืน",
      "她來幾天了？": "เธอมาถึงกี่วันแล้วคะ",
      "妳跟她說了嗎？": "คุณบอกเค้าแล้วหรอคะ",
      "她睡了嗎？": "เธอนอนแล้วหรอ",
      "她到了嗎？": "เธอมาแล้วหรอ",
      "她在哪裡？": "เธออยู่ไหน",
      "我早上沒辦法這麼早起床送你回去":
        "ตอนเช้าฉันตื่นเช้าขนาดนั้นไม่ไหว เลยไปส่งเธอกลับไม่ได้",
      "我沒辦法這麼早起床送你回去":
        "ฉันตื่นเช้าขนาดนั้นไม่ไหว เลยไปส่งเธอกลับไม่ได้",
      "我早上起不來": "ตอนเช้าฉันตื่นไม่ไหว",
      "我沒辦法去接你": "ฉันไปรับเธอไม่ได้",
      "我沒辦法送你回去": "ฉันไปส่งเธอกลับไม่ได้",
      "剛剛": "เมื่อกี้",
      "刚刚": "เมื่อกี้",
      "剛才": "เมื่อกี้",
      "刚才": "เมื่อกี้",
      "現在": "ตอนนี้",
      "现在": "ตอนนี้",
      "為什麼": "ทำไม",
      "为什么": "ทำไม",
      "是不是現在": "ตอนนี้ใช่ไหม",
      "是不是现在": "ตอนนี้ใช่ไหม",
      "突然": "ทันใดนั้น",
    };

    if (zhMap[t]) return zhMap[t];
  }

  return "";
}

/* =========================
   FAST TRANSLATE
========================= */

function thaiFast(text) {
  const t = text.trim();
  const dict = {
    "ค่ะ": "好",
    "ครับ": "好",
    "คะ": "好",
    "ใช่": "對",
    "ใช่ค่ะ": "對",
    "ใช่ครับ": "對",
    "ได้": "可以",
    "ได้ค่ะ": "可以",
    "ได้ครับ": "可以",
    "ยัง": "還沒",
    "ไม่": "不",
    "ไป": "去",
    "มา": "來",
    "ไปค่ะ": "會去",
    "ไปครับ": "會去",
    "มาค่ะ": "會來",
    "มาครับ": "會來",
    "ไปไหน": "要去哪",
    "มาไหม": "要來嗎",
    "ไปไหม": "要去嗎",
    "ไม่ไป": "不去",
    "ไม่มา": "不來",
    "มาแล้ว": "來了",
    "ไปแล้ว": "去了",
    "กลับแล้ว": "回去了",
    "ออกไปแล้ว": "離開了",
    "ออกมาแล้ว": "出來了",
    "โอเค": "好",
    "โอเคค่ะ": "好",
    "โอเคครับ": "好",
  };
  return dict[t] || "";
}

function zhFast(text) {
  const t = text.trim();
  const dict = {
    "嗯": "อืม",
    "恩": "อืม",
    "喔": "อ๋อ",
    "哦": "อ๋อ",
    "嗯嗯": "อืม",
    "可以": "ได้",
    "去": "ไป",
    "來": "มา",
    "来": "มา",
    "对": "ใช่",
    "對": "ใช่",
    "是": "ใช่",
    "好": "โอเค",
    "好的": "โอเค",
    "剛剛": "เมื่อกี้",
    "刚刚": "เมื่อกี้",
    "現在": "ตอนนี้",
    "现在": "ตอนนี้",
    "等一下": "รอสักครู่",
    "等一下喔": "รอสักครู่นะ",
    "為什麼": "ทำไม",
    "为什么": "ทำไม",
    "是不是現在": "ตอนนี้ใช่ไหม",
    "是不是现在": "ตอนนี้ใช่ไหม",
    "剛才": "เมื่อกี้",
    "刚才": "เมื่อกี้",
    "突然": "ทันใดนั้น",
  };
  return dict[t] || "";
}

function enFast(text) {
  const t = text.trim().toLowerCase();
  const dict = {
    "now": "現在",
    "why": "為什麼",
    "ok": "好",
    "wait": "等一下",
    "just now": "剛剛",
  };
  return dict[t] || "";
}

/* =========================
   FALLBACK
========================= */

function fallbackMessage(lang) {
  if (lang === "zh") return "稍等一下我再翻一次 🙏";
  if (lang === "th") return "ขอเวลาสักครู่ เดี๋ยวฉันแปลให้อีกครั้ง 🙏";
  return "Please wait a moment, I’ll translate it again 🙏";
}

/* =========================
   SMART ROUTING
========================= */

function shouldUseFastTranslate(text = "", lang = "unknown") {
  const t = String(text || "").trim();
  if (!t) return false;

  if (t.length <= 4) return true;
  if (lang === "zh" && /^[\u4E00-\u9FFF]{1,4}$/.test(t)) return true;
  if (lang === "th" && /^[\u0E00-\u0E7F]{1,6}$/.test(t)) return true;
  if (lang === "en" && /^[a-zA-Z\s]{1,8}$/.test(t)) return true;

  return false;
}

/* =========================
   PROMPT
========================= */

function buildStyleInstruction(style) {
  const base = `
你是中泰聊天翻譯助手。
只輸出翻譯結果。
不要解釋，不要加引號，不要加前言，不要加備註。
翻譯要自然、口語、符合聊天習慣。
如果原文有明顯錯字、缺字、口語亂打，要先理解最可能原意再翻譯。
如果句中出現疑似地名、音譯詞、不明專有名詞，不可自行腦補成喝酒、夜店、上班等場景。
若無法確定不明詞意思，優先保守翻成某個地方，或保留主幹語意。

若句中出現人名、暱稱、店名、地名、英文名、音譯名，
例如 Kitty、Nana、Ploy、Asok 這類，
優先視為專有名詞保留，不可硬翻成其他動詞、代詞或關係語意。

泰文句型中若出現：
- ไปเอาของที่X
- ไปหาX
- อยู่ที่X
- เอาของจากX
其中 X 很可能是人名、店名或地點，
應優先翻成「去X那邊拿／找X／在X那裡／從X那裡拿」，
不要誤翻成「你給的」或其他關係語句。

若內容是路線、位置、房號、樓層、電梯方向、門禁卡、感應卡、進房步驟，
必須完整翻譯每個步驟，不可省略，不可直接照抄原文。

例如：
- 3樓 / 2號房 / 電梯右轉 / 紅色的門 / 感應卡進去
這些都必須完整翻出來。

若輸入是中文，必須輸出泰文。
若輸入是泰文，必須輸出繁體中文。
禁止原文照抄，禁止維持原語言不變。

若原文是問句，翻譯後也必須保留問句語氣。
像「是嗎？」「對嗎？」「可以嗎？」「有了嗎？」不可翻成陳述句。

嚴格保持人稱與關係方向正確：
- 我對她 / 我對你 / 她對我 / 你對我，不可翻反。
- 「我沒跟她說話」不可翻成「她沒跟我說話」。
- 「我沒跟你說話」不可翻成「你沒跟我說話」。
- 「跟她聯絡」與「她聯絡我」不可互換。
- 「把手機拿回來」不可隨意翻成「把手機還給我」，除非原文明確表示對方要歸還。

嚴格根據上下文判斷代詞：
- 泰文「เธอ」不可一律翻成你，可能是她。
- 泰文「เขา / เค้า」不可一律翻成他，也可能是她。
- 若句子明顯在討論第三人，不可翻成直接對話的你。
- 看到「來幾天了、到了多久、跟她說了嗎、她有沒有來、她睡了嗎、她在哪裡」這類句型，優先判斷是否為第三人稱。

電話場景特別注意：
- วาง / วางสาย / ตัดสาย 常常是 掛電話，不是放東西。
- 若上下文明顯在講電話，不可把 วาง 翻成 放下。

句子中若包含時間詞或語氣詞，例如：
「剛剛、突然、現在、等一下」
必須保留並正確翻譯，不可忽略、不可省略、不可改寫成其他語氣。

禁止回覆：
- 請提供內容
- 請提供需要翻譯的聊天訊息
- 無法翻譯
- 看不懂
- 請輸入

只能輸出翻譯結果。
`;

  const styles = {
    auto: "請自動選擇最自然的聊天語氣。",
    precise: "請以原意優先，不要過度腦補。",
    casual: "請用朋友聊天口氣。",
    romance: "請保留感情與柔和語氣。",
    nightlife: "你懂夜生活場景，但不可亂猜地名或活動。",
    work: "請清楚自然，稍微正式。",
    feminine: "請用自然柔和的女生聊天感。",
    masculine: "請用自然直接的男生聊天感。",
  };

  return `${base}\n${styles[style] || styles.auto}`;
}

function isModelRefusal(text = "") {
  const t = String(text || "");
  return (
    t.includes("請提供") ||
    t.includes("无法翻译") ||
    t.includes("無法翻譯") ||
    t.includes("請輸入") ||
    t.includes("看不懂") ||
    t.includes("需要翻譯的聊天訊息") ||
    t.includes("需要翻译的聊天讯息") ||
    t.includes("抱歉，我無法協助處理該內容")
  );
}

/* =========================
   GPT TRANSLATE
========================= */

async function translate(text, target, style = "auto", event = null) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY 不存在");
    return null;
  }

  const protectedText = protectKeywords(text);
  const properNounProtected = protectProperNouns(protectedText);
  const normalizedSource = normalizeForPhoneContext(properNounProtected.text);

  const chatId = event ? safeGetId(event) : "default";
  const langHint = event ? getUserLangHint(event) : null;
  const settings = getChatSettings(chatId);

  const cacheKey = `${style}__${target}__${normalizedSource}__${langHint?.lang || "nohint"}__${settings.autoLangMemory ? "mem1" : "mem0"}`;
  const cached = getCachedTranslation(cacheKey);
  if (cached) {
    console.log("🧠 命中翻譯快取");
    return cached;
  }

  const memoryHintText =
    settings.autoLangMemory && langHint?.lang && langHint?.count >= 2
      ? `補充判斷：這位發話者近期多次使用 ${langHint.lang === "zh" ? "中文" : langHint.lang === "th" ? "泰文" : "英文"}。若原句過短或模糊，可優先參考此方向，但不可違反原文內容。`
      : "";

  const maxAttempts = 2;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      console.log(`🧠 OpenAI 翻譯中，第 ${i + 1}/${maxAttempts} 次`);

      const r = await openai.chat.completions.create(
        {
          model: "gpt-4o-mini",
          temperature: 0.05,
          messages: [
            {
              role: "system",
              content: buildStyleInstruction(style),
            },
            {
              role: "user",
              content:
                `請把這句內容翻譯成${target}。

無論內容是否完整、是否像句子、是否有錯字，
都必須翻譯成最合理的聊天意思。

句中若有專有名詞、人名、英文名、暱稱、地名，
請保留原詞，不可亂翻。

${memoryHintText}

內容如下：
${normalizedSource}`,
            },
          ],
        },
        {
          timeout: 12000,
          maxRetries: 0,
        }
      );

      const result = r?.choices?.[0]?.message?.content?.trim();

      if (result) {
        let clean = toTraditionalChinese(safeText(result));
        clean = restoreKeywordsByTarget(clean, target);
        clean = restoreProperNouns(clean, properNounProtected.tokens);
        clean = forceQuestionMarkByTarget(clean, target, text);

        if (isModelRefusal(clean)) {
          console.log("⚠️ 偵測到AI拒答");
          continue;
        }

        if (!isTranslationValid(text, clean, target)) {
          console.log("⚠️ 翻譯結果無效，疑似未翻譯成功:", {
            source: text,
            output: clean,
            target,
          });
          continue;
        }

        setCachedTranslation(cacheKey, clean);
        console.log("✅ OpenAI 翻譯成功");
        return clean;
      }
    } catch (e) {
      console.error(`❌ OpenAI error 第 ${i + 1} 次:`, {
        name: e?.name,
        message: e?.message || e,
        status: e?.status,
        code: e?.code,
        type: e?.type,
      });
    }

    if (i < maxAttempts - 1) {
      await sleep(800);
    }
  }

  return null;
}

async function translateMixedLines(text, style = "auto", event = null) {
  const lines = String(text)
    .split("\n")
    .map((s) => s.trim());

  const out = [];

  for (const line of lines) {
    if (!line) {
      out.push("");
      continue;
    }

    if (shouldIgnoreText(line)) {
      out.push(line);
      continue;
    }

    const lang = detectLangSmart(line, event);

    if (lang === "zh") {
      if (shouldUseFastTranslate(line, lang)) {
        const fast = zhFast(line);
        if (fast) {
          out.push(restoreKeywordsByTarget(toTraditionalChinese(fast), "泰文"));
          continue;
        }
      }

      if (line.length <= 15) {
        const protectedResult = protectedPhraseTranslate(line, lang);
        if (protectedResult) {
          out.push(restoreKeywordsByTarget(toTraditionalChinese(protectedResult), "泰文"));
          continue;
        }
      }

      const result = await translate(line, "泰文", style, event);
      out.push(result ? restoreKeywordsByTarget(toTraditionalChinese(result), "泰文") : line);
      continue;
    }

    if (lang === "th") {
      if (shouldUseFastTranslate(line, lang)) {
        const fast = thaiFast(line);
        if (fast) {
          out.push(restoreKeywordsByTarget(toTraditionalChinese(fast), "繁體中文"));
          continue;
        }
      }

      if (line.length <= 15) {
        const protectedResult = protectedPhraseTranslate(line, lang);
        if (protectedResult) {
          out.push(restoreKeywordsByTarget(toTraditionalChinese(protectedResult), "繁體中文"));
          continue;
        }
      }

      const result = await translate(line, "繁體中文", style, event);
      out.push(result ? restoreKeywordsByTarget(toTraditionalChinese(result), "繁體中文") : line);
      continue;
    }

    if (lang === "en") {
      if (shouldUseFastTranslate(line, lang)) {
        const fast = enFast(line);
        if (fast) {
          out.push(restoreKeywordsByTarget(toTraditionalChinese(fast), "繁體中文"));
          continue;
        }
      }

      const result = await translate(line, "繁體中文", style, event);
      out.push(result ? restoreKeywordsByTarget(toTraditionalChinese(result), "繁體中文") : line);
      continue;
    }

    out.push(toTraditionalChinese(line));
  }

  return out.join("\n");
}

/* =========================
   LINE SEND
========================= */

function buildMessageObject(text, sender) {
  const message = {
    type: "text",
    text: toTraditionalChinese(safeText(text)),
  };

  if (sender?.name && sender?.iconUrl) {
    message.sender = {
      name: String(sender.name).slice(0, 20),
      iconUrl: String(sender.iconUrl),
    };
  }

  return message;
}

async function safeReply(replyToken, text, sender) {
  if (!replyToken) return false;

  try {
    await client.replyMessage(replyToken, buildMessageObject(text, sender));
    console.log("✅ reply 成功");
    return true;
  } catch (e) {
    console.error("❌ reply 失敗:", e?.message || e);
    return false;
  }
}

async function safePush(to, text, sender) {
  if (!to) return false;

  try {
    await client.pushMessage(to, buildMessageObject(text, sender));
    console.log("✅ push 成功");
    return true;
  } catch (e) {
    console.error("❌ push 失敗:", e?.message || e);
    return false;
  }
}

async function smartReply(event, text, sender) {
  const pushTarget = getPushTarget(event);
  const finalText = toTraditionalChinese(text);

  const ok = await safeReply(event?.replyToken, finalText, sender);
  if (ok) return true;

  console.log("⚠️ reply 失敗，改用 push 補發");
  return await safePush(pushTarget, finalText, sender);
}

/* =========================
   HELP
========================= */

function buildHelpText(isOwnerUser = false, chatId = "") {
  const settings = chatId ? getChatSettings(chatId) : { autoLangMemory: true };

  let msg = `可用指令：

/help
/myid
/groupid
/mystyle
/debuglang
/dict list
/langmemory

這版會自動依發話者切換頭像
只有 OWNER 可以授權群組翻譯
目前智慧語言記憶：${settings.autoLangMemory ? "開啟" : "關閉"}

如果 OWNER 本人在群組內，可直接：
/approve`;

  if (isOwnerUser) {
    msg += `

管理員指令：

/pending
/approve
/reject
/approve 群組ID
/reject 群組ID
/style auto
/style precise
/style casual
/style romance
/style nightlife
/style work
/style feminine
/style masculine
/langmemory on
/langmemory off
/dict list
/dict add 原文 => 翻譯
/dict del 原文
/gdict list
/gdict add 原文 => 翻譯
/gdict del 原文`;
  }

  return msg;
}

/* =========================
   EVENT HANDLERS
========================= */

async function handleJoin(event) {
  const id = safeGetId(event);
  const sender = await fetchLineProfile(event);

  console.log("👥 join event, id:", id);

  if (!isAllowed(id)) {
    addPending(id);
    await smartReply(
      event,
      `🔐 此群組尚未授權

只有 OWNER 可以授權
若 OWNER 本人在群組內，可直接輸入：
/approve`,
      sender
    );
    return;
  }

  await smartReply(event, "✅ 此群組已授權", sender);
}

async function handleTextMessage(event) {
  const text = event?.message?.text?.trim();
  if (!text) return;

  const id = safeGetId(event);
  const style = getStyle(id);

  console.log("📩 收到訊息:", text);
  console.log("🆔 id:", id);
  console.log("🎨 style:", style);

  if (shouldIgnoreText(text)) return;

  if (shouldSkipTranslateToken(text)) {
    console.log("⚠️ 命中不翻譯代碼:", text);
    return;
  }

  if (shouldSkipMentionMessage(event)) {
    console.log("⚠️ 命中純標記訊息，不翻譯:", text);
    return;
  }

  if (isDuplicateMessage(id, text)) return;

  if (!enterInflight(id)) {
    const busySender = await fetchLineProfile(event);
    await smartReply(event, "⚠️ 訊息較多，請稍後再試", busySender);
    return;
  }

  try {
    const sender = await fetchLineProfile(event);

    /* ===== 指令優先 ===== */

    if (text === "/help") {
      await smartReply(event, buildHelpText(isOwner(event), id), sender);
      return;
    }

    if (text === "/myid") {
      await smartReply(event, event?.source?.userId || "查不到 userId", sender);
      return;
    }

    if (text === "/groupid") {
      await smartReply(event, isGroupOrRoom(event) ? id : "這不是群組或聊天室", sender);
      return;
    }

    if (text === "/mystyle") {
      if (!isGroupOrRoom(event)) {
        await smartReply(event, "請在群組或聊天室使用", sender);
        return;
      }
      await smartReply(event, `目前翻譯風格：${getStyle(id)}`, sender);
      return;
    }

    if (text === "/langmemory") {
      if (!isGroupOrRoom(event)) {
        await smartReply(event, "請在群組或聊天室使用", sender);
        return;
      }
      const enabled = getChatSettings(id).autoLangMemory;
      await smartReply(event, `智慧語言記憶目前：${enabled ? "開啟" : "關閉"}`, sender);
      return;
    }

    if (text === "/debuglang") {
      const lang = detectLangSmart(text, event);
      const hint = getUserLangHint(event);
      await smartReply(
        event,
        `判斷結果：${lang}\n記憶提示：${hint ? `${hint.lang} / ${hint.count}` : "無"}`,
        sender
      );
      return;
    }

    if (text.startsWith("/debuglang ")) {
      const raw = text.replace("/debuglang ", "").trim();
      const lang = detectLangSmart(raw, event);
      const hint = getUserLangHint(event);
      await smartReply(
        event,
        `判斷結果：${lang}\n記憶提示：${hint ? `${hint.lang} / ${hint.count}` : "無"}`,
        sender
      );
      return;
    }

    if (text === "/dict list") {
      if (!isGroupOrRoom(event)) {
        await smartReply(event, "請在群組或聊天室使用", sender);
        return;
      }
      await smartReply(event, buildDictList(id), sender);
      return;
    }

    if (isOwner(event)) {
      if (text === "/approve") {
        if (!isGroupOrRoom(event)) {
          await smartReply(event, "請在群組或聊天室使用", sender);
          return;
        }

        approveGroup(id);
        await smartReply(event, "✅ 此群組授權成功", sender);
        return;
      }

      if (text === "/reject") {
        if (!isGroupOrRoom(event)) {
          await smartReply(event, "請在群組或聊天室使用", sender);
          return;
        }

        rejectGroup(id);
        await smartReply(event, "❌ 已拒絕此群組", sender);
        return;
      }

      if (text === "/pending") {
        ensureDBShape();

        if (!db.pending.length) {
          await smartReply(event, "沒有待授權群組", sender);
          return;
        }

        await smartReply(event, `待授權群組：\n\n${db.pending.join("\n")}`, sender);
        return;
      }

      if (text.startsWith("/approve ")) {
        const gid = text.replace("/approve ", "").trim();

        if (!gid) {
          await smartReply(event, "格式錯誤\n請使用：/approve 群組ID", sender);
          return;
        }

        approveGroup(gid);
        await smartReply(event, `✅ 已授權群組\n${gid}`, sender);
        return;
      }

      if (text.startsWith("/reject ")) {
        const gid = text.replace("/reject ", "").trim();

        if (!gid) {
          await smartReply(event, "格式錯誤\n請使用：/reject 群組ID", sender);
          return;
        }

        rejectGroup(gid);
        await smartReply(event, `❌ 已拒絕群組\n${gid}`, sender);
        return;
      }

      if (text.startsWith("/style ")) {
        if (!isGroupOrRoom(event)) {
          await smartReply(event, "請在群組或聊天室使用", sender);
          return;
        }

        const nextStyle = text.replace("/style ", "").trim();
        const allowedStyles = [
          "auto",
          "precise",
          "casual",
          "romance",
          "nightlife",
          "work",
          "feminine",
          "masculine",
        ];

        if (!allowedStyles.includes(nextStyle)) {
          await smartReply(
            event,
            "可用風格：\nauto\nprecise\ncasual\nromance\nnightlife\nwork\nfeminine\nmasculine",
            sender
          );
          return;
        }

        setStyle(id, nextStyle);
        await smartReply(event, `✅ 已切換翻譯風格：${nextStyle}`, sender);
        return;
      }

      if (text === "/langmemory on") {
        if (!isGroupOrRoom(event)) {
          await smartReply(event, "請在群組或聊天室使用", sender);
          return;
        }
        setAutoLangMemory(id, true);
        await smartReply(event, "✅ 已開啟智慧語言記憶", sender);
        return;
      }

      if (text === "/langmemory off") {
        if (!isGroupOrRoom(event)) {
          await smartReply(event, "請在群組或聊天室使用", sender);
          return;
        }
        setAutoLangMemory(id, false);
        await smartReply(event, "✅ 已關閉智慧語言記憶", sender);
        return;
      }

      if (text.startsWith("/dict add ")) {
        if (!isGroupOrRoom(event)) {
          await smartReply(event, "請在群組或聊天室使用", sender);
          return;
        }

        const raw = text.replace("/dict add ", "").trim();
        const parts = raw.split("=>");

        if (parts.length < 2) {
          await smartReply(event, "格式錯誤\n請使用：/dict add 原文 => 翻譯", sender);
          return;
        }

        const source = parts[0].trim();
        const target = parts.slice(1).join("=>").trim();

        if (!source || !target) {
          await smartReply(event, "格式錯誤\n請使用：/dict add 原文 => 翻譯", sender);
          return;
        }

        const ok = setDict(id, source, target);
        await smartReply(
          event,
          ok ? `✅ 已加入群組詞典\n${source} => ${target}` : "⚠️ 加入群組詞典失敗",
          sender
        );
        return;
      }

      if (text.startsWith("/dict del ")) {
        if (!isGroupOrRoom(event)) {
          await smartReply(event, "請在群組或聊天室使用", sender);
          return;
        }

        const source = text.replace("/dict del ", "").trim();

        if (!source) {
          await smartReply(event, "格式錯誤\n請使用：/dict del 原文", sender);
          return;
        }

        const ok = deleteDict(id, source);
        await smartReply(
          event,
          ok ? `✅ 已刪除群組詞典：${source}` : "⚠️ 找不到這筆群組詞典",
          sender
        );
        return;
      }

      if (text === "/gdict list") {
        await smartReply(event, buildGlobalDictList(), sender);
        return;
      }

      if (text.startsWith("/gdict add ")) {
        const raw = text.replace("/gdict add ", "").trim();
        const parts = raw.split("=>");

        if (parts.length < 2) {
          await smartReply(event, "格式錯誤\n請使用：/gdict add 原文 => 翻譯", sender);
          return;
        }

        const source = parts[0].trim();
        const target = parts.slice(1).join("=>").trim();

        if (!source || !target) {
          await smartReply(event, "格式錯誤\n請使用：/gdict add 原文 => 翻譯", sender);
          return;
        }

        const ok = setGlobalDict(source, target);
        await smartReply(
          event,
          ok ? `✅ 已加入全域詞典\n${source} => ${target}` : "⚠️ 加入全域詞典失敗",
          sender
        );
        return;
      }

      if (text.startsWith("/gdict del ")) {
        const source = text.replace("/gdict del ", "").trim();

        if (!source) {
          await smartReply(event, "格式錯誤\n請使用：/gdict del 原文", sender);
          return;
        }

        const ok = deleteGlobalDict(source);
        await smartReply(
          event,
          ok ? `✅ 已刪除全域詞典：${source}` : "⚠️ 找不到這筆全域詞典",
          sender
        );
        return;
      }
    }

    /* ===== 未授權 ===== */

    if (isGroupOrRoom(event) && !isAllowed(id)) {
      await smartReply(
        event,
        `⛔ 此群組尚未授權

只有 OWNER 可以啟用翻譯
若 OWNER 本人在群組內，可直接輸入：
/approve`,
        sender
      );
      return;
    }

    if (text.startsWith("/")) return;

    // 只對純地址略過，不再對一般房號/樓層指示略過
    if (looksLikeAddress(text)) {
      await smartReply(event, toTraditionalChinese(text), sender);
      return;
    }

    const normalizedText = normalizeDictKey(text);

    const groupDict = getDict(id);
    if (groupDict[normalizedText]) {
      await smartReply(event, toTraditionalChinese(groupDict[normalizedText]), sender);
      return;
    }

    const globalDict = getGlobalDict();
    if (globalDict[normalizedText]) {
      await smartReply(event, toTraditionalChinese(globalDict[normalizedText]), sender);
      return;
    }

    let lang = detectLangSmart(text, event);

    if (lang === "mixed" || isLikelyBilingualBlock(text)) {
      console.log("🔀 mixed / 雙語區塊，改為逐行翻譯");
      const mixedResult = await translateMixedLines(text, style, event);
      await smartReply(event, toTraditionalChinese(mixedResult), sender);
      return;
    }

    if (text.length <= 15) {
      const protectedResult = protectedPhraseTranslate(text, lang);
      if (protectedResult) {
        await smartReply(event, toTraditionalChinese(protectedResult), sender);
        if (lang === "zh" || lang === "th" || lang === "en") {
          updateUserLangHint(event, lang);
        }
        return;
      }
    }

    if (shouldUseFastTranslate(text, lang)) {
      if (lang === "th") {
        const fast = thaiFast(text);
        if (fast) {
          await smartReply(event, toTraditionalChinese(fast), sender);
          updateUserLangHint(event, lang);
          return;
        }
      }

      if (lang === "zh") {
        const fast = zhFast(text);
        if (fast) {
          await smartReply(event, toTraditionalChinese(fast), sender);
          updateUserLangHint(event, lang);
          return;
        }
      }

      if (lang === "en") {
        const fast = enFast(text);
        if (fast) {
          await smartReply(event, toTraditionalChinese(fast), sender);
          updateUserLangHint(event, lang);
          return;
        }
      }
    }

    const target = getTargetLanguage(lang);
    let result = await translate(text, target, style, event);

    // 最後一道防呆：避免原文或錯語言直接送出去
    result = forceValidFinalOutput(text, result, lang);

    if (!result) {
      result = fallbackMessage(lang);
    }

    await smartReply(event, toTraditionalChinese(result), sender);

    if (lang === "zh" || lang === "th" || lang === "en") {
      updateUserLangHint(event, lang);
    }
  } finally {
    leaveInflight(id);
  }
}

async function handleEvent(event) {
  try {
    if (!event || !event.source) return;

    if (event.type === "join") {
      await handleJoin(event);
      return;
    }

    if (event.type !== "message") return;
    if (event.message?.type !== "text") return;

    if (shouldSkipTranslateByContent(event)) return;

    await handleTextMessage(event);
  } catch (e) {
    console.error("❌ handleEvent 爆掉:", e?.message || e);

    try {
      const sender = await fetchLineProfile(event);
      await smartReply(event, "⚠️ 系統忙碌中，請再試一次", sender);
    } catch (err) {
      console.error("❌ smartReply 失敗:", err?.message || err);
    }
  }
}

/* =========================
   ROUTES
========================= */

app.get("/", (req, res) => {
  res.status(200).send("BOT OK");
});

app.get("/healthz", (req, res) => {
  res.status(200).json({
    ok: true,
    version: "5.1-smart",
    uptime: process.uptime(),
    cacheSize: translationCache.size,
    profileCacheSize: profileCache.size,
    inflightChats: inflightByChat.size,
    dbLoaded: !!db,
    ownerConfigured: !!OWNER,
  });
});

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req?.body?.events || [];
    console.log("📨 webhook 進來了，events:", events.length);

    await Promise.all(
      events.map(async (event, index) => {
        try {
          console.log(`➡️ 處理 event #${index + 1}`);
          await handleEvent(event);
        } catch (e) {
          console.error(`❌ event #${index + 1} error:`, e?.message || e);
        }
      })
    );
  } catch (e) {
    console.error("❌ webhook error:", e?.message || e);
  }

  res.sendStatus(200);
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log(`🚀 BOT v5.1 SMART RUNNING ON PORT ${PORT}`);
});
