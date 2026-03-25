// ===== 指令（一定要放最前面） =====

if (text === "/approve" && isOwner(e)) {
  db.allowed.push(id);
  db.pending = db.pending.filter(x => x !== id);
  saveDB();

  await client.replyMessage(e.replyToken, {
    type: "text",
    text: "✅ 已授權成功",
  });
  return;
}

if (text === "/pending" && isOwner(e)) {
  await client.replyMessage(e.replyToken, {
    type: "text",
    text: db.pending.join("\n") || "沒有待授權",
  });
  return;
}


// ===== 未授權判斷（放後面） =====

if (isGroup(e) && !isAllowed(id)) {
  await client.replyMessage(e.replyToken, {
    type: "text",
    text: "⛔ 此群組尚未授權\n請輸入 /approve",
  });
  return;
}
import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

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

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const init = {
      allowed: [],
      pending: [],
      dicts: {},
      globalDict: {},
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}

let db = loadDB();

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/* =========================
   GROUP
========================= */

const OWNER = process.env.OWNER_USER_ID;

function getId(e) {
  return e.source.groupId || e.source.roomId || e.source.userId;
}

function isOwner(e) {
  return e.source.userId === OWNER;
}

function isGroup(e) {
  return e.source.type !== "user";
}

function isAllowed(id) {
  return db.allowed.includes(id);
}

/* =========================
   FILTER（重點）
========================= */

// ❌ 全部不翻：標點 / emoji / 貼圖
function isNoise(text = "") {
  return /^[\p{Emoji}\p{Extended_Pictographic}\s!-/:-@[-`{-~]+$/u.test(text);
}

// ❌ IN OUT
function isInOut(text = "") {
  return /^(?:\d+\s*)?(IN|OUT)(?:\s*\d+)?$/i.test(text.trim());
}

// ❌ mention
function isMention(event) {
  const m = event.message.mention;
  const t = event.message.text.trim();
  return (m?.mentionees?.length && t.replace(/@\S+/g, "").trim() === "") || /^@\S+$/.test(t);
}

/* =========================
   人名保護
========================= */

const PROTECTED = ["Kitty", "Nana", "Ploy", "Bangkok", "LINE"];

function protect(text) {
  let tokens = [];
  let out = text;

  PROTECTED.forEach((p, i) => {
    const token = `__PN${i}__`;
    if (out.includes(p)) {
      out = out.replaceAll(p, token);
      tokens.push([token, p]);
    }
  });

  return { out, tokens };
}

function restore(text, tokens) {
  let out = text;
  tokens.forEach(([t, p]) => {
    out = out.replaceAll(t, p);
  });
  return out;
}

/* =========================
   FAST
========================= */

function fast(text) {
  const map = {
    "好": "โอเค",
    "嗯": "อืม",
    "ใช่": "對",
    "ok": "好",
  };
  return map[text.trim()] || "";
}

/* =========================
   GPT
========================= */

async function translate(text) {
  const { out, tokens } = protect(text);

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
        content: out,
      },
    ],
  });

  let result = r.choices[0].message.content.trim();
  return restore(result, tokens);
}

/* =========================
   MAIN
========================= */

async function handle(e) {
  if (e.type === "join") {
    const id = getId(e);
    if (!isAllowed(id)) {
      db.pending.push(id);
      saveDB();
      await client.replyMessage(e.replyToken, {
        type: "text",
        text: "未授權，請 /approve",
      });
    }
    return;
  }

  if (e.type !== "message" || e.message.type !== "text") return;

  const text = e.message.text.trim();
  const id = getId(e);

  // ❌ 未授權
  if (isGroup(e) && !isAllowed(id)) {
    await client.replyMessage(e.replyToken, {
      type: "text",
      text: "未授權群組",
    });
    return;
  }

  // ❌ 不翻條件
  if (isNoise(text)) return;
  if (isInOut(text)) return;
  if (isMention(e)) return;

  // 指令
  if (text === "/approve" && isOwner(e)) {
    db.allowed.push(id);
    saveDB();
    return client.replyMessage(e.replyToken, {
      type: "text",
      text: "已授權",
    });
  }

  if (text === "/pending" && isOwner(e)) {
    return client.replyMessage(e.replyToken, {
      type: "text",
      text: db.pending.join("\n") || "無",
    });
  }

  if (text.startsWith("/gdict add") && isOwner(e)) {
    const [, pair] = text.split("/gdict add ");
    const [k, v] = pair.split("=>").map(s => s.trim());
    db.globalDict[k] = v;
    saveDB();
    return client.replyMessage(e.replyToken, { type: "text", text: "OK" });
  }

  // 詞典優先
  if (db.globalDict[text]) {
    return client.replyMessage(e.replyToken, {
      type: "text",
      text: db.globalDict[text],
    });
  }

  // fast
  if (text.length <= 4) {
    const f = fast(text);
    if (f) {
      return client.replyMessage(e.replyToken, {
        type: "text",
        text: f,
      });
    }
  }

  // GPT
  const result = await translate(text);

  await client.replyMessage(e.replyToken, {
    type: "text",
    text: result,
  });
}

/* =========================
   SERVER
========================= */

const app = express();

app.post("/webhook", line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handle));
  res.sendStatus(200);
});

app.listen(3000, () => {
  console.log("🚀 RUNNING");
});
