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
   DB
========================= */

const DB_FILE = "./groups.json";

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ dicts: {} }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}

let db = loadDB();

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/* =========================
   工具
========================= */

function getId(event) {
  return (
    event.source.groupId ||
    event.source.roomId ||
    event.source.userId
  );
}

function isGroup(event) {
  return event.source.type !== "user";
}

/* =========================
   詞典
========================= */

function getDict(id) {
  if (!db.dicts[id]) db.dicts[id] = {};
  return db.dicts[id];
}

/* =========================
   記憶（v4）
========================= */

const memory = new Map();

function pushMemory(id, text) {
  if (!memory.has(id)) memory.set(id, []);
  const arr = memory.get(id);
  arr.push(text);
  if (arr.length > 5) arr.shift();
}

function getContext(id) {
  const arr = memory.get(id) || [];
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
   v4 泰文快翻
========================= */

function thaiFast(text, ctx) {
  const t = text.trim();

  if (t === "ยัง") return ctx.isQuestion ? "還沒" : "還";
  if (["ค่ะ","ครับ"].includes(t)) {
    if (ctx.isConfirm) return "對";
    if (ctx.isQuestion) return "可以";
    return "好";
  }
  if (t.includes("ไป")) return ctx.isAction ? "會去" : "去";
  if (t.includes("มา")) return ctx.isAction ? "會來" : "來";
  if (t === "ได้") return "可以";

  return "";
}

/* =========================
   fallback 翻譯
========================= */

function fallbackTranslate(text, lang) {
  if (lang === "zh") return "（泰文翻譯暫時不可用）";
  if (lang === "th") return "（中文翻譯暫時不可用）";
  return "（翻譯暫時不可用）";
}

/* =========================
   OpenAI 翻譯（含 retry）
========================= */

async function translate(text, target) {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        timeout: 15000,
        messages: [
          { role: "system", content: "只輸出翻譯結果" },
          { role: "user", content: `翻譯成${target}：${text}` }
        ]
      });

      return r.choices[0].message.content.trim();

    } catch (err) {
      console.error("❌ OpenAI error:", err.message);
      if (i === 1) return null;
    }
  }
}

/* =========================
   reply（含 retry）
========================= */

async function safeReply(token, text) {
  for (let i = 0; i < 2; i++) {
    try {
      await client.replyMessage(token, {
        type: "text",
        text
      });
      return;
    } catch (err) {
      console.error("❌ reply error:", err.message);
    }
  }
}

/* =========================
   主邏輯
========================= */

async function handleEvent(event) {
  try {
    if (event.type !== "message") return;
    if (event.message.type !== "text") return;

    const text = event.message.text.trim();
    const id = getId(event);

    if (!text) return;

    const ctx = getContext(id);

    /* 詞典 */
    const dict = getDict(id);
    if (dict[text]) {
      await safeReply(event.replyToken, dict[text]);
      pushMemory(id, text);
      return;
    }

    /* 快翻 */
    if (detectLang(text) === "th") {
      const fast = thaiFast(text, ctx);
      if (fast) {
        await safeReply(event.replyToken, fast);
        pushMemory(id, text);
        return;
      }
    }

    /* AI */
    const lang = detectLang(text);
    const target = lang === "zh" ? "泰文" : "中文";

    let result = await translate(text, target);

    if (!result) {
      result = fallbackTranslate(text, lang);
    }

    await safeReply(event.replyToken, result);

    pushMemory(id, text);

  } catch (err) {
    console.error("❌ handleEvent error:", err);
  }
}

/* =========================
   webhook（穩定版）
========================= */

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(
      req.body.events.map(async (event) => {
        try {
          await handleEvent(event);
        } catch (err) {
          console.error("❌ event error:", err);
        }
      })
    );
  } catch (err) {
    console.error("❌ webhook error:", err);
  }

  res.sendStatus(200);
});

/* =========================
   start
========================= */

app.listen(3000, () => {
  console.log("🚀 BOT RUNNING v4.1 STABLE");
});
