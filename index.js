/* =====================================================
   ENTERPRISE LINE TRANSLATION BOT
   Features:
   ✔ Command priority
   ✔ /myid works
   ✔ Auto leave unauthorized group/room
   ✔ Owner bypass
   ✔ Admin system
   ✔ Authorization codes
   ✔ Persistent whitelist (file storage)
   ✔ Join gate message
   ✔ Group + Room support
   ✔ Safe translation (no command translation)
   ✔ ESM compatible (Render ready)
===================================================== */

import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

/* =====================================================
   BASIC SETUP
===================================================== */

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const OWNER = process.env.OWNER_USER_ID;

/* =====================================================
   DATA STORAGE (PERSISTENT)
===================================================== */

const dataDir = "./data";
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const GROUP_FILE = path.join(dataDir, "groups.json");
const ADMIN_FILE = path.join(dataDir, "admins.json");
const CODE_FILE = path.join(dataDir, "codes.json");

function load(file, def) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(def, null, 2));
    return def;
  }
  return JSON.parse(fs.readFileSync(file));
}

function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let allowedGroups = load(GROUP_FILE, []);
let admins = load(ADMIN_FILE, []);
let authCodes = load(CODE_FILE, []);

/* =====================================================
   LANGUAGE DETECT
===================================================== */

function detectLang(text) {
  if (/\p{Script=Thai}/u.test(text)) return "th";
  if (/\p{Script=Han}/u.test(text)) return "zh";
  return "en";
}

function targetLang(source) {
  if (source === "th") return "繁體中文";
  if (source === "zh") return "泰文";
  return "繁體中文";
}

/* =====================================================
   TRANSLATE
===================================================== */

async function translate(text, lang) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `你是專業翻譯引擎\n只輸出翻譯\n禁止解釋\n禁止補充`
      },
      {
        role: "user",
        content: `翻譯成${lang}：${text}`
      }
    ]
  });

  return r.choices[0].message.content.trim();
}

/* =====================================================
   PERMISSION HELPERS
===================================================== */

function isOwner(id) {
  return id === OWNER;
}

function isAdmin(id) {
  return admins.includes(id) || isOwner(id);
}

function isGroupAllowed(id) {
  return allowedGroups.includes(id);
}

/* =====================================================
   WEBHOOK
===================================================== */

app.post("/webhook", line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

/* =====================================================
   MAIN EVENT HANDLER
===================================================== */

async function handleEvent(event) {

  const userId = event.source.userId;
  const groupId = event.source.groupId;
  const roomId = event.source.roomId;
  const containerId = groupId || roomId;

  /* ==========================================
     JOIN EVENT (GATE)
  ========================================== */

  if (event.type === "join") {

    if (!isGroupAllowed(containerId)) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "🔐 此群尚未授權\n請管理員輸入 /authcode 授權"
      });
    }
    return;
  }

  /* ==========================================
     ONLY HANDLE TEXT
  ========================================== */

  if (event.type !== "message") return;
  if (event.message.type !== "text") return;

  const text = event.message.text.trim();

  /* ==========================================
     COMMAND PRIORITY (ALWAYS FIRST)
  ========================================== */

  if (text === "/myid") {
    return reply(event, `USER ID:\n${userId}`);
  }

  if (text === "/groupid") {
    if (!containerId) return reply(event, "非群組");
    return reply(event, `GROUP ID:\n${containerId}`);
  }

  /* ==========================================
     GROUP AUTH CHECK (ALLOW OWNER / ADMIN)
  ========================================== */

  if (containerId && !isGroupAllowed(containerId) && !isAdmin(userId)) {

    await reply(event, "❌ 此群組未授權");

    if (groupId) await client.leaveGroup(containerId);
    if (roomId) await client.leaveRoom(containerId);

    return;
  }

  /* ==========================================
     OWNER / ADMIN COMMANDS
  ========================================== */

  if (isAdmin(userId)) {

    /* ---- generate auth code ---- */
    if (text === "/gencode") {
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      authCodes.push(code);
      save(CODE_FILE, authCodes);
      return reply(event, `授權碼：${code}`);
    }

    /* ---- authorize group ---- */
    if (text.startsWith("/authcode")) {

      if (!containerId)
        return reply(event, "請在群組使用");

      const code = text.split(" ")[1];

      if (!authCodes.includes(code))
        return reply(event, "授權碼錯誤");

      if (!allowedGroups.includes(containerId)) {
        allowedGroups.push(containerId);
        save(GROUP_FILE, allowedGroups);
      }

      authCodes = authCodes.filter(c => c !== code);
      save(CODE_FILE, authCodes);

      return reply(event, "✅ 群組已授權");
    }

    /* ---- revoke group ---- */
    if (text === "/removegroup") {
      allowedGroups = allowedGroups.filter(g => g !== containerId);
      save(GROUP_FILE, allowedGroups);
      return reply(event, "🗑 已移除授權");
    }

    /* ---- list groups ---- */
    if (text === "/groups") {
      return reply(event, `授權群組數量：${allowedGroups.length}`);
    }

    /* ---- add admin ---- */
    if (text.startsWith("/addadmin") && isOwner(userId)) {
      const id = text.split(" ")[1];
      if (!admins.includes(id)) admins.push(id);
      save(ADMIN_FILE, admins);
      return reply(event, "已新增管理員");
    }
  }

  /* ==========================================
     IGNORE COMMAND TRANSLATION
  ========================================== */

  if (text.startsWith("/")) return;

  /* ==========================================
     TRANSLATION
  ========================================== */

  const source = detectLang(text);
  const target = targetLang(source);
  const result = await translate(text, target);

  return reply(event, `原文：${text}\n翻譯：${result}`);
}

/* =====================================================
   REPLY HELPER
===================================================== */

function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text
  });
}

/* =====================================================
   START SERVER
===================================================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("ENTERPRISE BOT RUNNING ON " + PORT);
});
