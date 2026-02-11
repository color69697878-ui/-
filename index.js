import express from "express";
import line from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();

/* LINE */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

/* OpenAI */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* 使用者語言模式 */
const userLang = new Map();

/* 語言判斷 */
function detectLang(text) {
  if (/[\u0E00-\u0E7F]/.test(text)) return "th";
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh";
  return "en";
}

function targetLang(source, mode) {
  if (mode && mode !== "auto") return mode;
  if (source === "th") return "繁體中文";
  if (source === "zh") return "泰文";
  return "繁體中文";
}

/* 翻譯 */
async function translate(text, lang) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: `翻譯成${lang}，只輸出翻譯` },
      { role: "user", content: text }
    ]
  });
  return r.choices[0].message.content.trim();
}

/* webhook */
app.post("/webhook", line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

async function handleEvent(event) {
  if (event.type !== "message") return;

  const userId = event.source.userId || event.source.groupId;

  /* 文字 */
  if (event.message.type === "text") {
    const text = event.message.text;

    if (text.startsWith("/lang")) {
      const mode = text.split(" ")[1] || "auto";
      userLang.set(userId, mode);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: `語言模式：${mode}`
      });
    }

    const source = detectLang(text);
    const mode = userLang.get(userId) || "auto";
    const target = targetLang(source, mode);
    const result = await translate(text, target);

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `原文：${text}\n翻譯：${result}`
    });
  }

  /* 語音 */
  if (event.message.type === "audio") {
    const stream = await client.getMessageContent(event.message.id);
    const file = `/tmp/${event.message.id}.m4a`;
    const w = fs.createWriteStream(file);

    await new Promise((resolve) => {
      stream.pipe(w);
      stream.on("end", resolve);
    });

    const t = await openai.audio.transcriptions.create({
      file: fs.createReadStream(file),
      model: "gpt-4o-mini-transcribe"
    });

    const source = detectLang(t.text);
    const mode = userLang.get(userId) || "auto";
    const target = targetLang(source, mode);
    const result = await translate(t.text, target);

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `語音：${t.text}\n翻譯：${result}`
    });
  }
}

app.listen(3000, () => console.log("BOT RUNNING"));
