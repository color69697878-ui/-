"use strict";

/**
 * v6.4 指令安全版
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");

const PORT = process.env.PORT || 3000;
const ADMIN_ID = process.env.ADMIN_USER_ID;

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();

const DATA = path.join(__dirname, "data");
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);

const FILE = path.join(DATA, "db.json");

let db = load();

const KEEP = ["IN","OUT","VIP","OK","XL","L","M","S","PCS"];

app.post("/webhook", line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handle));
  res.end();
});

app.listen(PORT);

// ===== 主流程 =====
async function handle(e){

  if(e.type !== "message") return;
  if(e.message.type !== "text") return;

  const text = e.message.text.trim();
  const gid = e.source.groupId;
  const uid = e.source.userId;

  if(!gid) return;

  // ===== 自動記錄 =====
  db.pending = db.pending || {};
  if(!db.allowGroups?.[gid]){
    db.pending[gid] = true;
    save();
  }

  // ===== 指令系統 =====
  if(text.startsWith("/")){
    return handleCommand(e, text, gid, uid);
  }

  // ===== 未授權 =====
  if(!db.allowGroups?.[gid]) return;

  // ===== 未開啟 =====
  if(!db.groups?.[gid]?.enable) return;

  const lang = detect(text);

  if(lang === "en"){
    return translate(e,text,"en","zh");
  }

  const g = db.groups[gid];
  if(!g) return;

  if(lang === g.langA){
    return translate(e,text,g.langA,g.langB);
  }

  if(lang === g.langB){
    return translate(e,text,g.langB,g.langA);
  }
}

// ===== 指令處理 =====
async function handleCommand(e, text, gid, uid){

  const args = text.split(" ");
  const cmd = args[0];

  // ===== 批准 =====
  if(cmd === "/批准"){
  if(uid !== ADMIN_ID) return;

  db.allowGroups[gid] = true;
  delete db.pending[gid];

  db.groups = db.groups || {};
  db.groups[gid] = {
    enable: true,
    langA: "zh",
    langB: "th"
  };

  save();

  return replyFlex(e, buildPanel(gid));
}
  // ===== 面板 =====
  if(cmd === "/面板"){
    if(uid !== ADMIN_ID) return reply(e,"無權限");
    return replyFlex(e, buildPanel(gid));
  }

  // ===== 語言 =====
  if(cmd === "/setlang"){
    if(uid !== ADMIN_ID) return;

    const a = args[1];
    const b = args[2];

    init(gid);
    db.groups[gid].langA = a;
    db.groups[gid].langB = b;
    save();

    return reply(e,`已設定 ${a} <-> ${b}`);
  }

  if(cmd === "/lang"){
    const g = db.groups[gid];
    if(!g) return reply(e,"未設定");
    return reply(e,`${g.langA} <-> ${g.langB}`);
  }

  // ===== 開關 =====
  if(cmd === "/on"){
    if(uid !== ADMIN_ID) return;
    init(gid);
    db.groups[gid].enable = true;
    save();
    return reply(e,"已開啟");
  }

  if(cmd === "/off"){
    if(uid !== ADMIN_ID) return;
    init(gid);
    db.groups[gid].enable = false;
    save();
    return reply(e,"已關閉");
  }
}

// ===== 翻譯 =====
async function translate(e,text,from,to){

  const p = protect(text);

  const res = await openai.chat.completions.create({
    model:"gpt-4.1-mini",
    messages:[
      {role:"system",content:"只輸出翻譯"},
      {role:"user",content:`${from}->${to}\n${p.text}`}
    ]
  });

  let out = res.choices[0].message.content.trim();
  out = restore(out,p.map);

  return reply(e,out);
}

// ===== UI =====
function buildPanel(gid){

  const g = db.groups?.[gid] || {};
  const status = g.enable ? "🟢 ON" : "🔴 OFF";
  const lang = g.langA ? `${g.langA} ⇄ ${g.langB}` : "未設定";

  return {
    type:"bubble",
    body:{
      type:"box",
      layout:"vertical",
      contents:[
        {type:"text",text:"控制面板",weight:"bold"},
        {type:"text",text:`狀態：${status}`},
        {type:"text",text:`語言：${lang}`},

        box([
          btn("中⇄泰","SET_LANG:zh:th"),
          btn("英⇄中","SET_LANG:en:zh")
        ]),
        box([
          btn("緬⇄中","SET_LANG:my:zh"),
          btn("開啟","TOGGLE_ON")
        ]),
        box([
          btn("關閉","TOGGLE_OFF")
        ])
      ]
    }
  };
}

function box(arr){
  return {type:"box",layout:"horizontal",contents:arr};
}

function btn(label,data){
  return {
    type:"button",
    action:{type:"message",label,text:data}
  };
}

// ===== 保護 =====
function protect(text){
  let map={},i=0;

  KEEP.forEach(k=>{
    const r=new RegExp(`\\b${k}\\b`,"g");
    text=text.replace(r,m=>{
      const p=`__${i++}__`;
      map[p]=m;
      return p;
    });
  });

  return {text,map};
}

function restore(t,map){
  Object.entries(map).forEach(([k,v])=>{
    t=t.split(k).join(v);
  });
  return t;
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
function init(g){
  db.groups = db.groups || {};
  if(!db.groups[g]) db.groups[g]={enable:true};
}

function load(){
  try{return JSON.parse(fs.readFileSync(FILE))}
  catch{return {allowGroups:{},groups:{},pending:{}}}
}

function save(){
  fs.writeFileSync(FILE,JSON.stringify(db,null,2));
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
