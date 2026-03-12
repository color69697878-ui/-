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

if (!Array.isArray(groupDB.allowed)) groupDB.allowed = [];
if (!Array.isArray(groupDB.pending)) groupDB.pending = [];
if (!groupDB.styles || typeof groupDB.styles !== "object") groupDB.styles = {};

saveJSON(GROUP_DB_FILE, groupDB);

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
   判斷是否像正常可翻譯句子
========================= */

function looksLikeTranslatableText(text) {
  const t = text.trim();
  if (!t) return false;

  const hasChinese = /[\u4E00-\u9FFF]/.test(t);
  const hasThai = /[\u0E00-\u0E7F]/.test(t);
  const hasEnglish = /[a-zA-Z]/.test(t);
  const hasDigits = /\d/.test(t);

  // 純數字 / 純符號 / 純編號
  if (/^[\d\s/._\-:+]+$/.test(t)) return false;

  // 很短的英文+數字組合，像 In6 / A12 / B7
  if (/^[a-zA-Z]{1,3}\d{1,4}$/i.test(t)) return false;

  // 很短的代碼格式，像 in6-1 / a12/b / m3.5
  if (/^[a-zA-Z0-9/_\-.:\s]{1,12}$/i.test(t) && hasDigits && !hasChinese && !hasThai) {
    const words = t.match(/[a-zA-Z]+/g) || [];
    if (words.length <= 1) return false;
  }

  // 中文或泰文通常可翻
  if (hasChinese || hasThai) return true;

  // 英文至少要像一句短語
  if (hasEnglish) {
    const words = t.match(/[a-zA-Z]+/g) || [];
    if (words.length >= 2) return true;
    return false;
  }

  return false;
}

/* =========================
   數字 / 代碼前綴抽取
========================= */

function extractLeadingCode(text) {
  const t = text.trim();

  // 抓前綴代碼，例如：
  // 2030/60/1/2700 客人上樓 黑色
  // IN6 ลูกค้าขึ้นไปข้างบน
  const match = t.match(/^([A-Za-z0-9][A-Za-z0-9/_\-.:]*)(\s+)(.+)$/);

  if (!match) {
    return { code: "", body: t };
  }

  const [, code, , body] = match;

  // 單純英文單字不當代碼，例如 hello world
  const looksLikeCode =
    /\d/.test(code) ||
    /[\/_.:-]/.test(code) ||
    /^[A-Za-z]{1,3}\d{1,4}$/i.test(code);

  if (!looksLikeCode) {
    return { code: "", body: t };
  }

  return { code, body: body.trim() };
}

/* =========================
   語言判斷
========================= */

function detectLang(text) {
  if (/[\u0E00-\u0E7F]/.test(text)) return "th";
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh";
  return "en";
}

function targetLang(source) {
  if (source === "zh") return "泰文";
  if (source === "th") return "繁體中文";
  return "繁體中文和泰文";
}

/* =========================
   風格提示詞
========================= */

function buildStyleInstructions(style) {
  const common = `
你是頂級中英泰聊天翻譯專家，尤其擅長把中文翻成超自然泰文，以及把泰文翻成超自然中文。

硬規則：
1. 只輸出翻譯結果
2. 不要解釋
3. 不要加原文
4. 不要加前言或結尾
5. 不要混用語言
6. 每一行只能是一種語言
7. 中文只能用中文
8. 泰文只能用泰文
9. 英文只能用英文
10. 如果要輸出兩種語言，請一行一種語言
11. 嚴禁在泰文句子中混入中文
12. 嚴禁在中文句子中混入泰文

翻譯原則：
13. 不要逐字直譯
14. 要根據上下文重組語序
15. 要像母語者自然聊天
16. 保留原本情緒與語氣
17. 中文優先用台灣日常聊天說法
18. 泰文優先用泰國人日常聊天說法
19. 英文優先用自然簡單口語

中文 → 泰文 特別要求：
20. 必須像泰國人จริงๆ在 LINE 聊天
21. 優先使用自然短句
22. 避免教科書語氣
23. 避免過度正式
24. 可省略不必要主詞，只要意思清楚自然

泰文 → 中文 特別要求：
25. 不要保留泰文語序
26. 必須先理解意思，再翻成自然中文
27. 中文要像台灣人聊天，不要出現怪句

精準詞義規則：
28. 泰文中的「ออก / ออกมา / ออกไป」不可固定翻法，必須依上下文判斷是：
    離開 / 出去 / 出來 / 到場 / 走了 / 去了
29. 如果原意是離開、出去、走掉，就必須翻成：
    離開 / 出去 / 走了
    不可以錯翻成「出來」
30. 如果原意是出現、到場、出來上班、出來見人，才可以翻成：
    出來 / 到場 / 來了
31. 「ไป / มา / กลับ / ส่ง / รับ」都必須依上下文判斷，不可固定單一翻法
32. 優先保留真正語意，不要為了口語化改變方向性意思

數字與代碼保留規則：
33. 原文中的所有數字、編號、代碼、斜線格式、時間格式都必須完整保留
34. 例如 2030/60/1/2700 必須原樣保留
35. 不可刪除、不可改寫、不可省略
36. 如果原文是「代碼 + 句子」，翻譯時要保留代碼，再翻譯後面的句子
37. 不可以因為口語化而省略數字或代碼

輸出格式規則：
38. 如果要求翻成「繁體中文和泰文」，第一行繁體中文，第二行泰文
39. 如果要求翻成「泰文」，只輸出泰文
40. 如果要求翻成「繁體中文」，只輸出繁體中文
`;

  const styles = {
    auto: `
風格模式：自動
請根據內容自動判斷要用哪種語氣：
- 日常聊天 → 口語自然
- 感情聊天 → 柔和自然
- 夜生活 → 懂場景但不浮誇
- 工作內容 → 清楚自然略正式
`,
    casual: `
風格模式：日常聊天
請翻得像朋友在 LINE 上聊天，簡單、自然、口語。
`,
    romance: `
風格模式：感情聊天
請保留曖昧、撒嬌、委屈、生氣、冷淡等情緒。
`,
    nightlife: `
風格模式：夜生活
請使用夜生活、酒吧、陪酒、交際場合常見的自然聊天語氣，
但不能因場景而亂改方向詞意思。
`,
    work: `
風格模式：工作正式
請清楚、禮貌、自然，不要太隨便，也不要過度書面。
`,
    feminine: `
風格模式：女生聊天
語氣柔和、自然、日常，不要太做作。
`,
    masculine: `
風格模式：男生聊天
語氣自然、直接、口語，不要太彆扭。
`
  };

  return common + "\n" + (styles[style] || styles.auto);
}

/* =========================
   v5.2 安靜翻譯引擎
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
          content: `請把下面這句翻譯成${lang}，用超自然聊天口語：${text}`
        }
      ]
    });

    const result = r.choices[0].message.content.trim();

    if (!result) return "";

    setCachedTranslation(text, lang, style, result);
    return result;

  } catch (err) {
    console.error("❌ OPENAI ERROR:", err);
    return "";
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

    if (event.type !== "message") return;
    if (event.message.type !== "text") return;

    const text = event.message.text.trim();
    const userId = event.source.userId;
    const id = getId(event);

    console.log("📨 message:", text);

    /* 指令優先 */

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

    /* OWNER 管理指令 */

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

    /* 未授權群組限制 */

    if (isGroupOrRoom(event) && !isAllowed(id)) {
      return reply(event, "⛔ 此群組尚未授權");
    }

    /* 其他斜線指令不翻譯、不回應 */

    if (text.startsWith("/")) {
      return;
    }

    /* 智慧聊天過濾器 */

    if (shouldIgnoreMessage(text)) {
      console.log("🙈 忽略無意義訊息:", text);
      return;
    }

    /* 不像正常句子就安靜 */

    if (!looksLikeTranslatableText(text)) {
      console.log("🙈 看起來不像正常句子，略過:", text);
      return;
    }

    /* 抽取前綴代碼 */

    const { code, body } = extractLeadingCode(text);

    if (!body || !looksLikeTranslatableText(body)) {
      console.log("🙈 代碼後沒有可翻譯句子，略過:", text);
      return;
    }

    /* 智慧翻譯 */

    const source = detectLang(body);
    const target = targetLang(source);
    const style = isGroupOrRoom(event) ? getStyle(id) : "auto";

    const translatedBody = await translate(body, target, style);

    if (!translatedBody || !translatedBody.trim()) {
      console.log("🙈 無翻譯結果，略過回覆:", text);
      return;
    }

    const finalResult = code
      ? translatedBody
          .split("\n")
          .map(line => `${code} ${line.trim()}`)
          .join("\n")
      : translatedBody;

    return reply(event, finalResult);

  } catch (err) {
    console.error("❌ HANDLE EVENT ERROR:", err);
    return;
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
