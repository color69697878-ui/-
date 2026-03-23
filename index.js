import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();

/* =========================
   LINE CONFIG
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
   BASIC
========================= */

function safeText(text) {
  return String(text || "").slice(0, 5000);
}

/* =========================
   🔥 v4.7.4 FILTER
========================= */

function shouldIgnoreText(text) {
  const t = String(text || "").trim();
  if (!t) return true;

  if (/^[\p{Emoji}\p{Extended_Pictographic}\s!-/:-@[-`{-~]+$/u.test(t) && t.length <= 8) {
    return true;
  }

  return false;
}

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
   LANG DETECT
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
   FAST
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

function enFast(text) {
  const dict = {
    "ok": "好",
  };
  return dict[text.trim().toLowerCase()] || "";
}

/* =========================
   GPT TRANSLATE
========================= */

async function translate(text, target) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.05,
    messages: [
      {
        role: "system",
        content: `你是中泰翻譯助手，只輸出翻譯結果，不要解釋`,
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

app.post("/webhook", line.middleware(config), async (req, res) => {
  const events = req.body.events;

  for (const event of events) {
    if (event.type !== "message") continue;
    if (event.message.type !== "text") continue;

    const text = event.message.text.trim();

    /* ===== 🔥 v4.7.4 核心 ===== */

    if (shouldIgnoreText(text)) continue;

    if (shouldSkipTranslateToken(text)) {
      console.log("⚠️ IN/OUT 不翻:", text);
      continue;
    }

    if (shouldSkipMentionMessage(event)) {
      console.log("⚠️ mention 不翻:", text);
      continue;
    }

    /* ========================= */

    const lang = detectLang(text);

    /* ===== 🔥 短字才 fast ===== */
    if (text.length <= 4) {
      let fast = "";

      if (lang === "zh") fast = zhFast(text);
      if (lang === "th") fast = thaiFast(text);
      if (lang === "en") fast = enFast(text);

      if (fast) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: fast,
        });
        continue;
      }
    }

    /* ===== GPT ===== */

    const target = getTargetLanguage(lang);
    let result = "";

    try {
      result = await translate(text, target);
    } catch (e) {
      result = text;
    }

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: safeText(result),
    });
  }

  res.sendStatus(200);
});

/* =========================
   START
========================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 BOT v4.7.4 running");
});
