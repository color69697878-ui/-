import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

console.log("🚀 BOT v4.2 START");

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
   DB（防爆版）
========================= */

const DB_FILE = "./db.json";

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ dicts: {} }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DB_FILE));
  } catch (e) {
    console.error("❌ DB 壞掉，重建", e);
    return { dicts: {} };
  }
}

let db = loadDB();

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("❌ DB 儲存失敗", e);
  }
}

/* =========================
   工具（防爆）
========================= */

function safeGetId(event) {
  try {
    return (
      event?.source?.groupId ||
      event?.source?.roomId ||
      event?.source?.userId ||
      "default"
    );
  } catch {
    return "default";
  }
}

function getDict(id) {
  if (!id) id = "default";
  if (!db.dicts) db.dicts = {};
  if (!db.dicts[id]) db.dicts[id] = {};
  return db.dicts[id];
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
   fallback（永遠有回）
========================= */

function fallback(text, lang) {
  if (lang === "zh") return "（暫時無法翻譯泰文）";
  if (lang === "th") return "（暫時無法翻譯中文）";
  return "（翻譯暫時不可用）";
}

/* =========================
   OpenAI（防爆+retry）
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

      const result = r.choices?.[0]?.message?.content?.trim();
      if (result) return result;

    } catch (e) {
      console.error("❌ OpenAI error:", e.message);
    }
  }

  return null;
}

/* =========================
   LINE reply（防爆+retry）
========================= */

async function safeReply(token, text) {
  for (let i = 0; i < 2; i++) {
    try {
      await client.replyMessage(token, {
        type: "text",
        text: text.slice(0, 5000),
      });
      console.log("✅ 回覆成功");
      return true;
    } catch (e) {
      console.error("❌ reply error:", e.message);
    }
  }
  return false;
}

/* =========================
   主邏輯（防爆）
========================= */

async function handleEvent(event) {
  try {
    if (!event || event.type !== "message") return;
    if (event.message.type !== "text") return;

    const text = event.message.text?.trim();
    if (!text) return;

    console.log("📩 收到:", text);

    const id = safeGetId(event);
    console.log("🆔 id:", id);

    const dict = getDict(id);

    /* 詞典 */
    if (dict[text]) {
      await safeReply(event.replyToken, dict[text]);
      return;
    }

    /* AI */
    const lang = detectLang(text);
    const target = lang === "zh" ? "泰文" : "中文";

    console.log("🧠 翻譯中...");

    let result = await translate(text, target);

    if (!result) {
      result = fallback(text, lang);
    }

    console.log("📤 回覆:", result);

    await safeReply(event.replyToken, result);

  } catch (e) {
    console.error("❌ handleEvent 爆掉:", e);

    try {
      await safeReply(
        event.replyToken,
        "⚠️ 系統忙碌中，請再試一次"
      );
    } catch {}
  }
}

/* =========================
   webhook（不會爆）
========================= */

const app = express();

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(
      req.body.events.map(async (event) => {
        try {
          await handleEvent(event);
        } catch (e) {
          console.error("❌ event error:", e);
        }
      })
    );
  } catch (e) {
    console.error("❌ webhook error:", e);
  }

  res.sendStatus(200);
});

/* =========================
   啟動
========================= */

app.get("/", (req, res) => {
  res.send("OK");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 BOT v4.2 RUNNING");
});
