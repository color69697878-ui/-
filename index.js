import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";
import { Converter } from "opencc-js";

dotenv.config();

console.log("🚀 LINE BOT START v5.1.2");

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
  timeout: 18000,
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
    dicts: {},
    globalDict: {},
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
    if (!parsed.dicts || typeof parsed.dicts !== "object") parsed.dicts = {};
    if (!parsed.globalDict || typeof parsed.globalDict !== "object") parsed.globalDict = {};

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

function ensureDBShape(id = "") {
  if (!db || typeof db !== "object") db = createDefaultDB();
  if (!Array.isArray(db.allowed)) db.allowed = [];
  if (!Array.isArray(db.pending)) db.pending = [];
  if (!db.dicts || typeof db.dicts !== "object") db.dicts = {};
  if (!db.globalDict || typeof db.globalDict !== "object") db.globalDict = {};

  if (id) {
    if (!db.dicts[id] || typeof db.dicts[id] !== "object") {
      db.dicts[id] = {};
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

/* =========================
   CONTEXT MEMORY
========================= */

const chatContextMap = new Map();
const MAX_CONTEXT_MESSAGES = 3;
const CONTEXT_TTL = 1000 * 60 * 30;

/* =========================
   TIME / CACHE HELPERS
========================= */

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

function getChatContext(chatId) {
  const item = chatContextMap.get(chatId);
  if (!item) return [];
  if (now() - item.ts > CONTEXT_TTL) {
    chatContextMap.delete(chatId);
    return [];
  }
  return Array.isArray(item.value) ? item.value : [];
}

function pushChatContext(chatId, text) {
  if (!chatId || !text) return;
  const current = getChatContext(chatId);
  const next = [...current, String(text).trim()].slice(-MAX_CONTEXT_MESSAGES);
  chatContextMap.set(chatId, { value: next, ts: now() });
}

function buildContextText(chatId, currentText) {
  const items = getChatContext(chatId).filter(Boolean);
  if (!items.length) return "";

  const filtered = items.filter((x) => x.trim() !== String(currentText || "").trim());
  if (!filtered.length) return "";

  return filtered
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((x, i) => `${i + 1}. ${x}`)
    .join("\n");
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

function safeText(text = "") {
  return String(text || "").replace(/\0/g, "").slice(0, 5000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeDictKey(text = "") {
  return String(text || "").trim();
}

function escapeRegExp(text = "") {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* =========================
   AUTH
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

function clearGlobalDict() {
  ensureDBShape();
  db.globalDict = {};
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

function normalizeForDict(text = "") {
  return String(text || "")
    .trim()
    .replace(/[?？!！。．~～]+$/g, "")
    .replace(/\s+/g, " ");
}

function getMergedDict(chatId = "") {
  return {
    ...getGlobalDict(),
    ...getDict(chatId),
  };
}

function getExactDictHit(text = "", chatId = "") {
  const source = normalizeForDict(text);
  if (!source) return "";

  const merged = getMergedDict(chatId);

  for (const [k, v] of Object.entries(merged)) {
    if (normalizeForDict(k) === source) {
      return String(v || "").trim();
    }
  }

  return "";
}

function applyDictionaryAfterTranslate(text = "", chatId = "") {
  let out = String(text || "");
  const merged = getMergedDict(chatId);
  const entries = Object.entries(merged).sort((a, b) => b[0].length - a[0].length);

  for (const [src, dst] of entries) {
    if (!src || !dst) continue;
    out = out.replace(new RegExp(escapeRegExp(src), "g"), dst);
  }

  return out;
}

/* =========================
   LANGUAGE
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

function detectLang(text = "") {
  const hasTh = hasThai(text);
  const hasZh = hasChinese(text);
  const hasEn = hasEnglish(text);

  if (hasTh && hasZh) return "mixed";
  if (hasTh && !hasZh) return "th";
  if (hasZh && !hasTh) return "zh";
  if (!hasTh && !hasZh && hasEn) return "en";
  return "unknown";
}

function getTargetLanguage(lang) {
  if (lang === "zh") return "泰文";
  if (lang === "th") return "繁體中文";
  if (lang === "en") return "繁體中文";
  return "繁體中文";
}

/* =========================
   SKIP / CLEAN
========================= */

function shouldSkipStickerOrNonText(event) {
  const type = event?.message?.type || "";
  return type !== "text";
}

function isEmojiOrPunctuationOnly(text = "") {
  const t = String(text || "").trim();
  if (!t) return true;

  return /^[\p{Emoji}\p{Extended_Pictographic}\p{Emoji_Presentation}\s~`!@#$%^&*()_\-+=[\]{}\\|;:'",.<>/?，。！？、；：（）【】《》「」『』…—><]+$/u.test(
    t
  );
}

function shouldSkipTranslateToken(text = "") {
  const t = String(text || "").trim().toUpperCase();
  return /^(?:\d+\s*)?(IN|OUT)(?:\s*\d+)?$/.test(t);
}

function cleanTextForTranslate(text = "") {
  return String(text || "")
    .replace(/@\S+/g, " ")
    .replace(/#[^\s#]+/g, " ")
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function shouldIgnoreText(text = "") {
  const t = String(text || "").trim();
  if (!t) return true;
  if (isEmojiOrPunctuationOnly(t)) return true;
  if (/^[A-Z0-9_\- ]{1,20}$/.test(t)) return true;
  if (/^[0-9]+$/.test(t)) return true;
  if (t.length <= 1) return true;
  return false;
}

function shouldSkipTranslateByContent(event) {
  if (shouldSkipStickerOrNonText(event)) return true;

  const originalText = String(event?.message?.text || "").trim();
  if (!originalText) return true;

  const cleaned = cleanTextForTranslate(originalText);

  if (!cleaned) return true;
  if (shouldIgnoreText(cleaned)) return true;
  if (shouldSkipTranslateToken(cleaned)) return true;

  return false;
}

/* =========================
   GLOBAL PROTECT
========================= */

const NO_TRANSLATE_WORDS = [
  "IN",
  "OUT",
  "MAN CLUB",
];

const NO_TRANSLATE_REGEX = [
  /@\w+/g,
  /#\w+/g,
  /https?:\/\/[^\s]+/gi,
  /\bt\.me\/[^\s]+/gi,
  /\bwww\.[^\s]+/gi,
  /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/g,
  /\b\d{1,2}[:：]\d{2}\b/g,
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
  /\b\d+\b/g,
];

function protectKeywords(text = "") {
  let result = String(text || "");
  const placeholders = [];
  let i = 0;

  const addPlaceholder = (match) => {
    const key = `__PROTECT_${i++}__`;
    placeholders.push({ key, value: match });
    return key;
  };

  for (const reg of NO_TRANSLATE_REGEX) {
    result = result.replace(reg, (m) => addPlaceholder(m));
  }

  for (const word of NO_TRANSLATE_WORDS) {
    const reg = new RegExp(`\\b${escapeRegExp(word)}\\b`, "gi");
    result = result.replace(reg, (m) => addPlaceholder(m));
  }

  return { text: result, placeholders };
}

function restoreKeywords(text = "", placeholders = []) {
  let result = String(text || "");

  for (const p of placeholders) {
    result = result.replace(new RegExp(escapeRegExp(p.key), "g"), p.value);
  }

  return result;
}

/* =========================
   QUALITY CHECK
========================= */

function containsChinese(text = "") {
  return /[\u4E00-\u9FFF]/.test(String(text || ""));
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
    "ไม่": "不",
    "ไป": "去",
    "มา": "來",
    "โอเค": "好",
    "โอเคค่ะ": "好",
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
    "可以": "ได้",
    "去": "ไป",
    "來": "มา",
    "来": "มา",
    "對": "ใช่",
    "对": "ใช่",
    "好": "โอเค",
    "好的": "โอเค",
  };
  return dict[t] || "";
}

function enFast(text) {
  const t = text.trim().toLowerCase();
  const dict = {
    "ok": "好",
    "okay": "好",
    "yes": "是",
    "no": "不是",
  };
  return dict[t] || "";
}

function shouldUseFastTranslate(text = "", lang = "unknown") {
  const t = String(text || "").trim();

  if (!t) return false;
  if (t.length <= 4) return true;
  if (lang === "zh" && /^[\u4E00-\u9FFF]{1,4}$/.test(t)) return true;
  if (lang === "th" && /^[\u0E00-\u0E7F]{1,8}$/.test(t)) return true;
  if (lang === "en" && /^[a-zA-Z\s]{1,12}$/.test(t)) return true;

  return false;
}

/* =========================
   SENTENCE SPLIT
========================= */

function splitChineseSentence(text = "") {
  const normalized = String(text || "")
    .replace(/([!！?？。．,，、])/g, " $1 ")
    .replace(/(然後|再來|接著|現在|之後)/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isOnlyPunctuationPart(text = "") {
  return /^[!！?？。．,，、]+$/.test(String(text || "").trim());
}

function isConnectorPart(text = "") {
  return /^(然後|再來|接著|現在|之後)$/.test(String(text || "").trim());
}

/* =========================
   TRANSLATE CORE
========================= */

function isTranslationValid(sourceText = "", translatedText = "") {
  const src = String(sourceText || "").trim();
  const out = String(translatedText || "").trim();

  if (!out) return false;
  if (src === out) return false;
  return true;
}

function buildPrompt() {
  return `
你是中泰即時聊天翻譯器。

規則：
1. 只輸出翻譯結果
2. 不要解釋
3. 不要加前言
4. 必須完整翻譯整句或短句
5. 不要只翻一部分
6. 除了專有名詞、地名、人名、品牌名、網址、數字外，不可保留原文中文
7. 如果原文是中文，請完整翻成自然泰文
8. 如果原文是泰文，請完整翻成繁體中文
9. 主詞必須忠於原文
10. 我 = ฉัน
11. 你 = คุณ
12. 他 = เขา
13. 她 = เขา
14. 我們 = พวกเรา
15. 你們 = พวกคุณ
16. 他們 = พวกเขา
17. 保留原意，不要過度意譯
18. 不要把中文句子只翻前面幾個字
`.trim();
}

async function translateText(text, target, chatId = "") {
  const source = safeText(text).trim();
  if (!source) return "";

  const contextText = buildContextText(chatId, source);
  const cacheKey = `${target}__${source}__${contextText}`;
  const cached = getCachedTranslation(cacheKey);
  if (cached) return cached;

  for (let i = 0; i < 2; i++) {
    try {
      const messages = [
        {
          role: "system",
          content: buildPrompt(),
        },
      ];

      if (contextText) {
        messages.push({
          role: "user",
          content: `這是最近對話，只供你理解代名詞與上下文，不需要翻譯：\n${contextText}`,
        });
      }

      messages.push({
        role: "user",
        content: `請翻譯成${target}：\n${source}`,
      });

      const result = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages,
      });

      let out = result?.choices?.[0]?.message?.content?.trim() || "";
      out = toTraditionalChinese(out);

      if (isTranslationValid(source, out)) {
        setCachedTranslation(cacheKey, out);
        return out;
      }
    } catch (e) {
      console.error(`❌ OpenAI 翻譯失敗 第 ${i + 1} 次:`, e?.message || e);
      if (i < 1) await sleep(700);
    }
  }

  return "";
}

async function translateChineseByParts(text, chatId = "") {
  const parts = splitChineseSentence(text);
  if (!parts.length) return "";

  const out = [];

  for (const part of parts) {
    if (!part.trim()) continue;

    if (isOnlyPunctuationPart(part)) {
      out.push(part);
      continue;
    }

    let sourcePart = part;

    if (isConnectorPart(part)) {
      sourcePart = `這是中文連接詞，請翻成自然泰文：\n${part}`;
    } else {
      sourcePart = `這是純中文短句，請完整翻成自然泰文，不可保留中文：\n${part}`;
    }

    const translated = await translateText(sourcePart, "泰文", chatId);

    if (!translated || containsChinese(translated)) {
      console.log("⚠️ 分段翻譯失敗:", part, "=>", translated);
      return "";
    }

    out.push(translated);
  }

  return out.join(" ").replace(/\s+/g, " ").trim();
}

/* =========================
   REPLY
========================= */

async function safeReply(event, text) {
  try {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: toTraditionalChinese(safeText(text)),
    });
    return true;
  } catch (e) {
    console.error("❌ reply 失敗:", e?.message || e);
    return false;
  }
}

async function safePush(event, text) {
  try {
    const to = getPushTarget(event);
    if (!to) return false;

    await client.pushMessage(to, {
      type: "text",
      text: toTraditionalChinese(safeText(text)),
    });
    return true;
  } catch (e) {
    console.error("❌ push 失敗:", e?.message || e);
    return false;
  }
}

async function smartReply(event, text) {
  const ok = await safeReply(event, text);
  if (ok) return true;
  return safePush(event, text);
}

/* =========================
   COMMANDS
========================= */

async function handleCommand(event, text, chatId) {
  const lower = text.toLowerCase().trim();

  if (lower === "/help") {
    return smartReply(
      event,
      [
        "可用指令：",
        "/help",
        "/approve",
        "/reject",
        "/pending",
        "/dict list",
        "/dict add 中文=泰文",
        "/dict del 中文",
        "/gdict list",
        "/gdict add 中文=泰文",
        "/gdict del 中文",
        "/gdict clear",
      ].join("\n")
    );
  }

  if (lower === "/approve") {
    if (!isOwner(event)) return smartReply(event, "只有 OWNER 可以授權");
    if (!isGroupOrRoom(event)) return smartReply(event, "此指令只能在群組或聊天室使用");

    const ok = approveGroup(chatId);
    return smartReply(event, ok ? "✅ 此群組已授權，可開始自動翻譯" : "授權失敗");
  }

  if (lower === "/reject") {
    if (!isOwner(event)) return smartReply(event, "只有 OWNER 可以拒絕");
    if (!isGroupOrRoom(event)) return smartReply(event, "此指令只能在群組或聊天室使用");

    const ok = rejectGroup(chatId);
    return smartReply(event, ok ? "已從待授權清單移除" : "處理失敗");
  }

  if (lower === "/pending") {
    if (!isOwner(event)) return smartReply(event, "只有 OWNER 可以查看待授權清單");

    ensureDBShape();
    if (!db.pending.length) return smartReply(event, "目前沒有待授權群組");
    return smartReply(event, `待授權群組：\n${db.pending.join("\n")}`);
  }

  if (text.toLowerCase().trim() === "/dict list") {
    return smartReply(event, buildDictList(chatId));
  }

  if (/^\/dict\s+add\s+/i.test(text)) {
    const raw = text.replace(/^\/dict\s+add\s+/i, "").trim();
    const idx = raw.indexOf("=");
    if (idx === -1) return smartReply(event, "格式錯誤，請用：/dict add 中文=泰文");

    const source = raw.slice(0, idx).trim();
    const target = raw.slice(idx + 1).trim();

    const ok = setDict(chatId, source, target);
    return smartReply(event, ok ? `已加入群組詞典：${source} => ${target}` : "加入失敗");
  }

  if (/^\/dict\s+del\s+/i.test(text)) {
    const source = text.replace(/^\/dict\s+del\s+/i, "").trim();
    const ok = deleteDict(chatId, source);
    return smartReply(event, ok ? `已刪除群組詞典：${source}` : "找不到此詞");
  }

  if (text.toLowerCase().trim() === "/gdict list") {
    if (!isOwner(event)) return smartReply(event, "只有 OWNER 可使用全域詞典指令");
    return smartReply(event, buildGlobalDictList());
  }

  if (/^\/gdict\s+add\s+/i.test(text)) {
    if (!isOwner(event)) return smartReply(event, "只有 OWNER 可使用全域詞典指令");

    const raw = text.replace(/^\/gdict\s+add\s+/i, "").trim();
    const idx = raw.indexOf("=");
    if (idx === -1) return smartReply(event, "格式錯誤，請用：/gdict add 中文=泰文");

    const source = raw.slice(0, idx).trim();
    const target = raw.slice(idx + 1).trim();

    const ok = setGlobalDict(source, target);
    return smartReply(event, ok ? `已加入全域詞典：${source} => ${target}` : "加入失敗");
  }

  if (/^\/gdict\s+del\s+/i.test(text)) {
    if (!isOwner(event)) return smartReply(event, "只有 OWNER 可使用全域詞典指令");

    const source = text.replace(/^\/gdict\s+del\s+/i, "").trim();
    const ok = deleteGlobalDict(source);
    return smartReply(event, ok ? `已刪除全域詞典：${source}` : "找不到此詞");
  }

  if (lower === "/gdict clear") {
    if (!isOwner(event)) return smartReply(event, "只有 OWNER 可使用全域詞典指令");
    clearGlobalDict();
    return smartReply(event, "✅ 已清空全域詞典");
  }

  return false;
}

/* =========================
   MAIN LOGIC
========================= */

async function handleTextMessage(event) {
  const chatId = safeGetId(event);
  const originalText = String(event?.message?.text || "").trim();

  if (!originalText) return;

  if (originalText.startsWith("/")) {
    await handleCommand(event, originalText, chatId);
    return;
  }

  if (shouldSkipTranslateByContent(event)) {
    console.log("⏭️ 略過翻譯：貼圖 / 非文字 / 純表情 / 純符號 / 無需翻譯內容");
    return;
  }

  if (isGroupOrRoom(event) && !isAllowed(chatId)) {
    addPending(chatId);

    if (isOwner(event)) {
      await smartReply(
        event,
        "此群組尚未授權。\n你是 OWNER，可直接輸入 /approve 啟用翻譯。"
      );
    }
    return;
  }

  const text = cleanTextForTranslate(originalText);

  if (!text) {
    console.log("⏭️ 清理後沒有可翻譯內容");
    return;
  }

  const dictHit = getExactDictHit(text, chatId);
  if (dictHit) {
    console.log("📘 命中詞典，直接回覆");
    pushChatContext(chatId, text);
    await smartReply(event, dictHit);
    return;
  }

  if (isDuplicateMessage(chatId, text)) {
    console.log("⏭️ 略過重複訊息");
    return;
  }

  if (!enterInflight(chatId)) {
    await smartReply(event, "⚠️ 系統忙碌中，請稍後再試");
    return;
  }

  try {
    const lang = detectLang(text);

    if (lang === "unknown") return;

    if (lang === "mixed") {
      console.log("⏭️ 中泰混雜訊息，為避免亂翻直接略過");
      pushChatContext(chatId, text);
      return;
    }

    let translated = "";

    if (shouldUseFastTranslate(text, lang)) {
      if (lang === "zh") translated = zhFast(text);
      else if (lang === "th") translated = thaiFast(text);
      else if (lang === "en") translated = enFast(text);
    }

    if (!translated) {
      const target = getTargetLanguage(lang);
      const { text: protectedText, placeholders } = protectKeywords(text);

      if (lang === "zh") {
        translated = await translateChineseByParts(protectedText, chatId);
        translated = restoreKeywords(translated, placeholders);

        if (!translated || containsChinese(translated)) {
          console.log("⚠️ 中文分段翻譯後仍失敗，跳過");
          pushChatContext(chatId, text);
          return;
        }
      } else {
        translated = await translateText(protectedText, target, chatId);
        translated = restoreKeywords(translated, placeholders);
      }
    }

    if (!translated || translated.trim() === text.trim()) {
      console.log("⚠️ 無有效翻譯，跳過");
      pushChatContext(chatId, text);
      return;
    }

    if (lang === "zh" && containsChinese(translated)) {
      console.log("⚠️ 中文翻泰文後仍殘留中文，視為失敗");
      pushChatContext(chatId, text);
      return;
    }

    translated = applyDictionaryAfterTranslate(translated, chatId);

    if (!translated || translated.trim() === text.trim()) {
      console.log("⚠️ 套用詞典後仍無有效翻譯，跳過");
      pushChatContext(chatId, text);
      return;
    }

    if (lang === "zh" && containsChinese(translated)) {
      console.log("⚠️ 套用詞典後又出現中文，視為失敗");
      pushChatContext(chatId, text);
      return;
    }

    pushChatContext(chatId, text);
    await smartReply(event, translated);
  } catch (e) {
    console.error("❌ handleTextMessage error:", e?.message || e);
    await smartReply(event, "⚠️ 系統忙碌中，請再試一次");
  } finally {
    leaveInflight(chatId);
  }
}

async function handleEvent(event) {
  try {
    if (!event) return;

    if (event.type === "join") {
      const chatId = safeGetId(event);
      addPending(chatId);

      await smartReply(
        event,
        "嗨，我是翻譯 BOT。\n此群組目前尚未授權。\n若你是 OWNER，請輸入 /approve 啟用。"
      );
      return;
    }

    if (event.type !== "message") return;

    if (event?.message?.type === "sticker") {
      console.log("⏭️ 貼圖訊息，直接略過不翻譯");
      return;
    }

    if (event?.message?.type !== "text") {
      console.log("⏭️ 非文字訊息，直接略過不翻譯");
      return;
    }

    await handleTextMessage(event);
  } catch (e) {
    console.error("❌ handleEvent error:", e?.message || e);
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
    service: "line-translate-bot-v5.1.2",
    uptime: process.uptime(),
    cacheSize: translationCache.size,
    inflight: inflightByChat.size,
    contextChats: chatContextMap.size,
  });
});

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req?.body?.events || [];
    await Promise.all(events.map(handleEvent));
    res.json({ success: true });
  } catch (err) {
    console.error("❌ webhook error:", err?.message || err);
    res.status(500).end();
  }
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
