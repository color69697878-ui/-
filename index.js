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
    "哈哈", "呵呵",
    "โอเค", "อืม", "อือ", "อ่า", "เออ"
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
   中文短詞快翻
========================= */

function translateChineseChatWord(text) {
  const t = text.trim();

  const dict = {
    "嗯": "อืม",
    "恩": "อืม",
    "喔": "อ๋อ",
    "哦": "อ๋อ",
    "嗯嗯": "อืม",
    "好": "โอเค",
    "是": "ใช่",
    "對": "ใช่",
    "可以": "ได้",
    "去": "ไป",
    "來": "มา"
  };

  return dict[t] || "";
}

/* =========================
   上下文判斷
========================= */

function isSleepQuestion(text) {
  const t = text.trim();
  const patterns = [
    /沒睡/,
    /有没有睡/,
    /有沒有睡/,
    /睡了嗎/,
    /昨晚.*睡/,
    /เมื่อคืน.*นอน/,
    /ได้นอน/,
    /ยังไม่นอน/,
    /นอนหรือ/,
    /นอนไหม/
  ];
  return patterns.some((re) => re.test(t));
}

function isConfirmationQuestion(text) {
  const t = text.trim();
  const patterns = [
    /對嗎/,
    /是嗎/,
    /是不是/,
    /有.*嗎/,
    /今天有/,
    /今天.*對吧/,
    /ใช่ไหม/,
    /หรือเปล่า/,
    /ไหม/,
    /มั้ย/
  ];
  return patterns.some((re) => re.test(t));
}

/* =========================
   泰文聊天短詞 + 動作語境快翻
========================= */

function translateThaiChatWord(text, previousText = "") {
  const t = text.trim();

  if (["นอน", "นอนค่ะ", "นอนครับ"].includes(t) && isSleepQuestion(previousText)) {
    return "有睡";
  }

  if (["ค่ะ", "คะ", "ครับ"].includes(t) && isConfirmationQuestion(previousText)) {
    return "對";
  }

  if (["ใช่ค่ะ", "ใช่ครับ"].includes(t)) {
    return "對";
  }

  const directDict = {
    "ค่ะ": "好",
    "คะ": "好",
    "ครับ": "好",
    "ยัง": "還沒",
    "ยังไม่": "還沒",
    "ใช่": "對",
    "ได้": "可以",
    "ไม่": "不",
    "มา": "來",
    "ไป": "去",
    "โอเค": "好",

    "มาแล้ว": "來了",
    "ไปแล้ว": "去了",
    "กลับแล้ว": "回去了",
    "ออกแล้ว": "出去了",
    "ออกไปแล้ว": "離開了",
    "ออกมาแล้ว": "出來了",

    "ไปดิ": "去啊",
    "มาดิ": "來啊",
    "ไปก่อน": "先走了",
    "มาก่อน": "先來了",
    "ไปไหน": "要去哪",
    "มาไหม": "要來嗎",
    "ไปไหม": "要去嗎",
    "ไม่ไป": "不去",
    "ไม่มา": "不來",

    "นอน": "睡",
    "นอนค่ะ": "睡了",
    "นอนครับ": "睡了"
  };

  if (directDict[t]) return directDict[t];

  const actionMap = {
    "ไปค่ะ": "會去",
    "ไปครับ": "會去",
    "มาค่ะ": "會來",
    "มาครับ": "會來",
    "กลับค่ะ": "會回去",
    "กลับครับ": "會回去",
    "ได้ค่ะ": "可以",
    "ได้ครับ": "可以",
    "ยังค่ะ": "還沒",
    "ยังครับ": "還沒",
    "ไม่ค่ะ": "不要",
    "ไม่ครับ": "不要",
    "ไปนะ": "我去喔",
    "มานะ": "我來喔"
  };

  return actionMap[t] || "";
}

/* =========================
   英文短詞快翻
========================= */

function translateEnglishChatWord(text) {
  const t = text.trim().toLowerCase();

  const dict = {
    "yes": "對\nใช่",
    "no": "不要\nไม่",
    "black": "黑色\nสีดำ",
    "white": "白色\nสีขาว",
    "up": "上去\nขึ้นไป",
    "down": "下去\nลงไป",
    "come": "來\nมา",
    "go": "去\nไป",
    "ok": "好\nโอเค"
  };

  return dict[t] || "";
}

/* =========================
   清理中文多餘語助詞
========================= */

function cleanupChineseTone(text) {
  return text
    .replace(/^好啦$/g, "好")
    .replace(/^可以啦$/g, "可以")
    .replace(/^對啦$/g, "對")
    .replace(/^會去啦$/g, "會去")
    .replace(/^會來啦$/g, "會來")
    .replace(/^去啦$/g, "去")
    .replace(/^來啦$/g, "來")
    .replace(/^還沒啦$/g, "還沒")
    .replace(/^不要啦$/g, "不要")
    .replace(/^是啦$/g, "是");
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
22. 必須做語境理解，不要只看單字
23. 模糊詞、方向詞、狀態詞要依整句上下文判斷
24. 中文翻譯請避免無故添加「啦、呀、呢、喔、哦」等語助詞
25. 只有原文明顯帶有撒嬌、強烈口語、催促或特定情緒時，才可少量加入語助詞
26. 若原文只是普通回答、普通陳述、普通同意，請用乾淨自然的中文，不要自行加「啦」

拼字修正與語意理解規則：
27. 如果原文有明顯錯字、漏字、簡寫、打錯字、聊天式亂打，先自動理解最可能的原意，再翻譯
28. 不要把明顯錯字照抄進翻譯
29. 例如泰文像「ฉันย่านร้าน」這種不自然寫法，要先推測最可能原意，例如「ฉันอยู่ร้าน」，再翻譯
30. 如果英文有小拼字錯誤，例如 customer / custumer / costumer，要根據上下文理解後再翻譯
31. 中文若有少字、錯字，也要先理解語意再翻譯

中文 → 泰文 特別要求：
32. 必須像泰國人真的在 LINE 聊天
33. 優先使用自然短句
34. 避免教科書語氣
35. 避免過度正式
36. 可省略不必要主詞，只要意思清楚自然

泰文 → 中文 特別要求：
37. 不要保留泰文語序
38. 必須先理解意思，再翻成自然中文
39. 中文要像台灣人聊天，不要出現怪句

泰文動作語境規則：
40. 對於泰文中的動作與方向詞，必須依上下文理解：
    - ไป / มา / กลับ
    - ออก / ออกไป / ออกมา
    - ขึ้น / ลง
    - ส่ง / รับ
41. 不可固定翻法，必須看整句語境與對話脈絡判斷
42. 「ไป」單獨作回答時通常是「去」
43. 「ไปค่ะ / ไปครับ」作回答時通常是「會去」
44. 「ไปดิ」通常是「去啊」
45. 「ไปไหน」通常是「要去哪」
46. 「มา」單獨作回答時通常是「來」
47. 「มาค่ะ / มาครับ」作回答時通常是「會來」
48. 「มาดิ」通常是「來啊」
49. 「มาไหม」通常是「要來嗎」
50. 「กลับ」依上下文可為「回去 / 回來」
51. 「ออกไป」通常偏向「出去 / 離開」
52. 「ออกมา」通常偏向「出來」
53. 如果原意是離開、走掉、出去，就不得翻成「出來」
54. 如果原意是出現、到場、出來見人、出來上班，才可翻成「出來 / 到場 / 來了」

泰文聊天短詞規則：
55. 泰文單獨回覆的短詞要依聊天語境翻譯：
    - ยัง → 還沒
    - ค่ะ / คะ / ครับ → 對 / 是 / 好
    - ใช่ → 對
    - ได้ → 可以
56. 如果「ยัง」是單獨回答問題，優先翻成「還沒」，不是「還是」
57. 如果「ค่ะ / ครับ」是在回答確認句、是非題、對嗎這類問題，優先翻成「對」或「是」
58. 如果「ค่ะ / ครับ」只是一般禮貌回覆，才翻成「好」
59. 如果「นอน / นอนค่ะ / นอนครับ」是在回答「有沒有睡」這類問題，優先翻成「有睡 / 睡了」，不是「要睡了」
60. 這些短詞若單獨出現，也要翻譯，不可以省略

細膩語意規則：
61. 如果句子是感情句或抽象句，優先理解整體情感與關係，再翻譯
62. 如果句子像「แต่ฉันอยู่ห่างจากคุณได้ไม่นาน ฉันรู้ตัวฉันดี」
    必須優先理解為「沒辦法離你太久」這種關係語意，
    不可草率翻成「我離你不遠」

數字與代碼保留規則：
63. 原文中的所有數字、編號、代碼、斜線格式、時間格式都必須完整保留
64. 例如 2030/60/1/2700 必須原樣保留
65. 不可刪除、不可改寫、不可省略
66. 如果原文是「代碼 + 句子」，翻譯時要保留代碼，再翻譯後面的句子
67. 不可以因為口語化而省略數字或代碼

輸出格式規則：
68. 如果要求翻成「繁體中文和泰文」，第一行繁體中文，第二行泰文
69. 如果要求翻成「泰文」，只輸出泰文
70. 如果要求翻成「繁體中文」，只輸出繁體中文
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
   v6.5.2 修正版翻譯引擎
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
      temperature: style === "precise" ? 0.1 : 0.25,
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

    let result = r.choices[0].message.content.trim();

    if (!result) return "";

    result = cleanupChineseTone(result);

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

    let previousText = "";
    if (event.message?.quotedMessage?.text) {
      previousText = event.message.quotedMessage.text;
    }

    const bodySource = detectLang(body);

    /* 中文短詞快翻 */

    if (bodySource === "zh") {
      const fastZhWord = translateChineseChatWord(body);
      if (fastZhWord) {
        const senderProfile = await getSenderProfile(event);
        const finalFastResult = code ? `${code} ${fastZhWord}` : fastZhWord;
        return reply(event, finalFastResult, senderProfile);
      }
    }

    /* 泰文聊天短詞 / 動作短句快翻（帶前一句上下文） */

    if (bodySource === "th") {
      const fastThaiWord = translateThaiChatWord(body, previousText);

      if (fastThaiWord) {
        const senderProfile = await getSenderProfile(event);
        const finalFastResult = code ? `${code} ${fastThaiWord}` : fastThaiWord;
        return reply(event, finalFastResult, senderProfile);
      }
    }

    /* 英文短詞快翻 */

    if (bodySource === "en") {
      const fastEnWord = translateEnglishChatWord(body);

      if (fastEnWord) {
        const senderProfile = await getSenderProfile(event);
        const finalFastResult = code
          ? fastEnWord.split("\n").map(line => `${code} ${line}`).join("\n")
          : fastEnWord;
        return reply(event, finalFastResult, senderProfile);
      }
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
