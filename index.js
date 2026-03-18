import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

console.log("🚀 BOT v4.5 START");

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
const OWNER = process.env.OWNER_USER_ID || "";

/* =========================
   DB
========================= */

const DB_FILE = "./groups.json";

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const init = {
        allowed: [],
        pending: [],
        styles: {},
        dicts: {}
      };
      fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2), "utf8");
      return init;
    }

    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object") {
      return { allowed: [], pending: [], styles: {}, dicts: {} };
    }

    if (!Array.isArray(parsed.allowed)) parsed.allowed = [];
    if (!Array.isArray(parsed.pending)) parsed.pending = [];
    if (!parsed.styles || typeof parsed.styles !== "object") parsed.styles = {};
    if (!parsed.dicts || typeof parsed.dicts !== "object") parsed.dicts = {};

    return parsed;
  } catch (e) {
    console.error("❌ DB 讀取失敗，改用空資料:", e?.message || e);
    return { allowed: [], pending: [], styles: {}, dicts: {} };
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

function isGroupOrRoom(event) {
  return event?.source?.type === "group" || event?.source?.type === "room";
}

function isOwner(event) {
  return (event?.source?.userId || "") === OWNER;
}

function ensureDBShape(id) {
  if (!db || typeof db !== "object") db = {};
  if (!Array.isArray(db.allowed)) db.allowed = [];
  if (!Array.isArray(db.pending)) db.pending = [];
  if (!db.styles || typeof db.styles !== "object") db.styles = {};
  if (!db.dicts || typeof db.dicts !== "object") db.dicts = {};

  if (id) {
    if (!db.styles[id]) db.styles[id] = "auto";
    if (!db.dicts[id] || typeof db.dicts[id] !== "object") {
      db.dicts[id] = {};
    }
  }
}

function isAllowed(id) {
  ensureDBShape();
  return db.allowed.includes(id);
}

function addPending(id) {
  if (!id) return;
  ensureDBShape(id);
  if (!db.pending.includes(id)) {
    db.pending.push(id);
    saveDB();
  }
}

function approveGroup(id) {
  if (!id) return;
  ensureDBShape(id);

  db.pending = db.pending.filter(x => x !== id);
  if (!db.allowed.includes(id)) db.allowed.push(id);
  if (!db.styles[id]) db.styles[id] = "auto";

  saveDB();
}

function rejectGroup(id) {
  if (!id) return;
  ensureDBShape(id);
  db.pending = db.pending.filter(x => x !== id);
  saveDB();
}

function getStyle(id) {
  ensureDBShape(id);
  return db.styles[id] || "auto";
}

function setStyle(id, style) {
  ensureDBShape(id);
  db.styles[id] = style;
  saveDB();
}

function getDict(id) {
  ensureDBShape(id);
  return db.dicts[id] || {};
}

function setDict(id, source, target) {
  ensureDBShape(id);
  db.dicts[id][source] = target;
  saveDB();
}

function deleteDict(id, source) {
  ensureDBShape(id);
  if (!(source in db.dicts[id])) return false;
  delete db.dicts[id][source];
  saveDB();
  return true;
}

function buildDictList(id) {
  const dict = getDict(id);
  const entries = Object.entries(dict);

  if (!entries.length) return "目前此群組沒有自訂詞典";

  return `此群組自訂詞典：\n\n${entries
    .slice(0, 100)
    .map(([k, v], i) => `${i + 1}. ${k} => ${v}`)
    .join("\n")}`;
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
   快翻
========================= */

function thaiFast(text) {
  const t = text.trim();

  const dict = {
    "ค่ะ": "好",
    "ครับ": "好",
    "คะ": "好",
    "ใช่": "對",
    "ใช่ค่ะ": "對",
    "ใช่ครับ": "對",
    "ได้": "可以",
    "ได้ค่ะ": "可以",
    "ได้ครับ": "可以",
    "ยัง": "還沒",
    "ไม่": "不",
    "ไป": "去",
    "มา": "來",
    "ไปค่ะ": "會去",
    "ไปครับ": "會去",
    "มาค่ะ": "會來",
    "มาครับ": "會來",
    "ไปไหน": "要去哪",
    "มาไหม": "要來嗎",
    "ไปไหม": "要去嗎",
    "ไม่ไป": "不去",
    "ไม่มา": "不來",
    "มาแล้ว": "來了",
    "ไปแล้ว": "去了",
    "กลับแล้ว": "回去了",
    "ออกไปแล้ว": "離開了",
  };

  return dict[t] || "";
}

function zhFast(text) {
  const t = text.trim();

  const dict = {
    "嗯": "อืม",
    "恩": "อืม",
    "喔": "อ๋อ",
    "哦": "อ๋อ",
    "嗯嗯": "อืม",
    "可以": "ได้",
    "去": "ไป",
    "來": "มา",
    "對": "ใช่",
    "是": "ใช่",
  };

  return dict[t] || "";
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
   Prompt / 翻譯
========================= */

function buildStyleInstruction(style) {
  const base = `
你是中泰聊天翻譯助手，只輸出翻譯結果，不要解釋，不要加引號，不要加前言。
翻譯要自然、口語、符合聊天習慣。
如果原文有明顯錯字或口語亂打，要先理解最可能原意再翻譯。
如果句中出現疑似地名、音譯詞、不明專有名詞，不可自行腦補成喝酒、夜店、上班等場景。
若無法確定不明詞意思，優先保守翻成某個地方或直接保留主幹語意。
如果原文較長，請優先保留整體意思，不要漏翻。
`;

  const styles = {
    auto: "請自動選擇最自然的聊天語氣。",
    precise: "請以原意優先，不要過度腦補。",
    casual: "請用朋友聊天口氣。",
    romance: "請保留感情與柔和語氣。",
    nightlife: "你懂夜生活場景，但不可亂猜地名或活動。",
    work: "請清楚自然，稍微正式。",
    feminine: "請用自然柔和的女生聊天感。",
    masculine: "請用自然直接的男生聊天感。",
  };

  return `${base}\n${styles[style] || styles.auto}`;
}

async function translateSingle(text, target, style = "auto") {
  const maxAttempts = 3;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      console.log(`🧠 OpenAI 翻譯中，第 ${i + 1}/${maxAttempts} 次`);

      const r = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        timeout: 40000,
        messages: [
          {
            role: "system",
            content: buildStyleInstruction(style)
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

      console.log("⚠️ OpenAI 有回應但內容為空");
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
   智慧分句
========================= */

function normalizeForSplit(text) {
  return text
    .replace(/因為/g, "，因為")
    .replace(/但是/g, "，但是")
    .replace(/可是/g, "，可是")
    .replace(/所以/g, "，所以")
    .replace(/如果/g, "，如果")
    .replace(/แล้ว/g, " แล้ว ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitText(text) {
  const normalized = normalizeForSplit(text);

  const parts = normalized
    .split(/[\n,，。.!！？?]/)
    .map(s => s.trim())
    .filter(Boolean);

  if (!parts.length) return [text];

  return parts;
}

function shouldSplitText(text) {
  if (!text) return false;
  if (text.length >= 28) return true;
  if (/因為|但是|可是|所以|如果|，|。|!|！|\?|\？/.test(text)) return true;
  return false;
}

async function translateSmart(text, target, style = "auto", lang = "zh") {
  if (!shouldSplitText(text)) {
    return await translateSingle(text, target, style);
  }

  console.log("✂️ 啟用智慧分句翻譯");

  const parts = splitText(text);
  const translatedParts = [];

  for (const part of parts) {
    const r = await translateSingle(part, target, style);
    translatedParts.push(r || fallbackMessage(lang));
  }

  return translatedParts.join("\n");
}

/* =========================
   LINE reply
========================= */

async function safeReply(replyToken, text) {
  if (!replyToken) return false;

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
   Event
========================= */

async function handleJoin(event) {
  const id = safeGetId(event);
  console.log("👥 join event, id:", id);

  if (!isAllowed(id)) {
    addPending(id);
    await safeReply(
      event.replyToken,
      `🔐 此群組尚未授權

請管理員輸入：

/approve`
    );
    return;
  }

  await safeReply(event.replyToken, "✅ 此群組已授權");
}

async function handleTextMessage(event) {
  const text = event?.message?.text?.trim();
  if (!text) return;

  const id = safeGetId(event);
  const style = getStyle(id);

  console.log("📩 收到訊息:", text);
  console.log("🆔 id:", id);
  console.log("🎨 style:", style);

  /* =========================
     指令優先
  ========================= */

  if (text === "/myid") {
    await safeReply(event.replyToken, event?.source?.userId || "查不到 userId");
    return;
  }

  if (text === "/groupid") {
    await safeReply(event.replyToken, isGroupOrRoom(event) ? id : "這不是群組或聊天室");
    return;
  }

  if (text === "/mystyle") {
    if (!isGroupOrRoom(event)) {
      await safeReply(event.replyToken, "請在群組或聊天室使用");
      return;
    }
    await safeReply(event.replyToken, `目前翻譯風格：${getStyle(id)}`);
    return;
  }

  if (text === "/dict list") {
    if (!isGroupOrRoom(event)) {
      await safeReply(event.replyToken, "請在群組或聊天室使用");
      return;
    }
    await safeReply(event.replyToken, buildDictList(id));
    return;
  }

  /* OWNER 指令 */

  if (isOwner(event)) {
    if (text === "/pending") {
      ensureDBShape();
      if (!db.pending.length) {
        await safeReply(event.replyToken, "沒有待授權群組");
        return;
      }
      await safeReply(event.replyToken, `待授權群組：\n\n${db.pending.join("\n")}`);
      return;
    }

    if (text === "/approve") {
      if (!isGroupOrRoom(event)) {
        await safeReply(event.replyToken, "請在群組或聊天室使用");
        return;
      }
      approveGroup(id);
      await safeReply(event.replyToken, "✅ 群組授權成功");
      return;
    }

    if (text === "/reject") {
      if (!isGroupOrRoom(event)) {
        await safeReply(event.replyToken, "請在群組或聊天室使用");
        return;
      }

      rejectGroup(id);
      const ok = await safeReply(event.replyToken, "❌ 已拒絕並退出");

      if (ok) {
        try {
          if (event.source.type === "group") {
            await client.leaveGroup(id);
          } else if (event.source.type === "room") {
            await client.leaveRoom(id);
          }
        } catch (e) {
          console.error("❌ 離開群組/聊天室失敗:", e?.message || e);
        }
      }
      return;
    }

    if (text.startsWith("/style ")) {
      if (!isGroupOrRoom(event)) {
        await safeReply(event.replyToken, "請在群組或聊天室使用");
        return;
      }

      const nextStyle = text.replace("/style ", "").trim();
      const allowedStyles = [
        "auto",
        "precise",
        "casual",
        "romance",
        "nightlife",
        "work",
        "feminine",
        "masculine"
      ];

      if (!allowedStyles.includes(nextStyle)) {
        await safeReply(
          event.replyToken,
          "可用風格：\nauto\nprecise\ncasual\nromance\nnightlife\nwork\nfeminine\nmasculine"
        );
        return;
      }

      setStyle(id, nextStyle);
      await safeReply(event.replyToken, `✅ 已切換翻譯風格：${nextStyle}`);
      return;
    }

    if (text.startsWith("/dict add ")) {
      if (!isGroupOrRoom(event)) {
        await safeReply(event.replyToken, "請在群組或聊天室使用");
        return;
      }

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
      if (!isGroupOrRoom(event)) {
        await safeReply(event.replyToken, "請在群組或聊天室使用");
        return;
      }

      const source = text.replace("/dict del ", "").trim();

      if (!source) {
        await safeReply(event.replyToken, "格式錯誤\n請使用：/dict del 原文");
        return;
      }

      const ok = deleteDict(id, source);
      await safeReply(event.replyToken, ok ? `✅ 已刪除：${source}` : "⚠️ 找不到這筆詞典");
      return;
    }
  }

  /* 未授權群組，禁止翻譯 */

  if (isGroupOrRoom(event) && !isAllowed(id)) {
    await safeReply(event.replyToken, "⛔ 此群組尚未授權");
    return;
  }

  /* 其他 / 指令不處理也不翻譯 */

  if (text.startsWith("/")) {
    console.log("⚠️ 未知指令，略過翻譯:", text);
    return;
  }

  /* =========================
     翻譯流程
  ========================= */

  const dict = getDict(id);

  if (dict[text]) {
    console.log("📚 命中自訂詞典");
    await safeReply(event.replyToken, dict[text]);
    return;
  }

  const lang = detectLang(text);

  if (lang === "th") {
    const fast = thaiFast(text);
    if (fast) {
      console.log("⚡ 命中泰文快翻");
      await safeReply(event.replyToken, fast);
      return;
    }
  }

  if (lang === "zh") {
    const fast = zhFast(text);
    if (fast) {
      console.log("⚡ 命中中文快翻");
      await safeReply(event.replyToken, fast);
      return;
    }
  }

  let target = "繁體中文";
  if (lang === "zh") target = "泰文";
  if (lang === "th") target = "繁體中文";

  console.log("🧠 準備送 OpenAI，目標語言:", target);

  let result = await translateSmart(text, target, style, lang);

  if (!result) {
    console.log("⚠️ OpenAI 最終失敗，使用 fallback");
    result = fallbackMessage(lang);
  }

  console.log("📤 準備回覆:", result);
  await safeReply(event.replyToken, result);
}

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

    if (event.type === "join") {
      await handleJoin(event);
      return;
    }

    if (event.type !== "message") return;
    if (event.message?.type !== "text") return;

    await handleTextMessage(event);
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
  console.log(`🚀 BOT v4.5 RUNNING ON PORT ${PORT}`);
});
