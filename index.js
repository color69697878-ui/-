import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";
import { Converter } from "opencc-js";

dotenv.config();

console.log("🚀 BOT v4.7.4 PRO START");

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
   ENV
========================= */

const OWNER = process.env.OWNER_USER_ID || "";

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
      fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    return JSON.parse(fs.readFileSync(DB_FILE));
  } catch {
    return createDefaultDB();
  }
}

let db = loadDB();

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/* =========================
   GROUP CONTROL
========================= */

function isOwner(event) {
  return (event?.source?.userId || "") === OWNER;
}

function getChatId(event) {
  return (
    event?.source?.groupId ||
    event?.source?.roomId ||
    event?.source?.userId ||
    "default"
  );
}

function isGroup(event) {
  return event?.source?.type === "group" || event?.source?.type === "room";
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

function approveGroup(id) {
  db.pending = db.pending.filter((x) => x !== id);
  if (!db.allowed.includes(id)) db.allowed.push(id);
  saveDB();
}

function rejectGroup(id) {
  db.pending = db.pending.filter((x) => x !== id);
  saveDB();
}

/* =========================
   FILTER（v4.7.4）
========================= */

function shouldSkipTranslateToken(text = "") {
  const t = String(text || "").trim().toUpperCase();
  return /^(?:\d+\s*)?(IN|OUT)(?:\s*\d+)?$/.test(t);
}

function shouldSkipMentionMessage(event) {
  const text = String(event?.message?.text || "").trim();
  const mention = event?.message?.mention;

  if (mention?.mentionees?.length) {
    const cleaned = text
      .replace(/@\S+/g, "")
      .replace(/[\p{Emoji}\p{Extended_Pictographic}\s!-/:-@[-`{-~]+/gu, "")
      .trim();

    if (!cleaned) return true;
  }

  if (/^@\S+$/.test(text)) return true;

  return false;
}

/* =========================
   LANG
========================= */

function hasThai(text = "") {
  return /[\u0E00-\u0E7F]/.test(text);
}

function hasChinese(text = "") {
  return /[\u4E00-\u9FFF]/.test(text);
}

function detectLang(text = "") {
  if (hasThai(text)) return "th";
  if (hasChinese(text)) return "zh";
  return "en";
}

function getTargetLanguage(lang) {
  if (lang === "zh") return "泰文";
  if (lang === "th") return "繁體中文";
  return "繁體中文";
}

/* =========================
   FAST（短字）
========================= */

function zhFast(text) {
  const dict = {
    "嗯": "อืม",
    "好": "โอเค",
    "現在": "ตอนนี้",
  };
  return dict[text.trim()] || "";
}

function thaiFast(text) {
  const dict = {
    "ใช่": "對",
    "โอเค": "好",
  };
  return dict[text.trim()] || "";
}

/* =========================
   GPT
========================= */

async function translate(text, target) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.05,
    messages: [
      {
        role: "system",
        content: "你是中泰翻譯助手，只輸出翻譯結果",
      },
      {
        role: "user",
        content: `翻譯成${target}：${text}`,
      },
    ],
  });

  return r.choices[0].message.content.trim();
}

/* =========================
   MAIN
========================= */

async function handleEvent(event) {
  if (event.type === "join") {
    const id = getChatId(event);

    if (!isAllowed(id)) {
      addPending(id);

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "🔐 此群組尚未授權\n請 OWNER 輸入 /approve",
      });
    }

    return;
  }

  if (event.type !== "message") return;
  if (event.message.type !== "text") return;

  const text = event.message.text.trim();
  const id = getChatId(event);

  /* ===== 指令 ===== */

  if (text === "/approve" && isOwner(event)) {
    approveGroup(id);
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "✅ 群組授權成功",
    });
    return;
  }

  if (text === "/reject" && isOwner(event)) {
    rejectGroup(id);
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ 已拒絕群組",
    });
    return;
  }

  if (text === "/pending" && isOwner(event)) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: db.pending.length
        ? db.pending.join("\n")
        : "沒有待授權群組",
    });
    return;
  }

  /* ===== 未授權 ===== */

  if (isGroup(event) && !isAllowed(id)) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "⛔ 此群組尚未授權\n請 OWNER 輸入 /approve",
    });
    return;
  }

  /* ===== 過濾 ===== */

  if (shouldSkipTranslateToken(text)) return;
  if (shouldSkipMentionMessage(event)) return;

  /* ===== 翻譯 ===== */

  const lang = detectLang(text);

  if (text.length <= 4) {
    const fast =
      lang === "zh" ? zhFast(text) :
      lang === "th" ? thaiFast(text) :
      "";

    if (fast) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: toTraditionalChinese(fast),
      });
      return;
    }
  }

  let result = text;

  try {
    result = await translate(text, getTargetLanguage(lang));
  } catch (e) {
    console.error(e);
  }

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: toTraditionalChinese(result),
  });
}

/* =========================
   SERVER
========================= */

const app = express();

app.post("/webhook", line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 BOT RUNNING ON " + PORT);
});
