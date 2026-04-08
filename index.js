"use strict";

/**
 * LINE 中泰翻譯機器人 v5.1.6 完整版
 *
 * 功能：
 * 1. 群組授權
 * 2. 群組詞典 / 全域詞典
 * 3. @標記不翻譯
 * 4. emoji 不翻譯
 * 5. 貼圖不翻譯
 * 6. mixed 中泰混雜訊息先略過
 * 7. 保留最近 3 句上下文
 * 8. 中文 -> 泰文使用分段翻譯
 * 9. 強化中文口語時間詞
 * 10. 強化泰文口語句型
 * 11. 型號/代碼 + 中文短詞特殊處理
 * 12. 多行訊息保留原本分行格式
 * 13. 可直接覆蓋使用
 * 14. 修正常見 bug：
 *    - 只翻前面幾個字
 *    - 完全不翻
 *    - 亂解釋型號/代碼
 *    - 多行被併成一行
 *    - 泰文口語意思差很多
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");

// =========================
// 基本設定
// =========================
const PORT = process.env.PORT || 3000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret || !process.env.OPENAI_API_KEY) {
  console.error("缺少必要環境變數：LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET / OPENAI_API_KEY");
  process.exit(1);
}

const ADMIN_USER_ID = process.env.ADMIN_USER_ID || ""; // 可選：設定後只有此 userId 可管理全域詞典
const client = new line.Client(config);
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =========================
// 資料檔
// =========================
const DATA_DIR = path.join(__dirname, "data");
const AUTH_FILE = path.join(DATA_DIR, "groupAuth.json");
const GROUP_DICT_FILE = path.join(DATA_DIR, "groupDict.json");
const GLOBAL_DICT_FILE = path.join(DATA_DIR, "globalDict.json");
const CONTEXT_FILE = path.join(DATA_DIR, "contexts.json");

ensureDir(DATA_DIR);

const state = {
  groupAuth: loadJson(AUTH_FILE, {}),      // { [groupId]: true/false }
  groupDict: loadJson(GROUP_DICT_FILE, {}),// { [groupId]: {source: target} }
  globalDict: loadJson(GLOBAL_DICT_FILE, {}), // {source: target}
  contexts: loadJson(CONTEXT_FILE, {}),    // { [chatKey]: [{role, text, lang, ts}] }
};

// =========================
// 啟動
// =========================
app.get("/", (req, res) => {
  res.status(200).send("LINE 中泰翻譯機器人 v5.1.6 正常運作中");
});

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).end();
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// =========================
// 事件處理
// =========================
async function handleEvent(event) {
  try {
    if (event.type === "join") {
      if (event.source && event.source.type === "group") {
        const gid = event.source.groupId;
        if (!(gid in state.groupAuth)) {
          state.groupAuth[gid] = false; // 預設未授權
          saveAll();
        }
        return safeReply(event.replyToken, "我已加入群組。\n目前此群組翻譯狀態：未授權\n請使用：\n授權開啟\n或\n/auth on");
      }
      return null;
    }

    if (event.type !== "message") return null;
    if (!event.message) return null;

    // 貼圖不翻譯
    if (event.message.type === "sticker") {
      return null;
    }

    if (event.message.type !== "text") return null;

    const text = (event.message.text || "").trim();
    if (!text) return null;

    // 指令處理
    const commandResult = await handleCommand(event, text);
    if (commandResult.handled) {
      return commandResult.promise;
    }

    // 群組授權檢查
    if (event.source.type === "group") {
      const gid = event.source.groupId;
      const enabled = !!state.groupAuth[gid];
      if (!enabled) return null;
    }

    // 判斷是否需要翻譯
    const lang = detectMainLanguage(text);

    // mixed 中泰混雜訊息先略過
    if (lang === "mixed") {
      return null;
    }

    // 沒有中或泰，不翻
    if (lang === "other") {
      return null;
    }

    const targetLang = lang === "zh" ? "th" : "zh";
    const chatKey = getChatKey(event.source);
    const groupId = event.source.type === "group" ? event.source.groupId : "";
    const contextList = getRecentContext(chatKey, 3);

    const translated = await translateMessage({
      text,
      sourceLang: lang,
      targetLang,
      contextList,
      groupId,
    });

    if (!translated || translated.trim() === "" || translated.trim() === text.trim()) {
      // 避免 AI 沒翻或只翻一部分時整體失敗
      return null;
    }

    // 寫入上下文：保留原文與譯文，方便後續理解
    pushContext(chatKey, { role: "user", text, lang });
    pushContext(chatKey, { role: "assistant", text: translated, lang: targetLang });

    return safeReply(event.replyToken, translated);
  } catch (err) {
    console.error("handleEvent error:", err);
    return null;
  }
}

// =========================
// 指令系統
// =========================
async function handleCommand(event, rawText) {
  const text = rawText.trim();
  const source = event.source || {};
  const isGroup = source.type === "group";
  const groupId = isGroup ? source.groupId : "";
  const userId = source.userId || "";

  const lower = text.toLowerCase();

  // -------- 授權 --------
  if (text === "授權開啟" || lower === "/auth on") {
    if (!isGroup) {
      return {
        handled: true,
        promise: safeReply(event.replyToken, "此指令只能在群組中使用。"),
      };
    }
    state.groupAuth[groupId] = true;
    saveAll();
    return {
      handled: true,
      promise: safeReply(event.replyToken, "此群組翻譯已開啟。"),
    };
  }

  if (text === "授權關閉" || lower === "/auth off") {
    if (!isGroup) {
      return {
        handled: true,
        promise: safeReply(event.replyToken, "此指令只能在群組中使用。"),
      };
    }
    state.groupAuth[groupId] = false;
    saveAll();
    return {
      handled: true,
      promise: safeReply(event.replyToken, "此群組翻譯已關閉。"),
    };
  }

  if (text === "授權狀態" || lower === "/auth status") {
    if (!isGroup) {
      return {
        handled: true,
        promise: safeReply(event.replyToken, "此指令只能在群組中使用。"),
      };
    }
    const enabled = !!state.groupAuth[groupId];
    return {
      handled: true,
      promise: safeReply(event.replyToken, `此群組翻譯狀態：${enabled ? "已開啟" : "未開啟"}`),
    };
  }

  // -------- 群組詞典 --------
  // 格式：
  // 詞典新增 原文=譯文
  // /dict add 原文=譯文
  if (text.startsWith("詞典新增 ") || lower.startsWith("/dict add ")) {
    if (!isGroup) {
      return {
        handled: true,
        promise: safeReply(event.replyToken, "群組詞典只能在群組中使用。"),
      };
    }
    const body = text.startsWith("詞典新增 ")
      ? text.slice("詞典新增 ".length)
      : rawText.slice(rawText.toLowerCase().indexOf("/dict add ") + "/dict add ".length);

    const parsed = parseDictPair(body);
    if (!parsed) {
      return {
        handled: true,
        promise: safeReply(event.replyToken, "格式錯誤。\n請使用：詞典新增 原文=譯文"),
      };
    }

    if (!state.groupDict[groupId]) state.groupDict[groupId] = {};
    state.groupDict[groupId][parsed.source] = parsed.target;
    saveAll();

    return {
      handled: true,
      promise: safeReply(event.replyToken, `群組詞典已新增：\n${parsed.source} => ${parsed.target}`),
    };
  }

  if (text.startsWith("詞典刪除 ") || lower.startsWith("/dict del ")) {
    if (!isGroup) {
      return {
        handled: true,
        promise: safeReply(event.replyToken, "群組詞典只能在群組中使用。"),
      };
    }
    const key = text.startsWith("詞典刪除 ")
      ? text.slice("詞典刪除 ".length).trim()
      : rawText.slice(rawText.toLowerCase().indexOf("/dict del ") + "/dict del ".length).trim();

    if (!key) {
      return {
        handled: true,
        promise: safeReply(event.replyToken, "請提供要刪除的詞條。\n例如：詞典刪除 灰色"),
      };
    }

    if (state.groupDict[groupId] && key in state.groupDict[groupId]) {
      delete state.groupDict[groupId][key];
      saveAll();
      return {
        handled: true,
        promise: safeReply(event.replyToken, `群組詞典已刪除：${key}`),
      };
    }
    return {
      handled: true,
      promise: safeReply(event.replyToken, `群組詞典找不到：${key}`),
    };
  }

  if (text === "詞典列表" || lower === "/dict list") {
    if (!isGroup) {
      return {
        handled: true,
        promise: safeReply(event.replyToken, "群組詞典只能在群組中使用。"),
      };
    }
    const dict = state.groupDict[groupId] || {};
    const entries = Object.entries(dict);
    const out = entries.length
      ? "群組詞典：\n" + entries.map(([k, v]) => `${k} => ${v}`).join("\n")
      : "群組詞典目前為空。";
    return {
      handled: true,
      promise: safeReply(event.replyToken, out),
    };
  }

  // -------- 全域詞典 --------
  // 格式：
  // 全域詞典新增 原文=譯文
  // /gdict add 原文=譯文
  if (text.startsWith("全域詞典新增 ") || lower.startsWith("/gdict add ")) {
    if (!isGlobalAdmin(userId)) {
      return {
        handled: true,
        promise: safeReply(event.replyToken, "你沒有全域詞典管理權限。"),
      };
    }

    const body = text.startsWith("全域詞典新增 ")
      ? text.slice("全域詞典新增 ".length)
      : rawText.slice(rawText.toLowerCase().indexOf("/gdict add ") + "/gdict add ".length);

    const parsed = parseDictPair(body);
    if (!parsed) {
      return {
        handled: true,
        promise: safeReply(event.replyToken, "格式錯誤。\n請使用：全域詞典新增 原文=譯文"),
      };
    }

    state.globalDict[parsed.source] = parsed.target;
    saveAll();
    return {
      handled: true,
      promise: safeReply(event.replyToken, `全域詞典已新增：\n${parsed.source} => ${parsed.target}`),
    };
  }

  if (text.startsWith("全域詞典刪除 ") || lower.startsWith("/gdict del ")) {
    if (!isGlobalAdmin(userId)) {
      return {
        handled: true,
        promise: safeReply(event.replyToken, "你沒有全域詞典管理權限。"),
      };
    }

    const key = text.startsWith("全域詞典刪除 ")
      ? text.slice("全域詞典刪除 ".length).trim()
      : rawText.slice(rawText.toLowerCase().indexOf("/gdict del ") + "/gdict del ".length).trim();

    if (!key) {
      return {
        handled: true,
        promise: safeReply(event.replyToken, "請提供要刪除的全域詞條。"),
      };
    }

    if (key in state.globalDict) {
      delete state.globalDict[key];
      saveAll();
      return {
        handled: true,
        promise: safeReply(event.replyToken, `全域詞典已刪除：${key}`),
      };
    }
    return {
      handled: true,
      promise: safeReply(event.replyToken, `全域詞典找不到：${key}`),
    };
  }

  if (text === "全域詞典列表" || lower === "/gdict list") {
    if (!isGlobalAdmin(userId)) {
      return {
        handled: true,
        promise: safeReply(event.replyToken, "你沒有全域詞典管理權限。"),
      };
    }
    const entries = Object.entries(state.globalDict || {});
    const out = entries.length
      ? "全域詞典：\n" + entries.map(([k, v]) => `${k} => ${v}`).join("\n")
      : "全域詞典目前為空。";
    return {
      handled: true,
      promise: safeReply(event.replyToken, out),
    };
  }

  // -------- 說明 --------
  if (text === "help" || text === "/help" || text === "指令" || text === "功能") {
    const msg = [
      "可用指令：",
      "",
      "【群組授權】",
      "授權開啟",
      "授權關閉",
      "授權狀態",
      "/auth on",
      "/auth off",
      "/auth status",
      "",
      "【群組詞典】",
      "詞典新增 原文=譯文",
      "詞典刪除 原文",
      "詞典列表",
      "/dict add 原文=譯文",
      "/dict del 原文",
      "/dict list",
      "",
      "【全域詞典】(需管理權限)",
      "全域詞典新增 原文=譯文",
      "全域詞典刪除 原文",
      "全域詞典列表",
      "/gdict add 原文=譯文",
      "/gdict del 原文",
      "/gdict list",
    ].join("\n");

    return {
      handled: true,
      promise: safeReply(event.replyToken, msg),
    };
  }

  return { handled: false, promise: null };
}

// =========================
// 翻譯主流程
// =========================
async function translateMessage({ text, sourceLang, targetLang, contextList, groupId }) {
  // 先保留不該翻的內容
  const protectedPack = protectAll(text);
  let protectedText = protectedPack.text;
  const protectedMap = protectedPack.map;

  // 套用詞典保護
  const dictPack = applyDictionaryPlaceholders(protectedText, groupId);
  protectedText = dictPack.text;
  const dictRestoreMap = dictPack.restoreMap;

  // 多行翻譯：保留原始行數
  const lines = protectedText.split(/\r?\n/);
  const resultLines = [];

  for (const line of lines) {
    const translatedLine = await translateOneLine({
      line,
      sourceLang,
      targetLang,
      contextList,
      groupId,
    });
    resultLines.push(translatedLine);
  }

  let merged = resultLines.join("\n");

  // 還原詞典
  merged = restorePlaceholders(merged, dictRestoreMap);

  // 還原 @ / emoji / 其他保護內容
  merged = restorePlaceholders(merged, protectedMap);

  // 後處理
  merged = postNormalizeOutput(merged, sourceLang, targetLang);

  return merged;
}

async function translateOneLine({ line, sourceLang, targetLang, contextList }) {
  if (line === "") return "";

  const trimmed = line.trim();

  // 純數字 / 型號 / 代碼行：原樣保留
  if (isCodeOnlyLine(trimmed)) {
    return line;
  }

  // mixed 中泰混雜：略過
  if (detectMainLanguage(trimmed) === "mixed") {
    return line;
  }

  // 型號/代碼 + 中文短詞 特殊處理
  if (sourceLang === "zh" && looksLikeCodePlusShortChinese(trimmed)) {
    return await translateCodePlusShortChineseLine(line);
  }

  // 中文 -> 泰文：分段翻譯
  if (sourceLang === "zh" && targetLang === "th") {
    const segments = splitChineseForTranslation(line);
    if (segments.length === 0) return line;

    const outputSegments = [];
    for (const seg of segments) {
      if (seg === "") {
        outputSegments.push(seg);
        continue;
      }
      if (isCodeOnlyLine(seg.trim())) {
        outputSegments.push(seg);
        continue;
      }
      if (!containsChinese(seg)) {
        outputSegments.push(seg);
        continue;
      }
      const t = await callTranslator({
        text: seg,
        sourceLang,
        targetLang,
        contextList,
        strictMode: "zh_to_th_segment",
      });
      outputSegments.push(t || seg);
    }
    return outputSegments.join("");
  }

  // 泰文 -> 中文：整行翻譯，但保留行結構
  if (sourceLang === "th" && targetLang === "zh") {
    const t = await callTranslator({
      text: line,
      sourceLang,
      targetLang,
      contextList,
      strictMode: "th_to_zh_line",
    });
    return t || line;
  }

  return line;
}

// =========================
// OpenAI 翻譯
// =========================
async function callTranslator({ text, sourceLang, targetLang, contextList, strictMode }) {
  const contextText = (contextList || [])
    .slice(-3)
    .map((x, idx) => `${idx + 1}. [${x.lang}] ${x.text}`)
    .join("\n");

  const system = buildSystemPrompt({ sourceLang, targetLang, strictMode });
  const user = [
    "請直接輸出翻譯結果，不要解釋，不要加引號，不要加前後綴。",
    "務必遵守：",
    "1. 不可遺漏後半句。",
    "2. 不可只翻前面幾個字。",
    "3. 不可把型號、數字、價格、時間、代碼亂解釋成句子。",
    "4. 只能翻成目標語，不要夾雜原語，除非原文就是代碼或保留符號。",
    "5. 如果原文是口語，請譯成自然口語。",
    "6. 保持原句長度結構，不要擅自擴寫。",
    "",
    "最近上下文（只供理解語氣，不可把上下文內容混進結果）：",
    contextText || "無",
    "",
    "原文：",
    text,
  ].join("\n");

  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.15,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const out = resp?.choices?.[0]?.message?.content?.trim() || "";
    return cleanupModelOutput(out);
  } catch (err) {
    console.error("OpenAI translate error:", err?.message || err);
    return text;
  }
}

function buildSystemPrompt({ sourceLang, targetLang, strictMode }) {
  const base = `
你是專業的中泰雙向翻譯助手。
你只能做「忠實、自然、完整」的翻譯，不可總結，不可解釋，不可加料，不可腦補。
你最重要的任務是避免以下錯誤：
- 只翻前面幾個字
- 完全不翻
- 漏翻句尾
- 把型號/代碼/數字亂解釋
- 把多行合併
- 把口語翻得失真

【保留規則】
- 任何形如 __PH_xxx__ 的佔位符都必須原樣保留，不可更動。
- 純數字、型號、時間、價格、斜線代碼、英數代碼，原樣保留。
- 不得將代碼解釋成完整句子。
- 遇到看似商品型號 + 短詞，只翻短詞，型號保留。

【風格規則】
- 中文 -> 泰文：譯成自然泰文口語，但不要過度潤飾。
- 泰文 -> 中文：譯成自然繁體中文口語，但不要太書面。
`;

  const zhToThHints = `
【中文 -> 泰文特別要求】
- 中文口語時間詞要準確處理：剛剛、剛才、先、現在、等等、已經、還沒
- 「先」要依語境翻成先做某事，不可漏掉。
- 「等等」要依語境判斷成稍等、等一下、再等等，不可誤成其他意思。
- 「已經 / 還沒」要明確表達完成與否。
- 可使用自然泰語口語，但不要自行加長。
- 分段翻譯時，每個片段都必須完整翻完。
`;

  const thToZhHints = `
【泰文 -> 中文特別要求】
- 泰文口語句型要準確：
  - ไม่มีคนช่วย...
  - ทำงานนะ
  - นะค่ะ 一律視為 นะคะ 的口語用法理解
  - เพราะ...
  - เลย...
  - ยังไม่...
  - ได้แล้ว
  - ต้อง...
- 不可直譯得太硬，要忠實保留語氣與原意。
- 例如「เพราะคุณไม่มีคนช่วยดูแลร้าน ทำงานนะคะที่รัก😅」
  應理解成「因為你沒有人幫你顧店，所以要工作喔，親愛的😅」這類自然意思。
`;

  const strictZhSeg = `
【分段模式】
- 現在輸入只是一個片段，你只能翻譯這個片段。
- 不可遺漏片段中的任何字。
- 不可因為片段短就不翻。
`;

  const strictThLine = `
【整行模式】
- 現在輸入是一整行。
- 只能輸出這一行的中文翻譯。
- 不可加說明。
`;

  let prompt = base;

  if (sourceLang === "zh" && targetLang === "th") prompt += zhToThHints;
  if (sourceLang === "th" && targetLang === "zh") prompt += thToZhHints;
  if (strictMode === "zh_to_th_segment") prompt += strictZhSeg;
  if (strictMode === "th_to_zh_line") prompt += strictThLine;

  return prompt.trim();
}

// =========================
// 多行 / 分段 / 特殊規則
// =========================
function splitChineseForTranslation(line) {
  // 保留分隔符，避免合併成一行或漏掉後半句
  // 例如：剛剛在忙，等等回你喔 -> ["剛剛在忙，", "等等回你喔"]
  const parts = line.split(/([，。！？；：,.!?;:])/);
  const out = [];

  for (let i = 0; i < parts.length; i++) {
    const cur = parts[i];
    if (cur === undefined || cur === null) continue;
    if (cur === "") continue;

    const next = parts[i + 1];
    if (next && /^[，。！？；：,.!?;:]$/.test(next)) {
      out.push(cur + next);
      i++;
    } else {
      out.push(cur);
    }
  }

  return out;
}

async function translateCodePlusShortChineseLine(line) {
  // 例：
  // 1935/60/2/2800 灰色
  // => 1935/60/2/2800 สีเทา
  const match = line.match(/^([A-Za-z0-9/._:+\- ]+)([\u4e00-\u9fff]{1,8})$/);
  if (!match) return line;

  const codePart = match[1];
  const zhPart = match[2];

  const mapped = quickShortZhToTh(zhPart);
  if (mapped) {
    return `${codePart}${mapped}`;
  }

  const translated = await callTranslator({
    text: zhPart,
    sourceLang: "zh",
    targetLang: "th",
    contextList: [],
    strictMode: "zh_to_th_segment",
  });

  const cleaned = translated.replace(/\s+/g, " ").trim();
  return `${codePart}${cleaned || zhPart}`;
}

function looksLikeCodePlusShortChinese(text) {
  return /^([A-Za-z0-9/._:+\- ]+)([\u4e00-\u9fff]{1,8})$/.test(text);
}

function isCodeOnlyLine(text) {
  if (!text) return false;

  // 純數字、時間、價格、型號、斜線、英數代碼
  const patterns = [
    /^[0-9\s/.:+\-]+$/,                    // 1300/40/2000
    /^[A-Za-z0-9\s/._:+\-]+$/,             // code only
    /^[0-9]{1,2}\/[0-9]{1,2}\s*$/,         // 4/8
    /^[0-9]{3,4}\s*$/,                     // 1300
    /^[0-9]{1,2}:[0-9]{2}\s*$/,            // 13:00
    /^[0-9/]+\s*$/,                        // 4/8 / 1300/40/2000
  ];

  return patterns.some((p) => p.test(text));
}

function detectMainLanguage(text) {
  const zhCount = countChinese(text);
  const thCount = countThai(text);

  if (zhCount > 0 && thCount > 0) return "mixed";
  if (zhCount > 0) return "zh";
  if (thCount > 0) return "th";
  return "other";
}

function countChinese(text) {
  const m = text.match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

function countThai(text) {
  const m = text.match(/[\u0E00-\u0E7F]/g);
  return m ? m.length : 0;
}

function containsChinese(text) {
  return /[\u4e00-\u9fff]/.test(text);
}

// =========================
// 詞典
// =========================
function applyDictionaryPlaceholders(text, groupId) {
  const restoreMap = {};
  let idx = 0;
  let out = text;

  const mergedDict = {
    ...(state.globalDict || {}),
    ...((groupId && state.groupDict[groupId]) || {}),
  };

  const entries = Object.entries(mergedDict).sort((a, b) => b[0].length - a[0].length);

  for (const [source, target] of entries) {
    if (!source) continue;

    const placeholder = `__PH_DICT_${idx++}__`;
    const escaped = escapeRegExp(source);
    const re = new RegExp(escaped, "g");

    if (re.test(out)) {
      out = out.replace(re, placeholder);
      restoreMap[placeholder] = target;
    }
  }

  return { text: out, restoreMap };
}

function parseDictPair(body) {
  const idx = body.indexOf("=");
  if (idx === -1) return null;
  const source = body.slice(0, idx).trim();
  const target = body.slice(idx + 1).trim();
  if (!source || !target) return null;
  return { source, target };
}

// =========================
// 保護 @ / emoji / 特殊符號
// =========================
function protectAll(text) {
  let out = text;
  const map = {};
  let idx = 0;

  // 1) @標記
  // 例：@John @小美
  out = out.replace(/@\S+/g, (m) => {
    const ph = `__PH_AT_${idx++}__`;
    map[ph] = m;
    return ph;
  });

  // 2) emoji / pictographs
  // Node 18+ 可支援 u flag
  out = out.replace(/[\p{Extended_Pictographic}\u2600-\u27BF]/gu, (m) => {
    const ph = `__PH_EMJ_${idx++}__`;
    map[ph] = m;
    return ph;
  });

  return { text: out, map };
}

function restorePlaceholders(text, restoreMap) {
  let out = text;
  const entries = Object.entries(restoreMap).sort((a, b) => b[0].length - a[0].length);
  for (const [ph, original] of entries) {
    out = out.split(ph).join(original);
  }
  return out;
}

// =========================
// 上下文
// =========================
function getChatKey(source) {
  if (!source) return "unknown";
  if (source.type === "group") return `group:${source.groupId}`;
  if (source.type === "room") return `room:${source.roomId}`;
  return `user:${source.userId || "unknown"}`;
}

function getRecentContext(chatKey, limit = 3) {
  const arr = state.contexts[chatKey] || [];
  return arr.slice(-limit);
}

function pushContext(chatKey, item) {
  if (!state.contexts[chatKey]) state.contexts[chatKey] = [];
  state.contexts[chatKey].push({
    role: item.role,
    text: item.text,
    lang: item.lang,
    ts: Date.now(),
  });

  // 控制大小，避免檔案越來越大
  if (state.contexts[chatKey].length > 20) {
    state.contexts[chatKey] = state.contexts[chatKey].slice(-20);
  }
  saveJson(CONTEXT_FILE, state.contexts);
}

// =========================
// 後處理
// =========================
function postNormalizeOutput(text, sourceLang, targetLang) {
  let out = text;

  // 修正常見 AI 輸出包裝
  out = cleanupModelOutput(out);

  if (sourceLang === "th" && targetLang === "zh") {
    // 常見泰文口語對應補強
    out = out
      .replace(/นะค่ะ/g, "นะคะ")
      .replace(/因為你沒有人幫忙照顧店鋪，工作哦，親愛的。/g, "因為你沒有人幫你顧店，所以要工作喔，親愛的。");
  }

  if (sourceLang === "zh" && targetLang === "th") {
    // 小型詞彙標準化
    out = out
      .replace(/นะค่ะ/g, "นะคะ");
  }

  return out;
}

function cleanupModelOutput(text) {
  let out = (text || "").trim();

  out = out
    .replace(/^```(?:text)?/i, "")
    .replace(/```$/i, "")
    .trim();

  // 去掉模型常見前綴
  out = out.replace(/^(翻譯：|譯文：|คำแปล：|คำแปล:|Translation:)\s*/i, "");

  return out.trim();
}

// =========================
// 特殊短詞快取映射
// =========================
function quickShortZhToTh(zh) {
  const map = {
    "灰色": "สีเทา",
    "白色": "สีขาว",
    "黑色": "สีดำ",
    "紅色": "สีแดง",
    "藍色": "สีน้ำเงิน",
    "綠色": "สีเขียว",
    "黃色": "สีเหลือง",
    "粉色": "สีชมพู",
    "紫色": "สีม่วง",
    "咖啡色": "สีน้ำตาล",
    "棕色": "สีน้ำตาล",
    "橘色": "สีส้ม",
    "銀色": "สีเงิน",
    "金色": "สีทอง",
    "客人時間": "เวลาลูกค้า",
    "今天": "วันนี้",
    "明天": "พรุ่งนี้",
    "後天": "มะรืนนี้",
    "早上": "ตอนเช้า",
    "中午": "ตอนเที่ยง",
    "下午": "ตอนบ่าย",
    "晚上": "ตอนเย็น",
    "有": "มี",
    "沒有": "ไม่มี",
  };
  return map[zh] || null;
}

// =========================
// 權限
// =========================
function isGlobalAdmin(userId) {
  if (!ADMIN_USER_ID) return true; // 沒設定時，先放寬
  return userId === ADMIN_USER_ID;
}

// =========================
// 安全回覆
// =========================
async function safeReply(replyToken, text) {
  if (!replyToken || !text) return null;

  // LINE 單則文字長度限制預留
  const max = 4500;
  if (text.length <= max) {
    return client.replyMessage(replyToken, {
      type: "text",
      text,
    });
  }

  const chunks = splitLongText(text, max);
  const messages = chunks.slice(0, 5).map((chunk) => ({
    type: "text",
    text: chunk,
  }));

  return client.replyMessage(replyToken, messages);
}

function splitLongText(text, maxLen) {
  const lines = text.split("\n");
  const chunks = [];
  let cur = "";

  for (const line of lines) {
    if ((cur + "\n" + line).length > maxLen) {
      if (cur) chunks.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }

  if (cur) chunks.push(cur);
  return chunks;
}

// =========================
// 工具
// =========================
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`讀取 JSON 失敗: ${file}`, err);
    return fallback;
  }
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error(`寫入 JSON 失敗: ${file}`, err);
  }
}

function saveAll() {
  saveJson(AUTH_FILE, state.groupAuth);
  saveJson(GROUP_DICT_FILE, state.groupDict);
  saveJson(GLOBAL_DICT_FILE, state.globalDict);
  saveJson(CONTEXT_FILE, state.contexts);
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
