import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

console.log("🚀 BOT STARTING");

const app = express();

/* =========================
   LINE 設定
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
   OWNER
========================= */

const OWNER = process.env.OWNER_USER_ID;

/* =========================
   資料庫檔案
========================= */

const GROUP_DB_FILE = "./groups.json";
const CACHE_DB_FILE = "./cache.json";

/* =========================
   讀寫工具
========================= */

function loadJSON(file, fallback) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`❌ ${file} 讀取失敗，改用預設值:`, err);
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

/* =========================
   群組授權資料
========================= */

let groupDB = loadJSON(GROUP_DB_FILE, {
  allowed: [],
  pending: [],
  styles: {}
});

function isAllowed(id) {
  return groupDB.allowed.includes(id);
}

function addPending(id) {
  if (!id) return;
  if (!groupDB.pending.includes(id)) {
    groupDB.pending.push(id);
    saveJSON(GROUP_DB_FILE, groupDB);
  }
}

function approveGroup(id) {
  if (!id) return;
  groupDB.pending = groupDB.pending.filter(x => x !== id);
  if (!groupDB.allowed.includes(id)) {
    groupDB.allowed.push(id);
  }
  if (!groupDB.styles[id]) {
    groupDB.styles[id] = "auto";
  }
  saveJSON(GROUP_DB_FILE, groupDB);
}

function rejectGroup(id) {
  if (!id) return;
  groupDB.pending = groupDB.pending.filter(x => x !== id);
  saveJSON(GROUP_DB_FILE, groupDB);
}

function getStyle(id) {
  if (!id) return "auto";
  return groupDB.styles?.[id] || "auto";
}

function setStyle(id, style) {
  if (!id) return;
  if (!groupDB.styles) groupDB.styles = {};
  groupDB.styles[id] = style;
  saveJSON(GROUP_DB_FILE, groupDB);
}

/* =========================
   翻譯快取資料
========================= */

let cacheDB = loadJSON(CACHE_DB_FILE, {});

function getCacheKey(text, lang, style) {
  return `${style}|||${lang}|||${text}`;
}

function getCachedTranslation(text, lang, style) {
  const key = getCacheKey(text, lang, style);
  return cacheDB[key] || null;
}

function setCachedTranslation(text, lang, style, result) {
  const key = getCacheKey(text, lang, style);
  cacheDB[key] = result;
  saveJSON(CACHE_DB_FILE, cacheDB);
}

/* =========================
   工具
========================= */

function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text
  });
}

function getId(event) {
  return event.source.groupId || event.source.roomId || null;
}

function isGroupOrRoom(event) {
  return event.source.type === "group" || event.source.type === "room";
}

/* =========================
   智慧聊天過濾器
========================= */

function shouldIgnoreMessage(text) {
  const t = text.trim();
  if (!t) return true;

  const hasLettersOrNumbers = /[\p{L}\p{N}]/u.test(t);
  if (!hasLettersOrNumbers) return true;

  const lower = t.toLowerCase();

  const ignoreList = new Set([
    "ok", "okay", "k", "kk", "okok",
    "yes", "yeah", "yep", "no", "nope",
    "lol", "lmao", "haha", "hah", "555", "5555",
    "hmm", "um", "umm", "uh", "uhh",
    "hi", "hello", "yo",
    "恩", "嗯", "喔", "哦", "好", "嗯嗯", "哈哈", "呵呵",
    "好喔", "好哦", "恩恩", "收到",
    "โอเค", "อืม", "อือ", "อ่า", "เออ", "ใช่", "จ้า", "ครับ", "ค่ะ"
  ]);

  if (ignoreList.has(lower)) return true;
  if (ignoreList.has(t)) return true;
  if (t.length <= 1) return true;

  return false;
}

/* =========================
   語言判斷
========================= */

function detectLang(text) {
  if (/[\u0E00-\u0E7F]/.test(text)) return "th"; // 泰文
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh"; // 中文
  return "en"; // 其他視為英文
}

function targetLang(source) {
  if (source === "zh") return "英文和泰文";
  if (source === "en") return "繁體中文和泰文";
  if (source === "th") return "繁體中文和英文";
  return "繁體中文";
}

/* =========================
   風格提示詞
========================= */

function buildStyleInstructions(style) {
  const common = `
你是頂級中英泰聊天翻譯專家，特別擅長泰文翻成自然中文，也擅長中文翻成自然泰文。

翻譯硬規則：
1. 只輸出翻譯結果
2. 不要解釋
3. 不要加原文
4. 不要加前言或結尾
5. 可以重組語序
6. 不要逐字直譯
7. 保留原本意思與情緒
8. 中文要像台灣人真的會說的話
9. 泰文要像泰國人真的會說的話
10. 英文要自然簡單，不要教科書感
11. 如果輸出兩種語言，請分成兩行，一行一種語言
12. 不要自稱 AI，不要提知識截止時間，不要回答翻譯以外內容

泰文翻中文特別要求：
13. 不要照泰文語序硬翻成怪中文
14. 必須先理解意思，再改寫成自然中文
15. 避免出現奇怪句型，例如：
「我點了餐，不知道他要把我送去哪裡」
應優化成：
「我點了外送，但不知道會送到哪」

中文翻泰文特別要求：
16. 泰文優先使用自然聊天語氣
17. 避免過於正式、教科書、逐字翻譯
18. 簡短自然比冗長正式更好
`;

  const styles = {
    auto: `
風格模式：自動
請根據內容自動判斷要用哪種語氣：
- 日常聊天 → 口語
- 感情聊天 → 柔和、自然
- 夜生活 / 陪酒 / 酒吧 → 自然、懂行內語氣
- 工作內容 → 清楚、自然、略正式
- 女生聊天 → 柔和、自然
- 男生聊天 → 直接、自然
`,
    casual: `
風格模式：日常聊天
請翻得像朋友在 LINE 上聊天，簡單、自然、口語。
`,
    romance: `
風格模式：感情聊天
請保留曖昧、撒嬌、委屈、生氣、在意、冷淡等情緒。
語氣要像情侶或曖昧對象聊天，自然但不要肉麻過頭。
`,
    nightlife: `
風格模式：夜生活
請使用夜生活、酒吧、陪酒、交際場合常見的自然聊天語氣。
泰文要像真的在夜生活圈聊天，不要太正式。
中文也要自然好懂，不要生硬。
`,
    work: `
風格模式：工作正式
請清楚、禮貌、自然，不要過度書面，但也不要太隨便。
適合工作對話、安排時間、交代事情、客服、商務往來。
`,
    feminine: `
風格模式：女生聊天
語氣柔和、自然、帶一點女生日常聊天感。
但不要刻意裝可愛，也不要過頭。
`,
    masculine: `
風格模式：男生聊天
語氣自然、直接、口語，不要太彆扭，不要太正式。
`
  };

  return common + "\n" + (styles[style] || styles.auto);
}

/* =========================
   翻譯 v4
========================= */

async function translate(text, lang, style = "auto") {
  const cached = getCachedTranslation(text, lang, style);
  if (cached) {
    console.log("⚡ 使用快取翻譯:", text);
    return cached;
  }

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.35,
      messages: [
        {
          role: "system",
          content: buildStyleInstructions(style)
        },
        {
          role: "user",
          content: `請把下面這句翻譯成${lang}，用自然聊天口語：${text}`
        }
      ]
    });

    const result = r.choices[0].message.content.trim();
    setCachedTranslation(text, lang, style, result);
    return result;

  } catch (err) {
    console.error("❌ OPENAI ERROR:", err);
    return "⚠️ 翻譯暫時不可用";
  }
}

/* =========================
   WEBHOOK
========================= */

app.post("/webhook", line.middleware(config), async (req, res) => {
  console.log("📩 webhook event received");

  try {
    await Promise.all(req.body.events.map(handleEvent));
  } catch (err) {
    console.error("❌ WEBHOOK ERROR:", err);
  }

  res.sendStatus(200);
});

/* =========================
   主事件處理
========================= */

async function handleEvent(event) {
  try {
    /* ======================
       BOT 被加入群組 / 聊天室
    ====================== */
    if (event.type === "join") {
      const id = getId(event);

      if (!isAllowed(id)) {
        addPending(id);

        return reply(
          event,
          `🔐 此群組尚未授權

請管理員輸入：

/approve`
        );
      }

      return reply(event, "✅ 此群組已授權");
    }

    /* ======================
       非文字訊息忽略
    ====================== */
    if (event.type !== "message") return;
    if (event.message.type !== "text") return;

    const text = event.message.text.trim();
    const userId = event.source.userId;
    const id = getId(event);

    console.log("📨 message:", text);

    /* ======================
       指令優先
    ====================== */

    if (text === "/myid") {
      return reply(event, userId || "查不到 userId");
    }

    if (text === "/groupid") {
      return reply(event, id || "這不是群組或聊天室");
    }

    if (text === "/mystyle") {
      if (!isGroupOrRoom(event)) {
        return reply(event, "請在群組或聊天室使用");
      }
      return reply(event, `目前翻譯風格：${getStyle(id)}`);
    }

    /* ======================
       OWNER 管理指令
    ====================== */

    if (userId === OWNER) {
      if (text === "/pending") {
        if (groupDB.pending.length === 0) {
          return reply(event, "沒有待授權群組");
        }

        return reply(
          event,
          "待授權群組：\n\n" + groupDB.pending.join("\n")
        );
      }

      if (text === "/approve") {
        if (!isGroupOrRoom(event)) {
          return reply(event, "請在群組或聊天室使用");
        }

        approveGroup(id);
        return reply(event, "✅ 群組授權成功");
      }

      if (text === "/reject") {
        if (!isGroupOrRoom(event)) {
          return reply(event, "請在群組或聊天室使用");
        }

        rejectGroup(id);

        await reply(event, "❌ 已拒絕並退出");

        if (event.source.type === "group") {
          await client.leaveGroup(id);
        } else if (event.source.type === "room") {
          await client.leaveRoom(id);
        }

        return;
      }

      if (text.startsWith("/style ")) {
        if (!isGroupOrRoom(event)) {
          return reply(event, "請在群組或聊天室使用");
        }

        const style = text.replace("/style ", "").trim();
        const allowedStyles = ["auto", "casual", "romance", "nightlife", "work", "feminine", "masculine"];

        if (!allowedStyles.includes(style)) {
          return reply(
            event,
            "可用風格：\nauto\ncasual\nromance\nnightlife\nwork\nfeminine\nmasculine"
          );
        }

        setStyle(id, style);
        return reply(event, `✅ 已切換翻譯風格：${style}`);
      }
    }

    /* ======================
       未授權群組限制
    ====================== */

    if (isGroupOrRoom(event) && !isAllowed(id)) {
      return reply(event, "⛔ 此群組尚未授權");
    }

    /* ======================
       其他斜線指令不翻譯
    ====================== */

    if (text.startsWith("/")) {
      return;
    }

    /* ======================
       智慧聊天過濾器
    ====================== */

    if (shouldIgnoreMessage(text)) {
      console.log("🙈 忽略無意義訊息:", text);
      return;
    }

    /* ======================
       v4 終極翻譯
    ====================== */

    const source = detectLang(text);
    const target = targetLang(source);
    const style = isGroupOrRoom(event) ? getStyle(id) : "auto";

    const result = await translate(text, target, style);

    return reply(event, result);

  } catch (err) {
    console.error("❌ HANDLE EVENT ERROR:", err);

    if (event.replyToken) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "⚠️ 系統暫時異常"
      });
    }
  }
}

/* =========================
   健康檢查
========================= */

app.get("/", (req, res) => {
  res.send("BOT OK");
});

/* =========================
   啟動
========================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 BOT RUNNING ON PORT", PORT);
});
