import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

console.log("🚀 BOT STARTING");

const app = express();

/* =========================
   LINE 設定
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
});

/* =========================
   OWNER
========================= */

const OWNER = process.env.OWNER_USER_ID;

/* =========================
   資料庫檔案
========================= */

const GROUP_DB_FILE = "./groups.json";
const CACHE_DB_FILE = "./cache.json";

/* =========================
   讀取 JSON
========================= */

function loadJSON(file, fallback) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`❌ ${file} 讀取失敗，改用預設值:`, err);
    return fallback;
  }
}

/* =========================
   初始化資料
========================= */

let groupDB = loadJSON(GROUP_DB_FILE, {
  allowed: [],
  pending: [],
  styles: {},
  dicts: {}
});

if (!Array.isArray(groupDB.allowed)) groupDB.allowed = [];
if (!Array.isArray(groupDB.pending)) groupDB.pending = [];
if (!groupDB.styles || typeof groupDB.styles !== "object") groupDB.styles = {};
if (!groupDB.dicts || typeof groupDB.dicts !== "object") groupDB.dicts = {};

let cacheDB = loadJSON(CACHE_DB_FILE, {});

/* =========================
   延遲批次寫檔
========================= */

const dirtyFlags = {
  groupDB: false,
  cacheDB: false,
};

let flushTimer = null;
const FLUSH_DELAY_MS = 2000;

function scheduleFlush() {
  if (flushTimer) return;

  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDirtyFiles();
  }, FLUSH_DELAY_MS);
}

function flushDirtyFiles() {
  try {
    if (dirtyFlags.groupDB) {
      fs.writeFileSync(GROUP_DB_FILE, JSON.stringify(groupDB, null, 2), "utf8");
      dirtyFlags.groupDB = false;
      console.log("💾 groups.json 已寫入");
    }

    if (dirtyFlags.cacheDB) {
      compactCacheIfNeeded();
      fs.writeFileSync(CACHE_DB_FILE, JSON.stringify(cacheDB, null, 2), "utf8");
      dirtyFlags.cacheDB = false;
      console.log("💾 cache.json 已寫入");
    }
  } catch (err) {
    console.error("❌ flushDirtyFiles 失敗:", err);
  }
}

function markGroupDBDirty() {
  dirtyFlags.groupDB = true;
  scheduleFlush();
}

function markCacheDBDirty() {
  dirtyFlags.cacheDB = true;
  scheduleFlush();
}

process.on("SIGINT", () => {
  console.log("🛑 SIGINT received, flushing data...");
  flushDirtyFiles();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, flushing data...");
  flushDirtyFiles();
  process.exit(0);
});

/* =========================
   群組授權資料
========================= */

function isAllowed(id) {
  return groupDB.allowed.includes(id);
}

function ensureGroupDefaults(id) {
  if (!id) return;
  if (!groupDB.styles[id]) groupDB.styles[id] = "auto";
  if (!groupDB.dicts[id] || typeof groupDB.dicts[id] !== "object") {
    groupDB.dicts[id] = {};
  }
}

function addPending(id) {
  if (!id) return;
  if (!groupDB.pending.includes(id)) {
    groupDB.pending.push(id);
    markGroupDBDirty();
  }
}

function approveGroup(id) {
  if (!id) return;

  groupDB.pending = groupDB.pending.filter(x => x !== id);

  if (!groupDB.allowed.includes(id)) {
    groupDB.allowed.push(id);
  }

  ensureGroupDefaults(id);
  markGroupDBDirty();
}

function rejectGroup(id) {
  if (!id) return;
  groupDB.pending = groupDB.pending.filter(x => x !== id);
  markGroupDBDirty();
}

function getStyle(id) {
  if (!id) return "auto";
  return groupDB.styles?.[id] || "auto";
}

function setStyle(id, style) {
  if (!id) return;
  ensureGroupDefaults(id);
  groupDB.styles[id] = style;
  markGroupDBDirty();
}

/* =========================
   每群自訂詞典
========================= */

function getGroupDict(id) {
  if (!id) return {};
  ensureGroupDefaults(id);
  return groupDB.dicts[id] || {};
}

function setGroupDictEntry(id, sourceText, targetText) {
  if (!id || !sourceText || !targetText) return;
  ensureGroupDefaults(id);
  groupDB.dicts[id][sourceText.trim()] = targetText.trim();
  markGroupDBDirty();
}

function deleteGroupDictEntry(id, sourceText) {
  if (!id || !sourceText) return false;
  ensureGroupDefaults(id);

  const key = sourceText.trim();
  if (!(key in groupDB.dicts[id])) return false;

  delete groupDB.dicts[id][key];
  markGroupDBDirty();
  return true;
}

function findCustomDictTranslation(id, text) {
  if (!id || !text) return "";
  const dict = getGroupDict(id);
  return dict[text.trim()] || "";
}

function buildDictListText(id) {
  const dict = getGroupDict(id);
  const entries = Object.entries(dict);

  if (!entries.length) {
    return "目前此群組沒有自訂詞典";
  }

  const lines = entries
    .slice(0, 100)
    .map(([src, dst], i) => `${i + 1}. ${src} => ${dst}`);

  return `此群組自訂詞典：\n\n${lines.join("\n")}`;
}

/* =========================
   翻譯快取
========================= */

const MAX_CACHE_ITEMS = 5000;

function getCacheKey(text, lang, style) {
  return `${style}|||${lang}|||${text}`;
}

function getCachedTranslation(text, lang, style) {
  const key = getCacheKey(text, lang, style);
  const item = cacheDB[key];
  if (!item) return null;

  if (typeof item === "string") {
    return item;
  }

  item.lastAccess = Date.now();
  return item.result || null;
}

function setCachedTranslation(text, lang, style, result) {
  const key = getCacheKey(text, lang, style);
  cacheDB[key] = {
    result,
    updatedAt: Date.now(),
    lastAccess: Date.now(),
  };
  markCacheDBDirty();
}

function compactCacheIfNeeded() {
  const entries = Object.entries(cacheDB);
  if (entries.length <= MAX_CACHE_ITEMS) return;

  entries.sort((a, b) => {
    const aTime =
      typeof a[1] === "string" ? 0 : (a[1].lastAccess || a[1].updatedAt || 0);
    const bTime =
      typeof b[1] === "string" ? 0 : (b[1].lastAccess || b[1].updatedAt || 0);
    return bTime - aTime;
  });

  cacheDB = Object.fromEntries(entries.slice(0, MAX_CACHE_ITEMS));
  console.log("🧹 cache 已縮減為", MAX_CACHE_ITEMS, "筆");
}

/* =========================
   對話上下文記憶
========================= */

const recentMessages = new Map();
const MAX_RECENT_PER_CHAT = 10;

function getConversationKey(event) {
  if (event.source.type === "group") return `group:${event.source.groupId}`;
  if (event.source.type === "room") return `room:${event.source.roomId}`;
  if (event.source.type === "user") return `user:${event.source.userId}`;
  return "unknown";
}

function pushRecentMessage(event, text) {
  const key = getConversationKey(event);
  const arr = recentMessages.get(key) || [];

  arr.push({
    text,
    userId: event.source.userId || null,
    ts: Date.now(),
  });

  if (arr.length > MAX_RECENT_PER_CHAT) {
    arr.shift();
  }

  recentMessages.set(key, arr);
}

function getRecentMessages(event, limit = 3) {
  const key = getConversationKey(event);
  const arr = recentMessages.get(key) || [];
  return arr.slice(-limit);
}

function getBestPreviousText(event) {
  if (event.message?.quotedMessage?.text) {
    return event.message.quotedMessage.text.trim();
  }

  const recent = getRecentMessages(event, 3);
  if (recent.length === 0) return "";

  return recent[recent.length - 1]?.text?.trim() || "";
}

function buildRecentContextText(event, limit = 3) {
  const recent = getRecentMessages(event, limit);
  if (!recent.length) return "";

  return recent
    .map((msg, index) => `前文${index + 1}：${msg.text}`)
    .join("\n");
}

/* =========================
   防重複回覆（修正版）
========================= */

const processedEventKeys = new Map();
const DEDUPE_TTL_MS = 2 * 60 * 1000;

function cleanupProcessedKeys() {
  const now = Date.now();
  for (const [key, ts] of processedEventKeys.entries()) {
    if (now - ts > DEDUPE_TTL_MS) {
      processedEventKeys.delete(key);
    }
  }
}

function collectPossibleEventKeys(event) {
  const keys = [];

  if (event.message?.id) keys.push(`mid:${event.message.id}`);
  if (event.webhookEventId) keys.push(`wid:${event.webhookEventId}`);

  return keys;
}

function isRecentlyProcessed(event) {
  cleanupProcessedKeys();

  const keys = collectPossibleEventKeys(event);
  if (!keys.length) return false;

  return keys.some(key => processedEventKeys.has(key));
}

function markEventProcessed(event) {
  const now = Date.now();
  const keys = collectPossibleEventKeys(event);

  for (const key of keys) {
    processedEventKeys.set(key, now);
  }
}

/* =========================
   Sender Profile 快取
========================= */

const profileCache = new Map();
const PROFILE_TTL = 60 * 60 * 1000;

function getProfileCacheKey(event) {
  const userId = event.source.userId;
  if (!userId) return null;
  return `${event.source.type}:${userId}:${event.source.groupId || ""}:${event.source.roomId || ""}`;
}

function extractErrorDetail(err) {
  return (
    err?.originalError?.response?.data ||
    err?.response?.data ||
    err?.message ||
    err
  );
}

async function getSenderProfile(event) {
  try {
    const userId = event.source.userId;
    if (!userId) return null;

    const cacheKey = getProfileCacheKey(event);
    if (cacheKey) {
      const cached = profileCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < PROFILE_TTL) {
        return cached.profile;
      }
    }

    let profile = null;

    if (event.source.type === "user") {
      profile = await client.getProfile(userId);
    } else if (event.source.type === "group") {
      profile = await client.getGroupMemberProfile(event.source.groupId, userId);
    } else if (event.source.type === "room") {
      profile = await client.getRoomMemberProfile(event.source.roomId, userId);
    }

    if (cacheKey && profile) {
      profileCache.set(cacheKey, {
        profile,
        ts: Date.now(),
      });
    }

    return profile;
  } catch (err) {
    console.error("⚠️ 取得 sender profile 失敗:", extractErrorDetail(err));
    return null;
  }
}

/* =========================
   工具
========================= */

function getId(event) {
  return event.source.groupId || event.source.roomId || null;
}

function isGroupOrRoom(event) {
  return event.source.type === "group" || event.source.type === "room";
}

function sanitizeSenderName(name = "") {
  return name
    .replace(/[\p{Extended_Pictographic}]/gu, "")
    .replace(/[\u200B-\u200D\uFE0F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);
}

function buildSender(profile) {
  if (!profile || !profile.displayName) return undefined;

  const safeName = sanitizeSenderName(profile.displayName);
  if (!safeName) return undefined;

  const sender = {
    name: safeName
  };

  if (profile.pictureUrl && /^https:\/\//.test(profile.pictureUrl)) {
    sender.iconUrl = profile.pictureUrl;
  }

  return sender;
}

async function reply(event, text, senderProfile = null) {
  const message = {
    type: "text",
    text
  };

  try {
    const sender = buildSender(senderProfile);

    if (sender?.name) {
      message.sender = sender;
    }

    await client.replyMessage(event.replyToken, message);
    return true;
  } catch (err) {
    console.error("⚠️ 帶 sender 回覆失敗，改用純文字重送:", extractErrorDetail(err));

    try {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text
      });
      return true;
    } catch (err2) {
      console.error("❌ 純文字回覆也失敗:", extractErrorDetail(err2));
      return false;
    }
  }
}

async function safeReplyAndMark(event, text, senderProfile = null, originalTextForContext = null) {
  const ok = await reply(event, text, senderProfile);

  if (ok) {
    if (originalTextForContext) {
      pushRecentMessage(event, originalTextForContext);
    }
    markEventProcessed(event);
  }

  return ok;
}

/* =========================
   智慧聊天過濾器
========================= */

function shouldIgnoreMessage(text) {
  const t = text.trim();
  if (!t) return true;

  const hasLettersOrNumbers = /[\p{L}\p{N}]/u.test(t);
  if (!hasLettersOrNumbers) return true;

  const lower = t.toLowerCase();

  const ignoreList = new Set([
    "ok", "okay", "k", "kk", "okok",
    "lol", "lmao", "haha", "hah", "555", "5555",
    "hmm", "um", "umm", "uh", "uhh",
    "hi", "hello", "yo",
    "哈哈", "呵呵",
    "โอเค", "อืม", "อือ", "อ่า", "เออ"
  ]);

  if (ignoreList.has(lower)) return true;
  if (ignoreList.has(t)) return true;

  return false;
}

/* =========================
   判斷是否像正常可翻譯句子
========================= */

function looksLikeTranslatableText(text) {
  const t = text.trim();
  if (!t) return false;

  const hasChinese = /[\u4E00-\u9FFF]/.test(t);
  const hasThai = /[\u0E00-\u0E7F]/.test(t);
  const hasEnglish = /[a-zA-Z]/.test(t);
  const hasDigits = /\d/.test(t);

  if (/^[\d\s/._\-:+]+$/.test(t)) return false;
  if (/^[a-zA-Z]{1,3}\d{1,4}$/i.test(t)) return false;

  if (hasChinese) return true;
  if (hasThai) return true;

  if (hasEnglish) {
    const lower = t.toLowerCase();
    const words = lower.match(/[a-zA-Z]+/g) || [];

    const weakEnglishWords = new Set([
      "in", "on", "at", "to", "of", "for", "by", "up", "as", "an", "a", "the"
    ]);

    if (words.length === 1 && weakEnglishWords.has(lower)) {
      return false;
    }

    if (hasDigits && t.length <= 12) return false;

    return true;
  }

  return false;
}

/* =========================
   數字 / 代碼前綴抽取
========================= */

function extractLeadingCode(text) {
  const t = text.trim();

  const match = t.match(/^([A-Za-z0-9][A-Za-z0-9/_\-.:]*)(\s+)(.+)$/);

  if (!match) {
    return { code: "", body: t };
  }

  const [, code, , body] = match;

  const looksLikeCode =
    /\d/.test(code) ||
    /[\/_.:-]/.test(code) ||
    /^[A-Za-z]{1,3}\d{1,4}$/i.test(code);

  if (!looksLikeCode) {
    return { code: "", body: t };
  }

  return { code, body: body.trim() };
}

/* =========================
   語言判斷（改善版）
========================= */

function detectLang(text) {
  const zhMatches = text.match(/[\u4E00-\u9FFF]/g) || [];
  const thMatches = text.match(/[\u0E00-\u0E7F]/g) || [];
  const enMatches = text.match(/[a-zA-Z]/g) || [];

  const zh = zhMatches.length;
  const th = thMatches.length;
  const en = enMatches.length;

  if (zh === 0 && th === 0 && en === 0) return "en";

  if (th >= zh && th >= en) return "th";
  if (zh >= th && zh >= en) return "zh";
  return "en";
}

function targetLang(source) {
  if (source === "zh") return "泰文";
  if (source === "th") return "繁體中文";
  return "繁體中文和泰文";
}

/* =========================
   中文短詞快翻
========================= */

function translateChineseChatWord(text) {
  const t = text.trim();

  const dict = {
    "嗯": "อืม",
    "恩": "อืม",
    "喔": "อ๋อ",
    "哦": "อ๋อ",
    "嗯嗯": "อืม",
    "可以": "ได้",
    "去": "ไป",
    "來": "มา"
  };

  return dict[t] || "";
}

/* =========================
   上下文判斷
========================= */

function isSleepQuestion(text) {
  const t = text.trim();
  const patterns = [
    /沒睡/,
    /有没有睡/,
    /有沒有睡/,
    /睡了嗎/,
    /昨晚.*睡/,
    /เมื่อคืน.*นอน/,
    /ได้นอน/,
    /ยังไม่นอน/,
    /นอนหรือ/,
    /นอนไหม/
  ];
  return patterns.some((re) => re.test(t));
}

function isConfirmationQuestion(text) {
  const t = text.trim();
  const patterns = [
    /對嗎/,
    /是嗎/,
    /是不是/,
    /有沒有/,
    /有嗎/,
    /對吧/,
    /ใช่ไหม/,
    /หรือเปล่า/,
    /รึเปล่า/,
    /ไหม$/,
    /มั้ย$/
  ];
  return patterns.some((re) => re.test(t));
}

function isPermissionOrAcceptanceQuestion(text) {
  const t = text.trim();
  const patterns = [
    /可以嗎/,
    /可不可以/,
    /行嗎/,
    /好嗎/,
    /方便嗎/,
    /ได้ไหม/,
    /โอเคไหม/
  ];
  return patterns.some((re) => re.test(t));
}

function isGoComeQuestion(text) {
  const t = text.trim();
  const patterns = [
    /要去嗎/,
    /要來嗎/,
    /會去嗎/,
    /會來嗎/,
    /ไปไหม/,
    /มาไหม/,
    /จะไปไหม/,
    /จะมาไหม/
  ];
  return patterns.some((re) => re.test(t));
}

/* =========================
   泰文聊天短詞 + 動作語境快翻
========================= */

function translateThaiChatWord(text, previousText = "") {
  const t = text.trim();
  const prev = previousText.trim();

  if (["นอน", "นอนค่ะ", "นอนครับ"].includes(t) && isSleepQuestion(prev)) {
    return "有睡";
  }

  if (["ค่ะ", "คะ", "ครับ"].includes(t)) {
    if (isConfirmationQuestion(prev)) return "對";
    if (isPermissionOrAcceptanceQuestion(prev)) return "可以";
    return "";
  }

  if (["ใช่ค่ะ", "ใช่ครับ", "ใช่"].includes(t)) {
    return "對";
  }

  if (["ยัง", "ยังค่ะ", "ยังครับ", "ยังไม่"].includes(t)) {
    return "還沒";
  }

  if (["ได้", "ได้ค่ะ", "ได้ครับ"].includes(t)) {
    if (isPermissionOrAcceptanceQuestion(prev)) return "可以";
    return "可以";
  }

  if (["ไปค่ะ", "ไปครับ"].includes(t)) {
    if (isGoComeQuestion(prev)) return "會去";
    return "去";
  }

  if (["มาค่ะ", "มาครับ"].includes(t)) {
    if (isGoComeQuestion(prev)) return "會來";
    return "來";
  }

  const directDict = {
    "ไม่": "不",
    "มา": "來",
    "ไป": "去",
    "โอเค": "好",

    "มาแล้ว": "來了",
    "ไปแล้ว": "去了",
    "กลับแล้ว": "回去了",
    "ออกแล้ว": "出去了",
    "ออกไปแล้ว": "離開了",
    "ออกมาแล้ว": "出來了",

    "ไปดิ": "去啊",
    "มาดิ": "來啊",
    "ไปก่อน": "先走了",
    "มาก่อน": "先來了",
    "ไปไหน": "要去哪",
    "มาไหม": "要來嗎",
    "ไปไหม": "要去嗎",
    "ไม่ไป": "不去",
    "ไม่มา": "不來",

    "นอน": "睡",
    "นอนค่ะ": "睡了",
    "นอนครับ": "睡了"
  };

  if (directDict[t]) return directDict[t];

  const actionMap = {
    "กลับค่ะ": "會回去",
    "กลับครับ": "會回去",
    "ไม่ค่ะ": "不要",
    "ไม่ครับ": "不要",
    "ไปนะ": "我去喔",
    "มานะ": "我來喔"
  };

  return actionMap[t] || "";
}

/* =========================
   英文短詞快翻
========================= */

function translateEnglishChatWord(text) {
  const t = text.trim().toLowerCase();

  const ignoreWords = new Set([
    "in", "on", "at", "to", "of", "for", "by", "a", "an", "the"
  ]);

  if (ignoreWords.has(t)) return "__IGNORE__";

  const dict = {
    "yes": "對\nใช่",
    "no": "不要\nไม่",
    "black": "黑色\nสีดำ",
    "white": "白色\nสีขาว",
    "up": "上去\nขึ้นไป",
    "down": "下去\nลงไป",
    "come": "來\nมา",
    "go": "去\nไป",
    "ok": "好\nโอเค"
  };

  return dict[t] || "";
}

/* =========================
   清理中文多餘語助詞
========================= */

function cleanupChineseTone(text) {
  return text
    .replace(/^好啦$/g, "好")
    .replace(/^可以啦$/g, "可以")
    .replace(/^對啦$/g, "對")
    .replace(/^會去啦$/g, "會去")
    .replace(/^會來啦$/g, "會來")
    .replace(/^去啦$/g, "去")
    .replace(/^來啦$/g, "來")
    .replace(/^還沒啦$/g, "還沒")
    .replace(/^不要啦$/g, "不要")
    .replace(/^是啦$/g, "是");
}

/* =========================
   風格提示詞
========================= */

function buildStyleInstructions(style) {
  const common = `
你是頂級中英泰聊天翻譯專家，尤其擅長把中文翻成超自然泰文，以及把泰文翻成超自然中文。你也擅長修正聊天中的拼字錯誤、漏字、簡寫、口語寫法，再進行翻譯。

硬規則：
1. 只輸出翻譯結果
2. 不要解釋
3. 不要加原文
4. 不要加前言或結尾
5. 不要混用語言
6. 每一行只能是一種語言
7. 中文只能用中文
8. 泰文只能用泰文
9. 英文只能用英文
10. 如果要輸出兩種語言，請一行一種語言
11. 嚴禁在泰文句子中混入中文
12. 嚴禁在中文句子中混入泰文

翻譯原則：
13. 不要逐字直譯
14. 要根據上下文重組語序
15. 要像母語者自然聊天
16. 保留原本情緒與語氣
17. 中文優先用台灣日常聊天說法
18. 泰文優先用泰國人日常聊天說法
19. 英文優先用自然簡單口語
20. 口語化不能改變原意
21. 如果自然口語和原意衝突，優先保留原意
22. 必須做語境理解，不要只看單字
23. 模糊詞、方向詞、狀態詞要依整句上下文判斷
24. 中文翻譯請避免無故添加「啦、呀、呢、喔、哦」等語助詞
25. 只有原文明顯帶有撒嬌、強烈口語、催促或特定情緒時，才可少量加入語助詞
26. 若原文只是普通回答、普通陳述、普通同意，請用乾淨自然的中文，不要自行加「啦」

拼字修正與語意理解規則：
27. 如果原文有明顯錯字、漏字、簡寫、打錯字、聊天式亂打，先自動理解最可能的原意，再翻譯
28. 不要把明顯錯字照抄進翻譯
29. 例如泰文像「ฉันย่านร้าน」這種不自然寫法，要先推測最可能原意，例如「ฉันอยู่ร้าน」，再翻譯
30. 如果英文有小拼字錯誤，例如 customer / custumer / costumer，要根據上下文理解後再翻譯
31. 中文若有少字、錯字，也要先理解語意再翻譯

中文 → 泰文 特別要求：
32. 必須像泰國人真的在 LINE 聊天
33. 優先使用自然短句
34. 避免教科書語氣
35. 避免過度正式
36. 可省略不必要主詞，只要意思清楚自然

泰文 → 中文 特別要求：
37. 不要保留泰文語序
38. 必須先理解意思，再翻成自然中文
39. 中文要像台灣人聊天，不要出現怪句

泰文動作語境規則：
40. 對於泰文中的動作與方向詞，必須依上下文理解：
    - ไป / มา / กลับ
    - ออก / ออกไป / ออกมา
    - ขึ้น / ลง
    - ส่ง / รับ
41. 不可固定翻法，必須看整句語境與對話脈絡判斷
42. 「ไป」單獨作回答時通常是「去」
43. 「ไปค่ะ / ไปครับ」作回答時通常是「會去」
44. 「ไปดิ」通常是「去啊」
45. 「ไปไหน」通常是「要去哪」
46. 「มา」單獨作回答時通常是「來」
47. 「มาค่ะ / มาครับ」作回答時通常是「會來」
48. 「มาดิ」通常是「來啊」
49. 「มาไหม」通常是「要來嗎」
50. 「กลับ」依上下文可為「回去 / 回來」
51. 「ออกไป」通常偏向「出去 / 離開」
52. 「ออกมา」通常偏向「出來」
53. 如果原意是離開、走掉、出去，就不得翻成「出來」
54. 如果原意是出現、到場、出來見人、出來上班，才可翻成「出來 / 到場 / 來了」

泰文聊天短詞規則：
55. 泰文單獨回覆的短詞要依聊天語境翻譯：
    - ยัง → 還沒
    - ค่ะ / คะ / ครับ → 對 / 是 / 好 / 可以
    - ใช่ → 對
    - ได้ → 可以
56. 如果「ยัง」是單獨回答問題，優先翻成「還沒」，不是「還是」
57. 如果「ค่ะ / ครับ」是在回答確認句、是非題、對嗎這類問題，優先翻成「對」或「是」
58. 如果「ค่ะ / ครับ」是在回答可不可以、行不行、好不好這類問題，優先翻成「可以」或「好」
59. 如果「นอน / นอนค่ะ / นอนครับ」是在回答「有沒有睡」這類問題，優先翻成「有睡 / 睡了」，不是「要睡了」
60. 這些短詞若單獨出現，也要翻譯，不可以省略；但若無足夠上下文，請選擇最保守自然的翻法

細膩語意規則：
61. 如果句子是感情句或抽象句，優先理解整體情感與關係，再翻譯
62. 如果句子像「แต่ฉันอยู่ห่างจากคุณได้ไม่นาน ฉันรู้ตัวฉันดี」
    必須優先理解為「沒辦法離你太久」這種關係語意，
    不可草率翻成「我離你不遠」

數字與代碼保留規則：
63. 原文中的所有數字、編號、代碼、斜線格式、時間格式都必須完整保留
64. 例如 2030/60/1/2700 必須原樣保留
65. 不可刪除、不可改寫、不可省略
66. 如果原文是「代碼 + 句子」，翻譯時要保留代碼，再翻譯後面的句子
67. 不可以因為口語化而省略數字或代碼

輸出格式規則：
68. 如果要求翻成「繁體中文和泰文」，第一行繁體中文，第二行泰文
69. 如果要求翻成「泰文」，只輸出泰文
70. 如果要求翻成「繁體中文」，只輸出繁體中文
`;

  const styles = {
    auto: `
風格模式：自動
請根據內容自動判斷要用哪種語氣：
- 日常聊天 → 口語自然
- 感情聊天 → 柔和自然
- 夜生活 → 懂場景但不浮誇
- 工作內容 → 清楚自然略正式
- 容易有歧義或語意細膩的句子 → 優先保留原意
`,
    precise: `
風格模式：精準
請以原意優先。
可以自然，但不可以為了順口而改變語意。
遇到感情句、抽象句、容易誤解的句子時，優先選擇最貼近原意的翻法。
`,
    casual: `
風格模式：日常聊天
請翻得像朋友在 LINE 上聊天，簡單、自然、口語。
但仍然不可偏離原意。
`,
    romance: `
風格模式：感情聊天
請保留曖昧、撒嬌、委屈、生氣、冷淡等情緒。
語氣自然柔和，但仍要保留原意。
`,
    nightlife: `
風格模式：夜生活
請使用夜生活、酒吧、陪酒、交際場合常見的自然聊天語氣，
但不能因場景而亂改方向詞意思。
`,
    work: `
風格模式：工作正式
請清楚、禮貌、自然，不要太隨便，也不要過度書面。
`,
    feminine: `
風格模式：女生聊天
語氣柔和、自然、日常，不要太做作。
`,
    masculine: `
風格模式：男生聊天
語氣自然、直接、口語，不要太彆扭。
`
  };

  return common + "\n" + (styles[style] || styles.auto);
}

/* =========================
   翻譯引擎
========================= */

async function translate(text, lang, style = "auto", contextText = "") {
  const shouldUseCache = text.trim().length >= 5;

  if (shouldUseCache) {
    const cached = getCachedTranslation(text, lang, style);
    if (cached) {
      console.log("⚡ 使用快取翻譯:", text);
      return cached;
    }
  }

  try {
    const contextBlock = contextText
      ? `以下是最近對話上下文，僅供理解語意，不要輸出這些內容：\n${contextText}\n\n`
      : "";

    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: style === "precise" ? 0.1 : 0.25,
      messages: [
        {
          role: "system",
          content: buildStyleInstructions(style)
        },
        {
          role: "user",
          content: `${contextBlock}請把下面這句翻譯成${lang}，用自然聊天口語：${text}`
        }
      ]
    });

    let result = r.choices?.[0]?.message?.content?.trim() || "";

    if (!result) return "";

    result = cleanupChineseTone(result);

    if (shouldUseCache) {
      setCachedTranslation(text, lang, style, result);
    }

    return result;
  } catch (err) {
    console.error("❌ OPENAI ERROR:", extractErrorDetail(err));
    return "";
  }
}

/* =========================
   WEBHOOK
========================= */

app.post("/webhook", line.middleware(config), async (req, res) => {
  console.log("📩 webhook event received");

  try {
    await Promise.all(req.body.events.map(handleEvent));
  } catch (err) {
    console.error("❌ WEBHOOK ERROR:", extractErrorDetail(err));
  }

  res.sendStatus(200);
});

/* =========================
   主事件處理
========================= */

async function handleEvent(event) {
  try {
    if (event.type === "join") {
      const id = getId(event);

      if (!isAllowed(id)) {
        addPending(id);
        await safeReplyAndMark(
          event,
          `🔐 此群組尚未授權

請管理員輸入：

/approve`
        );
        return;
      }

      ensureGroupDefaults(id);
      await safeReplyAndMark(event, "✅ 此群組已授權");
      return;
    }

    if (event.type !== "message") return;
    if (event.message.type !== "text") return;

    const text = event.message.text.trim();
    const userId = event.source.userId;
    const id = getId(event);

    console.log("📨 message:", text);

    if (!text) return;

    if (isRecentlyProcessed(event)) {
      console.log("♻️ 偵測到重複事件，略過:", text);
      return;
    }

    /* 指令優先 */

    if (text === "/myid") {
      await safeReplyAndMark(event, userId || "查不到 userId");
      return;
    }

    if (text === "/groupid") {
      await safeReplyAndMark(event, id || "這不是群組或聊天室");
      return;
    }

    if (text === "/mystyle") {
      if (!isGroupOrRoom(event)) {
        await safeReplyAndMark(event, "請在群組或聊天室使用");
        return;
      }
      await safeReplyAndMark(event, `目前翻譯風格：${getStyle(id)}`);
      return;
    }

    if (text === "/dict list") {
      if (!isGroupOrRoom(event)) {
        await safeReplyAndMark(event, "請在群組或聊天室使用");
        return;
      }
      await safeReplyAndMark(event, buildDictListText(id));
      return;
    }

    /* OWNER 管理指令 */

    if (userId === OWNER) {
      if (text === "/pending") {
        if (groupDB.pending.length === 0) {
          await safeReplyAndMark(event, "沒有待授權群組");
          return;
        }

        await safeReplyAndMark(
          event,
          "待授權群組：\n\n" + groupDB.pending.join("\n")
        );
        return;
      }

      if (text === "/approve") {
        if (!isGroupOrRoom(event)) {
          await safeReplyAndMark(event, "請在群組或聊天室使用");
          return;
        }

        approveGroup(id);
        await safeReplyAndMark(event, "✅ 群組授權成功");
        return;
      }

      if (text === "/reject") {
        if (!isGroupOrRoom(event)) {
          await safeReplyAndMark(event, "請在群組或聊天室使用");
          return;
        }

        rejectGroup(id);

        const ok = await safeReplyAndMark(event, "❌ 已拒絕並退出");
        if (ok) {
          if (event.source.type === "group") {
            await client.leaveGroup(id);
          } else if (event.source.type === "room") {
            await client.leaveRoom(id);
          }
        }
        return;
      }

      if (text.startsWith("/style ")) {
        if (!isGroupOrRoom(event)) {
          await safeReplyAndMark(event, "請在群組或聊天室使用");
          return;
        }

        const style = text.replace("/style ", "").trim();
        const allowedStyles = [
          "auto",
          "precise",
          "casual",
          "romance",
          "nightlife",
          "work",
          "feminine",
          "masculine"
        ];

        if (!allowedStyles.includes(style)) {
          await safeReplyAndMark(
            event,
            "可用風格：\nauto\nprecise\ncasual\nromance\nnightlife\nwork\nfeminine\nmasculine"
          );
          return;
        }

        setStyle(id, style);
        await safeReplyAndMark(event, `✅ 已切換翻譯風格：${style}`);
        return;
      }

      if (text.startsWith("/dict add ")) {
        if (!isGroupOrRoom(event)) {
          await safeReplyAndMark(event, "請在群組或聊天室使用");
          return;
        }

        const raw = text.replace("/dict add ", "").trim();
        const parts = raw.split("=>");

        if (parts.length < 2) {
          await safeReplyAndMark(event, "格式錯誤\n\n請使用：\n/dict add 原文 => 翻譯");
          return;
        }

        const sourceText = parts[0].trim();
        const targetText = parts.slice(1).join("=>").trim();

        if (!sourceText || !targetText) {
          await safeReplyAndMark(event, "格式錯誤\n\n請使用：\n/dict add 原文 => 翻譯");
          return;
        }

        setGroupDictEntry(id, sourceText, targetText);
        await safeReplyAndMark(event, `✅ 已加入自訂詞典\n${sourceText} => ${targetText}`);
        return;
      }

      if (text.startsWith("/dict del ")) {
        if (!isGroupOrRoom(event)) {
          await safeReplyAndMark(event, "請在群組或聊天室使用");
          return;
        }

        const sourceText = text.replace("/dict del ", "").trim();

        if (!sourceText) {
          await safeReplyAndMark(event, "格式錯誤\n\n請使用：\n/dict del 原文");
          return;
        }

        const deleted = deleteGroupDictEntry(id, sourceText);

        if (!deleted) {
          await safeReplyAndMark(event, "⚠️ 找不到這筆自訂詞典");
          return;
        }

        await safeReplyAndMark(event, `✅ 已刪除自訂詞典：${sourceText}`);
        return;
      }
    }

    /* 未授權群組限制 */

    if (isGroupOrRoom(event) && !isAllowed(id)) {
      await safeReplyAndMark(event, "⛔ 此群組尚未授權");
      return;
    }

    if (isGroupOrRoom(event)) {
      ensureGroupDefaults(id);
    }

    /* 其他斜線指令不翻譯、不回應 */

    if (text.startsWith("/")) {
      return;
    }

    /* 智慧聊天過濾器 */

    if (shouldIgnoreMessage(text)) {
      console.log("🙈 忽略無意義訊息:", text);
      pushRecentMessage(event, text);
      return;
    }

    /* 不像正常句子就安靜 */

    if (!looksLikeTranslatableText(text)) {
      console.log("🙈 看起來不像正常句子，略過:", text);
      pushRecentMessage(event, text);
      return;
    }

    /* 抽取前綴代碼 */

    const { code, body } = extractLeadingCode(text);

    if (!body || !looksLikeTranslatableText(body)) {
      console.log("🙈 代碼後沒有可翻譯句子，略過:", text);
      pushRecentMessage(event, text);
      return;
    }

    const previousText = getBestPreviousText(event);
    const contextText = buildRecentContextText(event, 3);
    const bodySource = detectLang(body);

    /* 群組自訂詞典優先 */

    if (isGroupOrRoom(event)) {
      const customDictHit = findCustomDictTranslation(id, body);
      if (customDictHit) {
        const senderProfile = await getSenderProfile(event);
        const finalCustomResult = code ? `${code} ${customDictHit}` : customDictHit;
        await safeReplyAndMark(event, finalCustomResult, senderProfile, text);
        return;
      }
    }

    /* 中文短詞快翻 */

    if (bodySource === "zh") {
      const fastZhWord = translateChineseChatWord(body);

      if (fastZhWord) {
        const senderProfile = await getSenderProfile(event);
        const finalFastResult = code ? `${code} ${fastZhWord}` : fastZhWord;
        await safeReplyAndMark(event, finalFastResult, senderProfile, text);
        return;
      }
    }

    /* 泰文聊天短詞 / 動作短句快翻 */

    if (bodySource === "th") {
      const fastThaiWord = translateThaiChatWord(body, previousText);

      if (fastThaiWord) {
        const senderProfile = await getSenderProfile(event);
        const finalFastResult = code ? `${code} ${fastThaiWord}` : fastThaiWord;
        await safeReplyAndMark(event, finalFastResult, senderProfile, text);
        return;
      }
    }

    /* 英文短詞快翻 */

    if (bodySource === "en") {
      const fastEnWord = translateEnglishChatWord(body);

      if (fastEnWord === "__IGNORE__") {
        pushRecentMessage(event, text);
        return;
      }

      if (fastEnWord) {
        const senderProfile = await getSenderProfile(event);
        const finalFastResult = code
          ? fastEnWord.split("\n").map(line => `${code} ${line}`).join("\n")
          : fastEnWord;

        await safeReplyAndMark(event, finalFastResult, senderProfile, text);
        return;
      }
    }

    /* 智慧翻譯 */

    const source = detectLang(body);
    const target = targetLang(source);
    const style = isGroupOrRoom(event) ? getStyle(id) : "auto";

    const translatedBody = await translate(body, target, style, contextText);

    if (!translatedBody || !translatedBody.trim()) {
      console.log("🙈 無翻譯結果，略過回覆:", text);
      pushRecentMessage(event, text);
      return;
    }

    const finalResult = code
      ? translatedBody
          .split("\n")
          .map(line => `${code} ${line.trim()}`)
          .join("\n")
      : translatedBody;

    const senderProfile = await getSenderProfile(event);

    await safeReplyAndMark(event, finalResult, senderProfile, text);
  } catch (err) {
    console.error("❌ HANDLE EVENT ERROR:", extractErrorDetail(err));
    return;
  }
}

/* =========================
   健康檢查
========================= */

app.get("/", (req, res) => {
  res.send("BOT OK");
});

/* =========================
   啟動
========================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 BOT RUNNING ON PORT", PORT);
});
