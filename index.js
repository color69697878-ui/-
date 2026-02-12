import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

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
   白名單永久儲存
========================= */

const DB_FILE = "./allowedGroups.json";

function loadGroups() {
  if (!fs.existsSync(DB_FILE)) return [];
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveGroups(groups) {
  fs.writeFileSync(DB_FILE, JSON.stringify(groups, null, 2));
}

let allowedGroups = loadGroups();

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

function isGroupOrRoom(event) {
  return event.source.type === "group" || event.source.type === "room";
}

function isAllowed(id) {
  return allowedGroups.includes(id);
}

function addGroup(id) {
  if (!allowedGroups.includes(id)) {
    allowedGroups.push(id);
    saveGroups(allowedGroups);
  }
}

function removeGroup(id) {
  allowedGroups = allowedGroups.filter(g => g !== id);
  saveGroups(allowedGroups);
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
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: "你是翻譯引擎，只輸出翻譯" },
      { role: "user", content: `翻譯成${lang}：${text}` }
    ]
  });

  return r.choices[0].message.content.trim();
}

/* =========================
   WEBHOOK
========================= */

app.post("/webhook", line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

/* =========================
   主事件
========================= */

async function handleEvent(event) {

  /* ======================
     BOT 被加入群組
  ====================== */

  if (event.type === "join") {

    const id = getId(event);

    if (!isAllowed(id)) {

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "❌ 此群組未授權\n請群主輸入 /addgroup 授權"
      });

      if (event.source.type === "group")
        await client.leaveGroup(id);
      else
        await client.leaveRoom(id);
    }

    return;
  }

  /* ======================
     只處理文字訊息
  ====================== */

  if (event.type !== "message") return;
  if (event.message.type !== "text") return;

  const text = event.message.text.trim();
  const userId = event.source.userId;

  /* ======================
     指令優先
  ====================== */

  if (text === "/myid")
    return reply(event, "你的UserID:\n" + userId);

  if (text === "/groupid") {
    if (!isGroupOrRoom(event))
      return reply(event, "請在群組使用");
    return reply(event, "ID:\n" + getId(event));
  }

  /* ======================
     OWNER 管理
  ====================== */

  if (userId === OWNER) {

    if (text === "/addgroup") {
      if (!isGroupOrRoom(event))
        return reply(event, "請在群組使用");

      const id = getId(event);
      addGroup(id);
      return reply(event, "✅ 已授權此群組");
    }

    if (text === "/removegroup") {
      if (!isGroupOrRoom(event))
        return reply(event, "請在群組使用");

      const id = getId(event);
      removeGroup(id);
      return reply(event, "🗑 已移除授權");
    }

    if (text === "/groups") {
      if (!allowedGroups.length)
        return reply(event, "白名單為空");

      return reply(event,
        "白名單群組：\n\n" + allowedGroups.join("\n")
      );
    }
  }

  /* ======================
     群組白名單限制
  ====================== */

  if (isGroupOrRoom(event)) {

    const id = getId(event);

    if (!isAllowed(id)) {

      await reply(event, "❌ 此群組未授權");

      if (event.source.type === "group")
        await client.leaveGroup(id);
      else
        await client.leaveRoom(id);

      return;
    }
  }

  /* ======================
     翻譯
  ====================== */

  const source = detectLang(text);
  const target = targetLang(source);
  const result = await translate(text, target);

  return reply(event, `原文：${text}\n翻譯：${result}`);
}

/* =========================
   啟動
========================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 BOT RUNNING ON " + PORT);
});
