import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

console.log("🚀 BOT v4.6.7 START");

/* =========================
   ENV CHECK
========================= */

const REQUIRED_ENVS = [
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "OPENAI_API_KEY",
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
  timeout: 12000,
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

/* =========================
   RUNTIME CACHE
========================= */

const translationCache = new Map(); // key -> { value, ts }
const CACHE_TTL = 1000 * 60 * 10; // 10 分鐘
const CACHE_MAX = 500;

const recentMessageMap = new Map(); // key -> ts
const DEDUPE_TTL = 4000;

const inflightByChat = new Map(); // chatId -> count
const MAX_INFLIGHT_PER_CHAT = 2;

const profileCache = new Map(); // key -> { value, ts }
const PROFILE_TTL = 1000 * 60 * 60 * 12; // 12 小時
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
   工具
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

function ensureDBShape(id) {
  if (!db || typeof db !== "object") db = createDefaultDB();
  if (!Array.isArray(db.allowed)) db.allowed = [];
  if (!Array.isArray(db.pending)) db.pending = [];
  if (!db.styles || typeof db.styles !== "object") db.styles = {};
  if (!db.dicts || typeof db.dicts !== "object") db.dicts = {};
  if (!db.globalDict || typeof db.globalDict !== "object") db.globalDict = {};

  if (id) {
    if (!db.styles[id]) db.styles[id] = "auto";
    if (!db.dicts[id] || typeof db.dicts[id] !== "object") {
      db.dicts[id] = {};
    }
  }
}

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
  if (!id) return;
  ensureDBShape(id);

  db.pending = db.pending.filter(x => x !== id);
  if (!db.allowed.includes(id)) db.allowed.push(id);
  if (!db.styles[id]) db.styles[id] = "auto";

  saveDB();
}

function rejectGroup(id) {
  if (!id) return;
  ensureDBShape(id);
  db.pending = db.pending.filter(x => x !== id);
  saveDB();
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

function normalizeDictKey(text = "") {
  return String(text || "").trim();
}

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

/* ===== 全域詞典 ===== */

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeText(text) {
  return String(text || "").replace(/\0/g, "").slice(0, 5000);
}

function shouldIgnoreText(text) {
  const t = String(text || "").trim();
  if (!t) return true;

  if (/^[\p{Emoji}\p{Extended_Pictographic}\s!-/:-@[-`{-~]+$/u.test(t) && t.length <= 8) {
    return true;
  }

  return false;
}

/* =========================
   自動發話者頭像
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
   語言判斷 / 混合內容判斷
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
    .map(s => s.trim())
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

function shouldForceTranslate(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;

  if (t.length <= 6) return true;
  if (/[嗎吗呢?？]$/.test(t)) return true;

  return false;
}

/* =========================
   高風險片語保護
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
      "ขอมือถือคืน":
        "把手機還給我",
      "ขอคืน":
        "把東西還給我",
      "เอาคืน":
        "拿回來",
      "เอามือถือคืน":
        "把手機拿回來",
      "แค่ต้องการมือถือคืน":
        "我只是想把手機拿回來",

      "เธอมาถึงกี่วันแล้วคะ":
        "她來幾天了？",
      "เธอมาถึงกี่วันแล้วค่ะ":
        "她來幾天了？",
      "เธอมาถึงกี่วันแล้ว":
        "她來幾天了？",
      "เขามาถึงกี่วันแล้วคะ":
        "她來幾天了？",
      "เขามาถึงกี่วันแล้วค่ะ":
        "她來幾天了？",
      "เขามาถึงกี่วันแล้ว":
        "她來幾天了？",

      "คุณบอกเค้าแล้วหรอคะ":
        "妳跟她說了嗎？",
      "คุณบอกเค้าแล้วหรอค่ะ":
        "妳跟她說了嗎？",
      "คุณบอกเค้าแล้วหรือคะ":
        "妳跟她說了嗎？",
      "คุณบอกเขาแล้วหรอคะ":
        "妳跟她說了嗎？",
      "คุณบอกเขาแล้วหรือคะ":
        "妳跟她說了嗎？",
      "คุณบอกเค้าแล้วหรอ":
        "妳跟她說了嗎？",
      "คุณบอกเขาแล้วหรอ":
        "妳跟她說了嗎？",

      "เธอนอนหรอ":
        "她睡了嗎？",
      "เธอนอนแล้วหรอ":
        "她睡了嗎？",
      "เขานอนหรอ":
        "她睡了嗎？",
      "เขานอนแล้วหรอ":
        "她睡了嗎？",

      "เธอมาแล้วหรอ":
        "她到了嗎？",
      "เธอมาแล้วหรอคะ":
        "她到了嗎？",
      "เขามาแล้วหรอ":
        "她到了嗎？",
      "เขามาแล้วหรอคะ":
        "她到了嗎？",

      "เธออยู่ไหน":
        "她在哪裡？",
      "เขาอยู่ไหน":
        "她在哪裡？",
      "เค้าอยู่ไหน":
        "她在哪裡？",
    };

    if (thMap[t]) return thMap[t];
  }

  if (lang === "zh") {
    const zhMap = {
      "我從昨天晚上就沒跟她說話了":
        "ฉันไม่ได้คุยกับเธอตั้งแต่เมื่อคืน",
      "我從昨晚就沒跟她聯絡了":
        "ฉันไม่ได้คุยกับเธอตั้งแต่เมื่อคืน",
      "我只是想把手機拿回來":
        "แค่ต้องการเอามือถือคืน",
      "把手機還給我":
        "ขอมือถือคืน",
      "她來幾天了？":
        "เธอมาถึงกี่วันแล้วคะ",
      "妳跟她說了嗎？":
        "คุณบอกเค้าแล้วหรอคะ",
      "她睡了嗎？":
        "เธอนอนแล้วหรอ",
      "她到了嗎？":
        "เธอมาแล้วหรอ",
      "她在哪裡？":
        "เธออยู่ไหน",
    };

    if (zhMap[t]) return zhMap[t];
  }

  return "";
}

/* =========================
   快翻
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
    "剛才問你": "เมื่อกี้ฉันถามคุณ",
    "刚才问你": "เมื่อกี้ฉันถามคุณ",
    "剛才問你是不是現在": "เมื่อกี้ฉันถามคุณว่าใช่ตอนนี้ไหม",
    "刚才问你是不是现在": "เมื่อกี้ฉันถามคุณว่าใช่ตอนนี้ไหม"
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
    "just now": "剛剛"
  };

  return dict[t] || "";
}

/* =========================
   fallback
========================= */

function fallbackMessage(lang) {
  if (lang === "zh") return "稍等一下我再翻一次 🙏";
  if (lang === "th") return "ขอเวลาสักครู่ เดี๋ยวฉันแปลให้อีกครั้ง 🙏";
  return "Please wait a moment, I’ll translate it again 🙏";
}

/* =========================
   Prompt / 翻譯
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
若原文非常短，請用最自然的短句翻譯，不要擴寫。

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

async function translate(text, target, style = "auto") {
  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY 不存在");
    return null;
  }

  const cacheKey = `${style}__${target}__${text}`;
  const cached = getCachedTranslation(cacheKey);
  if (cached) {
    console.log("🧠 命中翻譯快取");
    return cached;
  }

  const maxAttempts = 2;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      console.log(`🧠 OpenAI 翻譯中，第 ${i + 1}/${maxAttempts} 次`);

      const r = await openai.chat.completions.create(
        {
          model: "gpt-4o-mini",
          temperature: 0.15,
          messages: [
            {
              role: "system",
              content: buildStyleInstruction(style),
            },
            {
              role: "user",
              content:
                `請把這句聊天訊息翻譯成${target}。` +
                `務必依聊天上下文判斷代詞：` +
                `泰文的 เธอ 可能是你，也可能是她；เขา/เค้า 可能是他，也可能是她。` +
                `如果句子是在談論第三人，不可翻成你。` +
                `務必保持主詞、受詞、對象方向正確，` +
                `不可把「我對她」翻成「她對我」，` +
                `也不可把「拿回來」亂翻成「還給我」。` +
                `只輸出翻譯結果：${text}`,
            },
          ],
        },
        {
          timeout: 10000,
          maxRetries: 0,
        }
      );

      const result = r?.choices?.[0]?.message?.content?.trim();

      if (result) {
        const clean = safeText(result);

        if (clean === text.trim() && text.trim().length <= 6) {
          const lang = detectLang(text);

          if (lang === "zh") {
            const fast = zhFast(text);
            if (fast) {
              setCachedTranslation(cacheKey, fast);
              return fast;
            }
          }

          if (lang === "th") {
            const fast = thaiFast(text);
            if (fast) {
              setCachedTranslation(cacheKey, fast);
              return fast;
            }
          }

          if (lang === "en") {
            const fast = enFast(text);
            if (fast) {
              setCachedTranslation(cacheKey, fast);
              return fast;
            }
          }
        }

        setCachedTranslation(cacheKey, clean);
        console.log("✅ OpenAI 翻譯成功");
        return clean;
      }
    } catch (e) {
      console.error(`❌ OpenAI error 第 ${i + 1} 次:`, {
        name: e?.name,
        message: e?.message,
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

async function translateMixedLines(text, style = "auto") {
  const lines = String(text)
    .split("\n")
    .map(s => s.trim());

  const out = [];

  for (const line of lines) {
    if (!line) {
      out.push("");
      continue;
    }

    const lang = detectLang(line);

    if (lang === "zh") {
      const fast = zhFast(line);
      if (fast) {
        out.push(fast);
        continue;
      }

      const protectedResult = protectedPhraseTranslate(line, lang);
      if (protectedResult) {
        out.push(protectedResult);
        continue;
      }

      const result = await translate(line, "泰文", style);
      out.push(result || line);
      continue;
    }

    if (lang === "th") {
      const fast = thaiFast(line);
      if (fast) {
        out.push(fast);
        continue;
      }

      const protectedResult = protectedPhraseTranslate(line, lang);
      if (protectedResult) {
        out.push(protectedResult);
        continue;
      }

      const result = await translate(line, "繁體中文", style);
      out.push(result || line);
      continue;
    }

    if (lang === "en") {
      const fast = enFast(line);
      if (fast) {
        out.push(fast);
        continue;
      }

      const result = await translate(line, "繁體中文", style);
      out.push(result || line);
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}

/* =========================
   LINE send
========================= */

function buildMessageObject(text, sender) {
  const message = {
    type: "text",
    text: safeText(text),
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

  const ok = await safeReply(event?.replyToken, text, sender);
  if (ok) return true;

  console.log("⚠️ reply 失敗，改用 push 補發");
  return await safePush(pushTarget, text, sender);
}

/* =========================
   指令說明
========================= */

function buildHelpText(isOwnerUser = false) {
  let msg = `可用指令：

/help
/myid
/groupid
/mystyle
/debuglang
/dict list

這版會自動依發話者切換頭像`;

  if (isOwnerUser) {
    msg += `

管理員指令：

/pending
/approve
/reject
/style auto
/style precise
/style casual
/style romance
/style nightlife
/style work
/style feminine
/style masculine
/dict add 原文 => 翻譯
/dict del 原文
/gdict list
/gdict add 原文 => 翻譯
/gdict del 原文`;
  }

  return msg;
}

/* =========================
   Event handlers
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

請管理員輸入：

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
  if (isDuplicateMessage(id, text)) return;

  if (!enterInflight(id)) {
    const busySender = await fetchLineProfile(event);
    await smartReply(event, "⚠️ 訊息較多，請稍後再試", busySender);
    return;
  }

  try {
    const sender = await fetchLineProfile(event);

    if (text === "/help") {
      await smartReply(event, buildHelpText(isOwner(event)), sender);
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

    if (text === "/debuglang") {
      const lang = detectLang(text);
      await smartReply(event, `語言判斷測試用指令本身：${lang}`, sender);
      return;
    }

    if (text.startsWith("/debuglang ")) {
      const raw = text.replace("/debuglang ", "").trim();
      const lang = detectLang(raw);
      await smartReply(event, `判斷結果：${lang}`, sender);
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
      if (text === "/pending") {
        ensureDBShape();
        if (!db.pending.length) {
          await smartReply(event, "沒有待授權群組", sender);
          return;
        }
        await smartReply(event, `待授權群組：\n\n${db.pending.join("\n")}`, sender);
        return;
      }

      if (text === "/approve") {
        if (!isGroupOrRoom(event)) {
          await smartReply(event, "請在群組或聊天室使用", sender);
          return;
        }
        approveGroup(id);
        await smartReply(event, "✅ 群組授權成功", sender);
        return;
      }

      if (text === "/reject") {
        if (!isGroupOrRoom(event)) {
          await smartReply(event, "請在群組或聊天室使用", sender);
          return;
        }

        rejectGroup(id);
        const ok = await smartReply(event, "❌ 已拒絕並退出", sender);

        if (ok) {
          try {
            if (event.source.type === "group") {
              await client.leaveGroup(id);
            } else if (event.source.type === "room") {
              await client.leaveRoom(id);
            }
          } catch (e) {
            console.error("❌ 離開群組/聊天室失敗:", e?.message || e);
          }
        }
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

    if (isGroupOrRoom(event) && !isAllowed(id)) {
      await smartReply(event, "⛔ 此群組尚未授權", sender);
      return;
    }

    if (text.startsWith("/")) return;

    const normalizedText = normalizeDictKey(text);

    // 1. 群組詞典
    const groupDict = getDict(id);
    if (groupDict[normalizedText]) {
      await smartReply(event, groupDict[normalizedText], sender);
      return;
    }

    // 2. 全域詞典
    const globalDict = getGlobalDict();
    if (globalDict[normalizedText]) {
      await smartReply(event, globalDict[normalizedText], sender);
      return;
    }

    const lang = detectLang(text);

    // mixed 或雙語區塊一律改成逐行翻譯
    if (lang === "mixed" || isLikelyBilingualBlock(text)) {
      console.log("🔀 mixed / 雙語區塊，改為逐行翻譯");
      const mixedResult = await translateMixedLines(text, style);
      await smartReply(event, mixedResult, sender);
      return;
    }

    // 3. 高風險片語保護
    const protectedResult = protectedPhraseTranslate(text, lang);
    if (protectedResult) {
      await smartReply(event, protectedResult, sender);
      return;
    }

    // 4. 快翻
    if (lang === "th") {
      const fast = thaiFast(text);
      if (fast) {
        await smartReply(event, fast, sender);
        return;
      }
    }

    if (lang === "zh") {
      const fast = zhFast(text);
      if (fast) {
        await smartReply(event, fast, sender);
        return;
      }
    }

    if (lang === "en") {
      const fast = enFast(text);
      if (fast) {
        await smartReply(event, fast, sender);
        return;
      }
    }

    // 5. OpenAI
    const target = getTargetLanguage(lang);
    let result = await translate(text, target, style);

    if (!result) {
      result = fallbackMessage(lang);
    }

    await smartReply(event, result, sender);
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
   Routes
========================= */

app.get("/", (req, res) => {
  res.status(200).send("BOT OK");
});

app.get("/healthz", (req, res) => {
  res.status(200).json({
    ok: true,
    version: "4.6.7",
    uptime: process.uptime(),
    cacheSize: translationCache.size,
    profileCacheSize: profileCache.size,
    inflightChats: inflightByChat.size,
    dbLoaded: !!db,
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
   Start
========================= */

app.listen(PORT, () => {
  console.log(`🚀 BOT v4.6.7 RUNNING ON PORT ${PORT}`);
});
