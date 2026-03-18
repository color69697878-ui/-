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
   設定
========================= */

const OWNER = process.env.OWNER_USER_ID;

/* =========================
   v3 自動學習
========================= */

const AUTO_LEARN_ENABLED = true;

/* =========================
   DB
========================= */

const GROUP_DB_FILE = "./groups.json";

function loadJSON(file, fallback) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
    return fallback;
  }
  return JSON.parse(fs.readFileSync(file));
}

let groupDB = loadJSON(GROUP_DB_FILE, {
  allowed: [],
  styles: {},
  dicts: {}
});

function saveDB() {
  fs.writeFileSync(GROUP_DB_FILE, JSON.stringify(groupDB, null, 2));
}

/* =========================
   工具
========================= */

function getId(event) {
  return event.source.groupId || event.source.roomId || null;
}

function isGroup(event) {
  return event.source.type !== "user";
}

/* =========================
   詞典
========================= */

function getDict(id) {
  if (!groupDB.dicts[id]) groupDB.dicts[id] = {};
  return groupDB.dicts[id];
}

function setDict(id, k, v) {
  getDict(id)[k] = v;
  saveDB();
}

/* =========================
   語境記憶 v4
========================= */

const memory = new Map();

function pushMemory(event, text) {
  const key = getId(event) || event.source.userId;
  if (!memory.has(key)) memory.set(key, []);
  const arr = memory.get(key);
  arr.push(text);
  if (arr.length > 5) arr.shift();
}

function getContext(event) {
  const key = getId(event) || event.source.userId;
  const arr = memory.get(key) || [];

  const last = arr[arr.length - 1] || "";

  return {
    last,
    isQuestion: /嗎|ไหม|มั้ย|\?$/.test(last),
    isAction: /去嗎|來嗎|ไปไหม|มาไหม/.test(last),
    isConfirm: /對嗎|ใช่ไหม/.test(last),
  };
}

/* =========================
   語言判斷
========================= */

function detectLang(text) {
  if (/[\u0E00-\u0E7F]/.test(text)) return "th";
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh";
  return "en";
}

/* =========================
   v4 泰文短詞
========================= */

function thaiFast(text, ctx) {
  const t = text.trim();

  if (["ยัง"].includes(t)) {
    return ctx.isQuestion ? "還沒" : "還";
  }

  if (["ค่ะ","ครับ"].includes(t)) {
    if (ctx.isConfirm) return "對";
    if (ctx.isQuestion) return "可以";
    return "好";
  }

  if (["ไปค่ะ","ไปครับ","ไป"].includes(t)) {
    return ctx.isAction ? "會去" : "去";
  }

  if (["มา"].includes(t)) {
    return ctx.isAction ? "會來" : "來";
  }

  if (["ได้"].includes(t)) {
    return "可以";
  }

  return "";
}

/* =========================
   v3 自動學習
========================= */

function autoLearn(id, src, result) {
  if (!AUTO_LEARN_ENABLED) return;
  if (!src || !result) return;

  const dict = getDict(id);
  if (dict[src]) return;

  if (src.length < 4) return;

  dict[src] = result;
  saveDB();

  console.log("🧠 學習:", src, "=>", result);
}

/* =========================
   翻譯
========================= */

async function translate(text, target) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "只輸出翻譯"
      },
      {
        role: "user",
        content: `翻譯成${target}：${text}`
      }
    ]
  });

  return r.choices[0].message.content.trim();
}

/* =========================
   回覆
========================= */

async function reply(event, text) {
  try {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text
    });
  } catch {
    console.log("reply fail");
  }
}

/* =========================
   主邏輯
========================= */

async function handleEvent(event) {

  if (event.type !== "message") return;
  if (event.message.type !== "text") return;

  const text = event.message.text.trim();
  const id = getId(event);

  const ctx = getContext(event);

  /* 詞典優先 */
  const dict = getDict(id);
  if (dict[text]) {
    await reply(event, dict[text]);
    pushMemory(event, text);
    return;
  }

  /* v4 快翻 */
  if (detectLang(text) === "th") {
    const fast = thaiFast(text, ctx);
    if (fast) {
      await reply(event, fast);
      pushMemory(event, text);
      return;
    }
  }

  /* AI 翻譯 */
  const lang = detectLang(text);
  const target = lang === "zh" ? "泰文" : "中文";

  const result = await translate(text, target);

  await reply(event, result);

  /* v3 學習 */
  if (isGroup(event)) {
    autoLearn(id, text, result);
  }

  pushMemory(event, text);
}

/* =========================
   webhook
========================= */

app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

/* =========================
   start
========================= */

app.listen(3000, () => {
  console.log("🚀 BOT RUNNING v4");
});
