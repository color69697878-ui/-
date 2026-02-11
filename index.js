require("dotenv").config();

const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");

const app = express();

/* =========================
   LINE
========================= */

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);

/* =========================
   OpenAI
========================= */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* =========================
   白名單
========================= */

const OWNER = process.env.OWNER_USER_ID;

let allowedGroups = process.env.ALLOWED_GROUPS
  ? process.env.ALLOWED_GROUPS.split(",").filter(Boolean)
  : [];

function saveGroups() {
  process.env.ALLOWED_GROUPS = allowedGroups.join(",");
}

/* =========================
   Webhook
========================= */

app.post("/webhook", line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

/* =========================
   主事件
========================= */

async function handleEvent(event) {

  /* ===== 被加入群組 ===== */

  if (event.type === "join") {

    const id = event.source.groupId || event.source.roomId;

    if (!allowedGroups.includes(id)) {

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "❌ 此群組未授權"
      });

      if (event.source.type === "group")
        await client.leaveGroup(id);
      else
        await client.leaveRoom(id);
    }

    return;
  }

  /* ===== 只處理文字 ===== */

  if (event.type !== "message") return;
  if (event.message.type !== "text") return;

  const text = event.message.text;

  /* ===== 指令優先 ===== */

  if (text === "/myid")
    return reply(event, "你的UserID:\n" + event.source.userId);

  if (text === "/groupid") {
    if (event.source.type === "group")
      return reply(event, "群組ID:\n" + event.source.groupId);
    else
      return reply(event, "請在群組使用");
  }

  /* ===== 白名單檢查 ===== */

  if (event.source.type === "group" || event.source.type === "room") {

    const id = event.source.groupId || event.source.roomId;

    if (!allowedGroups.includes(id))
      return; // 直接無視（已授權才可用）
  }

  /* ===== 管理指令 ===== */

  if (event.source.userId === OWNER) {

    if (text === "/addgroup") {

      const id = event.source.groupId || event.source.roomId;

      if (!allowedGroups.includes(id)) {
        allowedGroups.push(id);
        saveGroups();
      }

      return reply(event, "✅ 已授權");
    }

    if (text === "/removegroup") {

      const id = event.source.groupId || event.source.roomId;

      allowedGroups = allowedGroups.filter(g => g !== id);
      saveGroups();

      return reply(event, "🗑 已移除");
    }

    if (text === "/groups")
      return reply(event, "白名單數量：" + allowedGroups.length);
  }

  /* ===== 翻譯 ===== */

  const result = await translate(text, "繁體中文");
  return reply(event, result);
}

/* =========================
   翻譯
========================= */

async function translate(text, lang) {

  const r = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    messages: [
      { role: "system", content: "你是翻譯引擎，只輸出翻譯" },
      { role: "user", content: `翻譯成${lang}：${text}` }
    ]
  });

  return r.choices[0].message.content.trim();
}

/* =========================
   reply
========================= */

function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text
  });
}

/* =========================
   start
========================= */

app.listen(process.env.PORT || 3000);
