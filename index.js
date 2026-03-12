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
   讀寫工具
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

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

/* =========================
   群組授權資料
========================= */

let groupDB = loadJSON(GROUP_DB_FILE, {
  allowed: [],
  pending: []
});

function isAllowed(id) {
  return groupDB.allowed.includes(id);
}

function isPending(id) {
  return groupDB.pending.includes(id);
}

function addPending(id) {
  if (!id) return;
  if (!groupDB.pending.includes(id)) {
    groupDB.pending.push(id);
    saveJSON(GROUP_DB_FILE, groupDB);
  }
}

function approveGroup(id) {
  if (!id) return;
  groupDB.pending = groupDB.pending.filter(x => x !== id);
  if (!groupDB.allowed.includes(id)) {
    groupDB.allowed.push(id);
  }
  saveJSON(GROUP_DB_FILE, groupDB);
}

function rejectGroup(id) {
  if (!id) return;
  groupDB.pending = groupDB.pending.filter(x => x !== id);
  saveJSON(GROUP_DB_FILE, groupDB);
}

/* =========================
   翻譯快取資料
========================= */

let cacheDB = loadJSON(CACHE_DB_FILE, {});

function getCacheKey(text, lang) {
  return `${lang}|||${text}`;
}

function getCachedTranslation(text, lang) {
  const key = getCacheKey(text, lang);
  return cacheDB[key] || null;
}

function setCachedTranslation(text, lang, result) {
  const key = getCacheKey(text, lang);
  cacheDB[key] = result;
  saveJSON(CACHE_DB_FILE, cacheDB);
}

/* =========================
   工具
========================= */

function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text
  });
}

function getId(event) {
  return event.source.groupId || event.source.roomId || null;
}

function isGroupOrRoom(event) {
  return event.source.type === "group" || event.source.type === "room";
}

/* =========================
   忽略無意義訊息
   例如：?, ??, !, ..., 😂, ❤️, ？？？
========================= */

function shouldIgnoreMessage(text) {
  const t = text.trim();

  if (!t) return true;

  // 只要有任何「文字或數字」就不忽略
  const hasMeaningfulChars = /[\p{L}\p{N}]/u.test(t);

  // 沒有文字數字，代表只有符號 / 表情 / 標點
  return !hasMeaningfulChars;
}

/* =========================
   語言判斷
========================= */

function detectLang(text) {
  if (/[\u0E00-\u0E7F]/.test(text)) return "th"; // 泰文
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh"; // 中文
  return "en"; // 其他視為英文
}

function targetLang(source) {
  if (source === "zh") return "英文和泰文";
  if (source === "en") return "繁體中文和泰文";
  if (source === "th") return "繁體中文和英文";
  return "繁體中文";
}

/* =========================
   翻譯（口語強化 + 快取）
========================= */

async function translate(text, lang) {
  const cached = getCachedTranslation(text, lang);
  if (cached) {
    console.log("⚡ 使用快取翻譯:", text);
    return cached;
  }

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `
你是頂級中英泰翻譯員，專門翻譯 LINE / Messenger / 日常聊天內容。

翻譯規則：
1. 只輸出翻譯結果
2. 不要解釋
3. 不要加原文
4. 不要加前言或結尾
5. 優先使用母語人士日常會說的自然口語
6. 不要過度書面化
7. 不要逐字直譯，要保留原意並讓對方容易懂
8. 如果翻成泰文，請優先使用泰國人聊天常用說法
9. 如果原文語氣很強烈、生氣、撒嬌、冷淡，要保留那個語氣
10. 若有模糊空間，優先選擇自然、好懂、像真人的翻法
11. 如果要輸出兩種語言，請分成兩行，一行一種語言
12. 不要自稱 AI，不要提知識截止時間，不要回答翻譯以外的內容
`
        },
        {
          role: "user",
          content: `請把下面這句翻譯成${lang}，用自然口語：${text}`
        }
      ]
    });

    const result = r.choices[0].message.content.trim();

    setCachedTranslation(text, lang, result);

    return result;
  } catch (err) {
    console.error("❌ OPENAI ERROR:", err);
    return "⚠️ 翻譯服務暫時異常";
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
    console.error("❌ WEBHOOK ERROR:", err);
  }

  res.sendStatus(200);
});

/* =========================
   主事件處理
========================= */

async function handleEvent(event) {
  try {
    /* ======================
       BOT 被加入群組 / 聊天室
    ====================== */
    if (event.type === "join") {
      const id = getId(event);

      if (!isAllowed(id)) {
        addPending(id);

        return reply(
          event,
          `🔐 此群組尚未授權

請管理員輸入：

/approve`
        );
      }

      return reply(event, "✅ 此群組已授權");
    }

    /* ======================
       非文字訊息忽略
    ====================== */
    if (event.type !== "message") return;
    if (event.message.type !== "text") return;

    const text = event.message.text.trim();
    const userId = event.source.userId;
    const id = getId(event);

    console.log("📨 message:", text);

    /* ======================
       先忽略純符號 / 表情 / 問號
    ====================== */
    if (shouldIgnoreMessage(text)) {
      console.log("🙈 忽略無意義訊息:", text);
      return;
    }

    /* ======================
       指令優先
    ====================== */

    if (text === "/myid") {
      return reply(event, userId || "查不到 userId");
    }

    if (text === "/groupid") {
      return reply(event, id || "這不是群組或聊天室");
    }

    /* ======================
       OWNER 管理指令
    ====================== */

    if (userId === OWNER) {
      if (text === "/pending") {
        if (groupDB.pending.length === 0) {
          return reply(event, "沒有待授權群組");
        }

        return reply(
          event,
          "待授權群組：\n\n" + groupDB.pending.join("\n")
        );
      }

      if (text === "/approve") {
        if (!isGroupOrRoom(event)) {
          return reply(event, "請在群組或聊天室使用");
        }

        approveGroup(id);
        return reply(event, "✅ 群組授權成功");
      }

      if (text === "/reject") {
        if (!isGroupOrRoom(event)) {
          return reply(event, "請在群組或聊天室使用");
        }

        rejectGroup(id);

        await reply(event, "❌ 已拒絕並退出");

        if (event.source.type === "group") {
          await client.leaveGroup(id);
        } else if (event.source.type === "room") {
          await client.leaveRoom(id);
        }

        return;
      }
    }

    /* ======================
       未授權群組限制
    ====================== */

    if (isGroupOrRoom(event) && !isAllowed(id)) {
      return reply(event, "⛔ 此群組尚未授權");
    }

    /* ======================
       其他斜線指令不翻譯
    ====================== */

    if (text.startsWith("/")) {
      return;
    }

    /* ======================
       三向口語翻譯
    ====================== */

    const source = detectLang(text);
    const target = targetLang(source);
    const result = await translate(text, target);

    return reply(event, result);

  } catch (err) {
    console.error("❌ HANDLE EVENT ERROR:", err);

    if (event.replyToken) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "⚠️ 系統暫時異常"
      });
    }
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
