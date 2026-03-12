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

function getId(event) {
  return event.source.groupId || event.source.roomId || null;
}

function isGroupOrRoom(event) {
  return event.source.type === "group" || event.source.type === "room";
}

function buildSender(profile) {
  if (!profile || !profile.displayName) return undefined;

  const sender = {
    name: profile.displayName
  };

  if (profile.pictureUrl) {
    sender.iconUrl = profile.pictureUrl;
  }

  return sender;
}

async function reply(event, text, senderProfile = null) {
  const message = {
    type: "text",
    text
  };

  const sender = buildSender(senderProfile);
  if (sender) {
    message.sender = sender;
  }

  return client.replyMessage(event.replyToken, message);
}

/* =========================
   取得發言者資料
========================= */

async function getSenderProfile(event) {
  try {
    const userId = event.source.userId;
    if (!userId) return null;

    if (event.source.type === "user") {
      return await client.getProfile(userId);
    }

    if (event.source.type === "group") {
      return await client.getGroupMemberProfile(event.source.groupId, userId);
    }

    if (event.source.type === "room") {
      return await client.getRoomMemberProfile(event.source.roomId, userId);
    }

    return null;
  } catch (err) {
    console.error("⚠️ 取得 sender profile 失敗:", err?.message || err);
    return null;
  }
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
    "lol", "lmao", "haha", "hah", "555", "5555",
    "hmm", "um", "umm", "uh", "uhh",
    "hi", "hello", "yo",
    "恩", "嗯", "喔", "哦", "嗯嗯", "哈哈", "呵呵",
    "好喔", "好哦", "恩恩",
    "โอเค", "อืม", "อือ", "อ่า", "เออ", "จ้า", "ครับ", "ค่ะ"
  ]);

  if (ignoreList.has(lower)) return true;
  if (ignoreList.has(t)) return true;

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

  if (/^[\d\s/._\-:+]+$/.test(t)) return false;
  if (/^[a-zA-Z]{1,3}\d{1,4}$/i.test(t)) return false;

  if (hasChinese) return true;
  if (hasThai) return true;

  if (hasEnglish) {
    if (hasDigits && t.length <= 12) return false;
    return true;
  }

  return false;
}

/* =========================
   數字 / 代碼前綴抽取
========================= */

function extractLeadingCode(text) {
  const t = text.trim();

  const match = t.match(/^([A-Za-z0-9][A-Za-z0-9/_\-.:]*)(\s+)(.+)$/);

  if (!match) {
    return { code: "", body: t };
  }

  const [, code, , body] = match;

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
你是頂級中英泰聊天翻譯專家，尤其擅長把中文翻成超自然泰文，以及把泰文翻成超自然中文。你也擅長修正聊天中的拼字錯誤、漏字、簡寫、口語寫法，再進行翻譯。

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
20. 口語化不能改變原意
21. 如果自然口語和原意衝突，優先保留原意

拼字修正與語意理解規則：
22. 如果原文有明顯錯字、漏字、簡寫、打錯字、聊天式亂打，先自動理解最可能的原意，再翻譯
23. 不要把明顯錯字照抄進翻譯
24. 例如泰文像「ฉันย่านร้าน」這種不自然寫法，要先推測最可能原意，例如「ฉันอยู่ร้าน」，再翻譯
25. 如果英文有小拼字錯誤，例如 customer / custumer / costumer，要根據上下文理解後再翻譯
26. 中文若有少字、錯字，也要先理解語意再翻譯

中文 → 泰文 特別要求：
27. 必須像泰國人真的在 LINE 聊天
28. 優先使用自然短句
29. 避免教科書語氣
30. 避免過度正式
31. 可省略不必要主詞，只要意思清楚自然

泰文 → 中文 特別要求：
32. 不要保留泰文語序
33. 必須先理解意思，再翻成自然中文
34. 中文要像台灣人聊天，不要出現怪句

精準詞義規則：
35. 泰文中的「ออก / ออกมา / ออกไป」不可固定翻法，必須依上下文判斷是：
    離開 / 出去 / 出來 / 到場 / 走了 / 去了
36. 如果原意是離開、出去、走掉，就必須翻成：
    離開 / 出去 / 走了
    不可以錯翻成「出來」
37. 如果原意是出現、到場、出來上班、出來見人，才可以翻成：
    出來 / 到場 / 來了
38. 「ไป / มา / กลับ / ส่ง / รับ」都必須依上下文判斷，不可固定單一翻法
39. 優先保留真正語意，不要為了口語化改變方向性意思

數字與代碼保留規則：
40. 原文中的所有數字、編號、代碼、斜線格式、時間格式都必須完整保留
41. 例如 2030/60/1/2700 必須原樣保留
42. 不可刪除、不可改寫、不可省略
43. 如果原文是「代碼 + 句子」，翻譯時要保留代碼，再翻譯後面的句子
44. 不可以因為口語化而省略數字或代碼

輸出格式規則：
45. 如果要求翻成「繁體中文和泰文」，第一行繁體中文，第二行泰文
46. 如果要求翻成「泰文」，只輸出泰文
47. 如果要求翻成「繁體中文」，只輸出繁體中文
`;

  const styles = {
    auto: `
風格模式：自動
請根據內容自動判斷要用哪種語氣：
- 日常聊天 → 口語自然
- 感情聊天 → 柔和自然
- 夜生活 → 懂場景但不浮誇
- 工作內容 → 清楚自然略正式
- 容易有歧義或語意細膩的句子 → 優先保留原意
`,
    precise: `
風格模式：精準
請以原意優先。
可以自然，但不可以為了順口而改變語意。
遇到感情句、抽象句、容易誤解的句子時，優先選擇最貼近原意的翻法。
`,
    casual: `
風格模式：日常聊天
請翻得像朋友在 LINE 上聊天，簡單、自然、口語。
但仍然不可偏離原意。
`,
    romance: `
風格模式：感情聊天
請保留曖昧、撒嬌、委屈、生氣、冷淡等情緒。
語氣自然柔和，但仍要保留原意。
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
   翻譯引擎
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
      temperature: style === "precise" ? 0.15 : 0.35,
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

        if (!allowedStyles.includes(style)) {
          return reply(
            event,
            "可用風格：\nauto\nprecise\ncasual\nromance\nnightlife\nwork\nfeminine\nmasculine"
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

    const senderProfile = await getSenderProfile(event);

    return reply(event, finalResult, senderProfile);

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
