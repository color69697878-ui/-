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
   資料庫
========================= */

const DB_FILE = "./groups.json";

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    return { allowed: [], pending: [] };
  }

  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (err) {
    console.error("❌ groups.json 讀取失敗，已改用空白資料:", err);
    return { allowed: [], pending: [] };
  }
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

let db = loadDB();

/* =========================
   工具
========================= */

function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text,
  });
}

function getId(event) {
  return event.source.groupId || event.source.roomId || null;
}

function isGroupOrRoom(event) {
  return event.source.type === "group" || event.source.type === "room";
}

function isAllowed(id) {
  return db.allowed.includes(id);
}

function isPending(id) {
  return db.pending.includes(id);
}

function addPending(id) {
  if (!id) return;
  if (!isPending(id)) {
    db.pending.push(id);
    saveDB();
  }
}

function approveGroup(id) {
  if (!id) return;
  db.pending = db.pending.filter((x) => x !== id);
  if (!db.allowed.includes(id)) {
    db.allowed.push(id);
  }
  saveDB();
}

function rejectGroup(id) {
  if (!id) return;
  db.pending = db.pending.filter((x) => x !== id);
  saveDB();
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
   翻譯（口語強化版）
========================= */

async function translate(text, lang) {
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

    return r.choices[0].message.content.trim();
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
       BOT 被加入群組 / 房間
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
        if (db.pending.length === 0) {
          return reply(event, "沒有待授權群組");
        }

        return reply(
          event,
          "待授權群組：\n\n" + db.pending.join("\n")
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
       不翻譯其他斜線指令
    ====================== */

    if (text.startsWith("/")) {
      return;
    }

    /* ======================
       三向翻譯
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
   Render 健康檢查
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
