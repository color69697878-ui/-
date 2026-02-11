import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

/* ======================================================
   基本設定
====================================================== */

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const OWNER = process.env.OWNER_USER_ID;

/* ======================================================
   白名單
====================================================== */

let allowedGroups = process.env.ALLOWED_GROUPS
  ? process.env.ALLOWED_GROUPS.split(",").filter(Boolean)
  : [];

function saveGroups() {
  process.env.ALLOWED_GROUPS = allowedGroups.join(",");
}

/* ======================================================
   語言判斷
====================================================== */

function detectLang(text) {
  if (/[\u0E00-\u0E7F]/.test(text)) return "th";
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh";
  return "en";
}

function targetLang(source) {
  if (source === "th") return "繁體中文";
  if (source === "zh") return "泰文";
  return "繁體中文";
}

/* ======================================================
   翻譯
====================================================== */

async function translate(text, lang) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content: "你是專業翻譯引擎，只輸出翻譯結果，不要解釋"
      },
      {
        role: "user",
        content: `翻譯成${lang}：${text}`
      }
    ]
  });

  return r.choices[0].message.content.trim();
}

/* ======================================================
   Webhook
====================================================== */

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

/* ======================================================
   主事件處理
====================================================== */

async function handleEvent(event) {

  /* =========================
     JOIN → 未授權直接踢
  ========================= */

  if (event.type === "join") {
    const id = event.source.groupId || event.source.roomId;

    if (!allowedGroups.includes(id)) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        if (event.type === "join") {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "此群尚未授權\n請管理員輸入 /addgroup"
  });
}


      if (event.source.type === "group") {
        await client.leaveGroup(id);
      } else {
        await client.leaveRoom(id);
      }
    }
    return;
  }

  if (event.type !== "message") return;
  if (event.message.type !== "text") return;

  const text = event.message.text.trim();
  const userId = event.source.userId;

  const placeId =
    event.source.groupId ||
    event.source.roomId ||
    null;


  /* ======================================================
     ⭐⭐⭐ 指令優先處理 ⭐⭐⭐
  ====================================================== */

  // 查自己ID
  if (text === "/myid") {
    return reply(event, "你的UserID：\n" + userId);
  }

  // 查群組ID
  if (text === "/groupid") {
    if (!placeId) return reply(event, "請在群組或聊天室使用");
    return reply(event, "ID：\n" + placeId);
  }


  /* ======================================================
     ⭐ 管理員指令（OWNER）
  ====================================================== */

  if (userId === OWNER) {

    // 加入白名單
    if (text === "/addgroup") {
      if (!placeId) return reply(event, "請在群組使用");

      if (!allowedGroups.includes(placeId)) {
        allowedGroups.push(placeId);
        saveGroups();
      }

      return reply(event, "✅ 已授權此群組");
    }

    // 移除白名單
    if (text === "/removegroup") {
      if (!placeId) return reply(event, "請在群組使用");

      allowedGroups = allowedGroups.filter(id => id !== placeId);
      saveGroups();

      return reply(event, "🗑 已移除群組");
    }

    // 查看數量
    if (text === "/groups") {
      return reply(event, "白名單群組數量：" + allowedGroups.length);
    }
  }


  /* ===== 群組 / 房間 白名單 ===== */

if (event.source.type === "group" || event.source.type === "room") {

  const id = event.source.groupId || event.source.roomId;

  // ⭐ 允許 OWNER 在未授權群組操作
  if (!allowedGroups.includes(id) && event.source.userId !== OWNER) {

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ 此群組未授權"
    });

    if (event.source.type === "group") {
      await client.leaveGroup(id);
    } else {
      await client.leaveRoom(id);
    }

    return;
  }
}



  /* ======================================================
     ⭐ 正常翻譯（非指令）
  ====================================================== */

  if (text.startsWith("/")) return; // 不翻譯指令

  const source = detectLang(text);
  const target = targetLang(source);

  const result = await translate(text, target);

  return reply(event, result);
}

/* ======================================================
   回覆工具
====================================================== */

function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text
  });
}

/* ======================================================
   啟動
====================================================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("BOT RUNNING ON " + PORT);
});


