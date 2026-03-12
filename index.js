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
   智慧聊天過濾器
========================= */

function shouldIgnoreMessage(text) {
  const t = text.trim();

  if (!t) return true;

  // 只有符號 / 標點 / emoji
  const hasLettersOrNumbers = /[\p{L}\p{N}]/u.test(t);
  if (!hasLettersOrNumbers) return true;

  // 常見無意義短回覆
  const lower = t.toLowerCase();

  const ignoreList = new Set([
    "ok", "okay", "k", "kk", "okok",
    "yes", "yeah", "yep", "no", "nope",
    "lol", "lmao", "haha", "hah", "555", "5555",
    "hmm", "um", "umm", "uh", "uhh",
    "hi", "hello", "yo",
    "恩", "嗯", "喔", "哦", "好", "嗯嗯", "哈哈", "呵呵",
    "好喔", "好哦", "恩恩", "收到",
    "โอเค", "อืม", "อือ", "อ่า", "เออ", "ใช่", "จ้า", "ครับ", "ค่ะ"
  ]);

  if (ignoreList.has(lower)) return true;
  if (ignoreList.has(t)) return true;

  // 單個字或極短且沒什麼資訊
  if (t.length <= 1) return true;

  return false;
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
   聊天模式翻譯
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
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: `
你是中英泰聊天翻譯員。

翻譯規則：
1. 只輸出翻譯結果
2. 不要解釋
3. 不要顯示原文
4. 使用 LINE / Messenger 聊天語氣
5. 優先使用口語
6. 不要書面語
7. 可以簡短
8. 保留原本情緒
9. 泰文要像泰國人聊天
10. 中文要像平常聊天
11. 英文要自然，不要太教科書
12. 如果輸出兩種語言，請分成兩行
13. 不要回答問題，不要自稱 AI，不要提知識截止時間
`
        },
        {
          role: "user",
          content: `翻譯成${lang}：${text}`
        }
      ]
    });

    const result = r.choices[0].message.content.trim();
    setCachedTranslation(text, lang, result);
    return result;

  } catch (err) {
    console.error("❌ OPENAI ERROR:", err);
    return "⚠️ 翻譯暫時不可用";
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
       智慧聊天過濾器
    ====================== */

    if (shouldIgnoreMessage(text)) {
      console.log("🙈 忽略無意義訊息:", text);
      return;
    }

    /* ======================
       聊天模式三向翻譯
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
