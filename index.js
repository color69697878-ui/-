import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

console.log("🚀 BOT STARTING");

const app = express();

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
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();

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
  return event.source.groupId || event.source.roomId;
}

function isGroup(event) {
  return event.source.type === "group" || event.source.type === "room";
}

function isAllowed(id) {
  return db.allowed.includes(id);
}

function addPending(id) {
  if (!db.pending.includes(id)) {
    db.pending.push(id);
    saveDB();
  }
}

function approve(id) {
  db.pending = db.pending.filter(x => x !== id);
  if (!db.allowed.includes(id)) {
    db.allowed.push(id);
  }
  saveDB();
}

function reject(id) {
  db.pending = db.pending.filter(x => x !== id);
  saveDB();
}

/* =========================
   語言偵測
========================= */

function detectLang(text) {

  if (/[\u0E00-\u0E7F]/.test(text)) return "th";
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh";

  return "en";
}

function targetLang(source) {

  if (source === "th") return "繁體中文";
  if (source === "zh") return "泰文";

  return "繁體中文";
}

/* =========================
   翻譯
========================= */

async function translate(text, lang) {

  try {

    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "你是專業翻譯引擎，只輸出翻譯結果"
        },
        {
          role: "user",
          content: `翻譯成${lang}：${text}`
        }
      ]
    });

    return r.choices[0].message.content.trim();

  } catch (err) {

    console.error("❌ OPENAI ERROR:", err);

    return "⚠️ AI翻譯服務暫時異常";
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

    console.error("❌ webhook error:", err);

  }

  res.sendStatus(200);

});

/* =========================
   主事件
========================= */

async function handleEvent(event) {

  try {

    /* BOT 加入群組 */

    if (event.type === "join") {

      const id = getId(event);

      if (!isAllowed(id)) {

        addPending(id);

        return reply(event,
`🔐 此群組尚未授權
請管理員輸入：

/approve`);
      }

      return reply(event, "✅ 此群組已授權");
    }

    /* 非訊息忽略 */

    if (event.type !== "message") return;
    if (event.message.type !== "text") return;

    const text = event.message.text.trim();
    const userId = event.source.userId;
    const id = getId(event);

    console.log("📨 message:", text);

    /* 指令優先 */

    if (text === "/myid")
      return reply(event, userId);

    if (text === "/groupid")
      return reply(event, id || "非群組");

    /* OWNER 指令 */

    if (userId === OWNER) {

      if (text === "/pending") {

        if (db.pending.length === 0)
          return reply(event, "沒有待授權群組");

        return reply(event,
          "待授權群組：\n\n" +
          db.pending.join("\n")
        );
      }

      if (text === "/approve") {

        if (!isGroup(event))
          return reply(event, "請在群組使用");

        approve(id);

        return reply(event, "✅ 群組授權成功");
      }

      if (text === "/reject") {

        if (!isGroup(event))
          return reply(event, "請在群組使用");

        reject(id);

        await reply(event, "❌ 已拒絕並退出");

        if (event.source.type === "group")
          await client.leaveGroup(id);
        else
          await client.leaveRoom(id);

        return;
      }

    }

    /* 未授權限制 */

    if (isGroup(event) && !isAllowed(id)) {

      return reply(event, "⛔ 此群組尚未授權");
    }

    /* 翻譯 */

    const source = detectLang(text);
    const target = targetLang(source);

    const result = await translate(text, target);

    return reply(event,
`原文：${text}
翻譯：${result}`);

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
