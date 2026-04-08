"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");

// ===== 基本 =====
const PORT = process.env.PORT || 3000;

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();

// ===== 資料 =====
const DATA = path.join(__dirname, "data");
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);

const DB_FILE = path.join(DATA, "db.json");

let db = load();

// ===== 預設保留字 =====
const KEEP = ["IN","OUT","VIP","OK","XL","L","M","S","PCS"];

// ===== Webhook =====
app.post("/webhook", line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handle));
  res.end();
});

app.get("/", (req,res)=>res.send("v6.1 Flex UI running"));

app.listen(PORT);

// ===== 主流程 =====
async function handle(e){

  if(e.type !== "message") return;

  if(e.message.type === "sticker") return;

  if(e.message.type !== "text") return;

  const text = e.message.text.trim();
  const gid = e.source.groupId;

  // ===== UI 面板 =====
  if(text === "面板"){
    return replyFlex(e, buildPanel(gid));
  }

  // ===== UI 按鈕事件 =====
  if(text.startsWith("SET_LANG")){
    const [,a,b] = text.split(":");
    initGroup(gid);
    db[gid].langA = a;
    db[gid].langB = b;
    save();
    return reply(e,`已設定 ${a} <-> ${b}`);
  }

  if(text === "TOGGLE_ON"){
    initGroup(gid);
    db[gid].enable = true;
    save();
    return reply(e,"翻譯已開啟");
  }

  if(text === "TOGGLE_OFF"){
    initGroup(gid);
    db[gid].enable = false;
    save();
    return reply(e,"翻譯已關閉");
  }

  // ===== 授權 =====
  if(!db[gid]?.enable) return;

  const lang = detect(text);

  // 英文強制翻中文
  if(lang === "en"){
    return translate(e,text,"en","zh");
  }

  const g = db[gid];
  if(!g) return;

  if(lang === g.langA){
    return translate(e,text,g.langA,g.langB);
  }

  if(lang === g.langB){
    return translate(e,text,g.langB,g.langA);
  }
}

// ===== 翻譯 =====
async function translate(e,text,from,to){

  const pack = protect(text);
  const safe = pack.text;

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages:[
      {role:"system",content:"只輸出翻譯結果"},
      {role:"user",content:`${from} -> ${to}\n${safe}`}
    ]
  });

  let out = res.choices[0].message.content.trim();

  out = restore(out,pack.map);

  return reply(e,out);
}

// ===== Flex UI =====
function buildPanel(gid){

  const g = db[gid] || {};
  const status = g.enable ? "🟢 已開啟" : "🔴 已關閉";
  const lang = g.langA ? `${g.langA} ⇄ ${g.langB}` : "未設定";

  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        {type:"text",text:"翻譯控制面板",weight:"bold",size:"lg"},
        {type:"text",text:`狀態：${status}`},
        {type:"text",text:`語言：${lang}`},

        {
          type:"box",
          layout:"horizontal",
          contents:[
            btn("中文⇄泰文","SET_LANG:zh:th"),
            btn("英文⇄中文","SET_LANG:en:zh")
          ]
        },

        {
          type:"box",
          layout:"horizontal",
          contents:[
            btn("緬甸⇄中文","SET_LANG:my:zh"),
            btn("開啟","TOGGLE_ON")
          ]
        },

        {
          type:"box",
          layout:"horizontal",
          contents:[
            btn("關閉","TOGGLE_OFF")
          ]
        }
      ]
    }
  };
}

function btn(label,data){
  return {
    type:"button",
    style:"primary",
    action:{
      type:"message",
      label,
      text:data
    }
  };
}

// ===== 保護 =====
function protect(text){
  let map = {};
  let i=0;

  let t=text;

  KEEP.forEach(k=>{
    const r = new RegExp(`\\b${k}\\b`,"g");
    t=t.replace(r,m=>{
      const p=`__${i++}__`;
      map[p]=m;
      return p;
    });
  });

  t=t.replace(/@\S+/g,m=>{
    const p=`__${i++}__`;
    map[p]=m;
    return p;
  });

  return {text:t,map};
}

function restore(text,map){
  let out=text;
  Object.entries(map).forEach(([k,v])=>{
    out=out.split(k).join(v);
  });
  return out;
}

// ===== 語言 =====
function detect(t){
  if(/[\u4e00-\u9fff]/.test(t)) return "zh";
  if(/[\u0E00-\u0E7F]/.test(t)) return "th";
  if(/[\u1000-\u109F]/.test(t)) return "my";
  if(/[a-zA-Z]/.test(t)) return "en";
  return "other";
}

// ===== DB =====
function initGroup(g){
  if(!db[g]) db[g]={enable:true};
}

function load(){
  try{return JSON.parse(fs.readFileSync(DB_FILE))}
  catch{return {}}
}

function save(){
  fs.writeFileSync(DB_FILE,JSON.stringify(db,null,2));
}

// ===== reply =====
function reply(e,t){
  return client.replyMessage(e.replyToken,{type:"text",text:t});
}

function replyFlex(e,f){
  return client.replyMessage(e.replyToken,{
    type:"flex",
    altText:"控制面板",
    contents:f
  });
}
