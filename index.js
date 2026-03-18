import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

console.log("🚀 BOT v4.3 START");

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
   APP
========================= */

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   DB（防爆版）
========================= */

const DB_FILE = "./db.json";

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ dicts: {} }, null, 2), "utf8");
    }

    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object") {
      return { dicts: {} };
    }

    if (!parsed.dicts || typeof parsed.dicts !== "object") {
      parsed.dicts = {};
    }

    return parsed;
  } catch (e) {
    console.error("❌ DB 讀取失敗，改用空資料:", e?.message || e);
    return { dicts: {} };
  }
}

let db = loadDB();

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.error("❌ DB 儲存失敗:", e?.message || e);
  }
}

/* =========================
   工具
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
  const safeId = id || "default";

  if (!db || typeof db !== "object") db = { dicts: {} };
  if (!db.dicts || typeof db.dicts !== "object") db.dicts = {};
  if (!db.dicts[safeId] || typeof db.dicts[safeId] !== "object") {
    db.dicts[safeId] = {};
  }

  return db.dicts[safeId];
}

function setDict(id, source, target) {
  const safeId = id || "default";
  const dict = getDict(safeId);
  dict[source] = target;
  saveDB();
}

function deleteDict(id, source) {
  const safeId = id || "default";
  const dict = getDict(safeId);

  if (!(source in dict)) return false;

  delete dict[source];
  saveDB();
  return true;
}

function buildDictList(id) {
  const dict = getDict(id);
  const entries = Object.entries(dict);

  if (!entries.length) return "目前沒有自訂詞典";

  return entries
    .slice(0, 100)
    .map(([k, v], i) => `${i + 1}. ${k} => ${v}`)
    .join("\n");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================
   語言判斷
========================= */

function detectLang(text = "") {
  if (/[\u0E00-\u0E7F]/.test(text)) return "th";
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh";
  return "en";
}

/* =========================
   fallback
========================= */

function fallbackMessage(lang) {
  if (lang === "zh") return "稍等一下我再翻一次 🙏";
  if (lang === "th") return "ขอเวลาสักครู่ เดี๋ยวฉันแปลให้อีกครั้ง 🙏";
  return "Please wait a moment, I’ll translate it again 🙏";
}

/* =========================
   OpenAI 翻譯（穩定版）
========================= */

async function translate(text, target) {
  const maxAttempts = 3;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      console.log(`🧠 OpenAI 翻譯中，第 ${i + 1}/${maxAttempts} 次`);

      const r = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        timeout: 30000,
        messages: [
          {
            role: "system",
            content: "你是翻譯助手，只輸出翻譯結果，不要解釋，不要加引號，不要加前言。"
          },
          {
            role: "user",
            content: `請翻譯成${target}：${text}`
          }
        ]
      });

      const result = r?.choices?.[0]?.message?.content?.trim();

      if (result) {
        console.log("✅ OpenAI 翻譯成功");
        return result;
      }

      console.log("⚠️ OpenAI 有回應，但內容是空的");
    } catch (e) {
      console.error(`❌ OpenAI error 第 ${i + 1} 次:`, e?.message || e);
    }

    if (i < maxAttempts - 1) {
      console.log("⏳ 1 秒後重試 OpenAI...");
      await sleep(1000);
    }
  }

  return null;
}

/* =========================
   LINE reply（穩定版）
========================= */

async function safeReply(replyToken, text) {
  const maxAttempts = 2;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      await client.replyMessage(replyToken, {
        type: "text",
        text: String(text || "").slice(0, 5000),
      });

      console.log("✅ reply 成功");
      return true;
    } catch (e) {
      console.error(`❌ reply error 第 ${i + 1} 次:`, e?.message || e);
    }
  }

  return false;
}

/* =========================
   短句快翻
========================= */

function thaiFast(text) {
  const t = text.trim();

  const dict = {
    "ค่ะ": "好",
    "ครับ": "好",
    "ใช่": "對",
    "ใช่ค่ะ": "對",
    "ใช่ครับ": "對",
    "ได้": "可以",
    "ได้ค่ะ": "可以",
    "ได้ครับ": "可以",
    "ยัง": "還沒",
    "ไป": "去",
    "มา": "來",
  };

  return dict[t] || "";
}

/* =========================
   handleEvent
========================= */

async function handleEvent(event) {
  try {
    if (!event) {
      console.log("⚠️ event 不存在");
      return;
    }

    if (!event.source) {
      console.log("⚠️ event.source 不存在");
      return;
    }

    if (event.type !== "message") return;
    if (event.message?.type !== "text") return;

    const text = event.message?.text?.trim();

    if (!text) {
      console.log("⚠️ 空訊息，略過");
      return;
    }

    console.log("📩 收到訊息:", text);

    const id = safeGetId(event);
    console.log("🆔 id:", id);

    /* 指令 */

    if (text === "/ping") {
      await safeReply(event.replyToken, "pong");
      return;
    }

    if (text === "/dict list") {
      await safeReply(event.replyToken, buildDictList(id));
      return;
    }

    if (text.startsWith("/dict add ")) {
      const raw = text.replace("/dict add ", "").trim();
      const parts = raw.split("=>");

      if (parts.length < 2) {
        await safeReply(event.replyToken, "格式錯誤\n請使用：/dict add 原文 => 翻譯");
        return;
      }

      const source = parts[0].trim();
      const target = parts.slice(1).join("=>").trim();

      if (!source || !target) {
        await safeReply(event.replyToken, "格式錯誤\n請使用：/dict add 原文 => 翻譯");
        return;
      }

      setDict(id, source, target);
      await safeReply(event.replyToken, `✅ 已加入詞典\n${source} => ${target}`);
      return;
    }

    if (text.startsWith("/dict del ")) {
      const source = text.replace("/dict del ", "").trim();

      if (!source) {
        await safeReply(event.replyToken, "格式錯誤\n請使用：/dict del 原文");
        return;
      }

      const ok = deleteDict(id, source);
      await safeReply(
        event.replyToken,
        ok ? `✅ 已刪除：${source}` : "⚠️ 找不到這筆詞典"
      );
      return;
    }

    /* 詞典優先 */

    const dict = getDict(id);

    if (dict[text]) {
      console.log("📚 命中自訂詞典");
      await safeReply(event.replyToken, dict[text]);
      return;
    }

    /* 泰文短句快翻 */

    if (detectLang(text) === "th") {
      const fast = thaiFast(text);
      if (fast) {
        console.log("⚡ 命中泰文快翻");
        await safeReply(event.replyToken, fast);
        return;
      }
    }

    /* AI 翻譯 */

    const lang = detectLang(text);
    let target = "中文";

    if (lang === "zh") target = "泰文";
    else if (lang === "th") target = "繁體中文";
    else target = "繁體中文";

    console.log("🧠 準備送 OpenAI，目標語言:", target);

    let result = await translate(text, target);

    if (!result) {
      console.log("⚠️ OpenAI 最終失敗，使用 fallback");
      result = fallbackMessage(lang);
    }

    console.log("📤 準備回覆:", result);

    const ok = await safeReply(event.replyToken, result);

    if (!ok) {
      console.log("⚠️ reply 最終失敗");
    }
  } catch (e) {
    console.error("❌ handleEvent 爆掉:", e?.message || e);

    try {
      await safeReply(event?.replyToken, "⚠️ 系統忙碌中，請再試一次");
    } catch {}
  }
}

/* =========================
   Routes
========================= */

app.get("/", (req, res) => {
  res.send("BOT OK");
});

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    console.log("📨 webhook 進來了，events:", req?.body?.events?.length || 0);

    await Promise.all(
      (req.body.events || []).map(async (event) => {
        try {
          await handleEvent(event);
        } catch (e) {
          console.error("❌ event error:", e?.message || e);
        }
      })
    );
  } catch (e) {
    console.error("❌ webhook error:", e?.message || e);
  }

  res.sendStatus(200);
});

/* =========================
   Start
========================= */

app.listen(PORT, () => {
  console.log(`🚀 BOT v4.3 RUNNING ON PORT ${PORT}`);
});
