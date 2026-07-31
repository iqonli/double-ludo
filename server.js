#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const util = require('node:util');
const { URL } = require('node:url');
const { RoomManager } = require('./server/room-manager.js');
const {
  ApiError,
  jsonBody,
  sendJson,
  sendJsonDownload,
  sendNoContent,
  sendError,
  commonHeaders
} = require('./server/protocol.js');
const { atomicWriteJson, loadJson, quarantineBrokenFile } = require('./server/persistence.js');

const APP_VERSION = '0.42.1';
const CONSOLE_LINE_LIMIT = 600;
const consoleLines = [];
const nativeConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};
function rememberConsole(args) {
  const rendered = util.format(...args);
  for (const line of String(rendered).replace(/\r\n?/g, '\n').split('\n')) consoleLines.push(line);
  if (consoleLines.length > CONSOLE_LINE_LIMIT) consoleLines.splice(0, consoleLines.length - CONSOLE_LINE_LIMIT);
}
for (const level of ['log', 'info', 'warn', 'error']) {
  console[level] = (...args) => {
    rememberConsole(args);
    nativeConsole[level](...args);
  };
}

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const AUTOSAVE_FILE = path.join(DATA_DIR, 'autosave.json');
const PORT_MIN = 6666;
const PORT_MAX = 8888;
const explicitPortText = process.env.PORT || process.argv.find(arg => /^--port=/.test(arg))?.split('=')[1] || '';
const EXPLICIT_PORT = explicitPortText ? Number(explicitPortText) : null;
if (EXPLICIT_PORT !== null && (!Number.isInteger(EXPLICIT_PORT) || EXPLICIT_PORT < 1 || EXPLICIT_PORT > 65535)) {
  throw new Error('PORT/--port 必须是1到65535之间的整数');
}
const HOST = process.env.HOST || '0.0.0.0';
const manager = new RoomManager();
let shuttingDown = false;
let activePort = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm'
};

function normalizeAddress(value) {
  const raw = String(value || '').replace(/^::ffff:/, '');
  if (raw === '::1') return '127.0.0.1';
  return raw;
}

function localAddresses() {
  const values = new Set(['127.0.0.1', '::1']);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) values.add(normalizeAddress(entry.address));
  }
  return values;
}

function requireLocalAdmin(req) {
  const remote = normalizeAddress(req.socket.remoteAddress);
  if (!localAddresses().has(remote)) {
    throw new ApiError(403, 'ADMIN_LOCAL_ONLY', '服务端管理接口只能在开服设备本机访问');
  }
}

function persistRooms(reason = 'change') {
  try {
    atomicWriteJson(AUTOSAVE_FILE, {
      autosave: true,
      savedAt: new Date().toISOString(),
      reason,
      multiroom: manager.exportAutosave()
    });
    return true;
  } catch (error) {
    console.error(`自动存档失败（${reason}）：`, error);
    return false;
  }
}

function restoreAutosave() {
  try {
    const saved = loadJson(AUTOSAVE_FILE);
    if (!saved) {
      manager.ensureInitialRoom();
      return false;
    }
    manager.importAutosave(saved.multiroom || saved.gameFile || saved);
    console.log(`已从自动存档恢复：${AUTOSAVE_FILE}`);
    return true;
  } catch (error) {
    quarantineBrokenFile(AUTOSAVE_FILE, error);
    manager.ensureInitialRoom();
    return false;
  }
}

function mutate(reason, operation) {
  const payload = operation();
  persistRooms(reason);
  return payload;
}

function contentPath(urlPath) {
  let root;
  let relative;
  if (urlPath === '/' || urlPath === '/game.html') {
    root = PUBLIC_DIR;
    relative = 'game.html';
  } else if (urlPath.startsWith('/shared/')) {
    root = SHARED_DIR;
    relative = urlPath.slice('/shared/'.length);
  } else {
    root = PUBLIC_DIR;
    relative = urlPath.replace(/^\//, '');
  }
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(root, relative);
  if (!full.startsWith(resolvedRoot + path.sep) && full !== resolvedRoot) return null;
  return full;
}

function serveFile(req, res, urlPath) {
  const full = contentPath(urlPath);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
  const stat = fs.statSync(full);
  res.writeHead(200, {
    ...commonHeaders(),
    'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': /ai-model-normal\.js$/.test(full) ? 'public, max-age=3600' : 'no-cache'
  });
  const stream = fs.createReadStream(full);
  stream.on('error', error => {
    console.error(`读取静态文件失败：${full}`, error);
    if (!res.headersSent) sendError(res, error);
    else res.destroy(error);
  });
  stream.pipe(res);
  return true;
}

function adminStatePayload() {
  const managerState = manager.adminState();
  const firstRoomId = manager.roomIds()[0];
  const legacy = firstRoomId ? manager.getRoom(firstRoomId).adminState() : {};
  return {
    ...legacy,
    ...managerState,
    port: activePort,
    gameUrl: activePort ? `http://127.0.0.1:${activePort}/game.html` : '',
    consoleText: consoleLines.join('\n')
  };
}

function adminMutate(reason, operation) {
  mutate(reason, operation);
  return adminStatePayload();
}

function legacyRoomId() {
  return manager.roomIds()[0] || manager.ensureInitialRoom().roomId;
}

function adminHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>双飞 v0.42.1 多房间局域网服务端</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDQ4IiBoZWlnaHQ9IjIwNDgiIHZpZXdCb3g9IjAgMCAyMDQ4IDIwNDgiIHJvbGU9ImltZyIgYXJpYS1sYWJlbD0i5Y+M6aOe6JOd6Imy5qOL5a2Q5Zu+5qCHIj48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMDI0IDEwMjQpIHNjYWxlKDIxLjMzMzMzMzMzMzMzMzMzMikgdHJhbnNsYXRlKC0yNTYgLTI1NikiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDI1NiAyNTYpIj48Y2lyY2xlIGN4PSIwIiBjeT0iMCIgcj0iNDUuMjUiIGZpbGw9IiMzMTg1ZDgiIHN0cm9rZT0iIzI4NjVhMCIgc3Ryb2tlLXdpZHRoPSI1LjUiLz48bGluZSB4MT0iMCIgeTE9Ii0yMC43MzYiIHgyPSIxNC42NjI1NjYyMTQ2ODQyNDkiIHkyPSItNi4wNzM0MzM3ODUzMTU3NTIiIHN0cm9rZT0icmdiKDcwLCA3MywgNzkpIiBzdHJva2Utd2lkdGg9IjYuNjI0MDAwMDAwMDAwMDAwNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PGxpbmUgeDE9IjAiIHkxPSItMjAuNzM2IiB4Mj0iLTE0LjY2MjU2NjIxNDY4NDI0OSIgeTI9Ii02LjA3MzQzMzc4NTMxNTc1MiIgc3Ryb2tlPSJyZ2IoNzAsIDczLCA3OSkiIHN0cm9rZS13aWR0aD0iNi42MjQwMDAwMDAwMDAwMDA2IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48bGluZSB4MT0iMCIgeTE9Ii0yMC43MzYiIHgyPSIwIiB5Mj0iMjAuNzM2IiBzdHJva2U9InJnYig3MCwgNzMsIDc5KSIgc3Ryb2tlLXdpZHRoPSI2LjYyNDAwMDAwMDAwMDAwMDYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjwvZz48L2c+PC9zdmc+">
<style>
:root{color-scheme:light dark;font-family:system-ui,"Microsoft YaHei",sans-serif;--bg:#eef1f5;--panel:#fff;--panel2:#f8f9fb;--text:#20242a;--muted:#68717d;--border:#ccd2da;--accent:#2457d6;--accent-soft:#eaf0ff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}.wrap{max-width:1500px;margin:auto;padding:18px}.topbar{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-bottom:14px}.topbar h1{margin:0;font-size:24px}.top-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.game-link{color:var(--accent);font-size:13px;overflow-wrap:anywhere}.dashboard{display:grid;grid-template-columns:minmax(280px,340px) minmax(0,1fr);gap:14px;align-items:start}.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:14px;box-shadow:0 8px 26px #0001}.side-column{display:grid;gap:14px;position:sticky;top:14px}.rooms-grid{display:grid;grid-template-columns:1fr;gap:14px}.room-card{cursor:pointer;transition:border-color .15s,box-shadow .15s}.room-card.selected{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 22%,transparent),0 8px 26px #0001}.room-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.room-title{font-size:18px;font-weight:700}.room-state{font-size:12px;color:var(--muted)}.codes{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}.code{border:1px solid var(--border);border-radius:10px;padding:10px;min-width:0}.code strong{display:block;font-size:27px;letter-spacing:.12em;font-variant-numeric:tabular-nums}.code-status{display:block;margin:3px 0 8px;color:var(--muted);font-size:12px}.code-buttons{display:grid;grid-template-columns:1fr;gap:5px}.room-actions{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}button{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid #aeb6c1;background:var(--panel);color:inherit;cursor:pointer}button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}button.danger{color:#a33a3a;border-color:#d7a0a0}button:disabled{opacity:.5;cursor:not-allowed}.muted{color:var(--muted)}.room-log{height:124px;overflow:auto;margin:0;padding:9px;border:1px solid var(--border);border-radius:8px;background:var(--panel2);font:11px/1.5 "Cascadia Mono",Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.chat-card{display:grid;grid-template-rows:auto auto minmax(80px,1fr) auto auto auto auto;gap:8px;position:relative;isolation:isolate;min-height:300px;max-height:calc(100dvh - 28px);overflow:hidden}.chat-card::before{content:"";position:absolute;inset:0;border-radius:inherit;background:var(--panel);border:1px solid transparent;z-index:-1;pointer-events:none}.chat-card.chat-bg-shake::before{animation:chat-bg-shake .5s cubic-bezier(.22,.72,.25,1)}@keyframes chat-bg-shake{0%,100%{transform:translateX(0);background:var(--panel)}14%{transform:translateX(-3px);background:color-mix(in srgb,#faefc0 28%,var(--panel))}32%{transform:translateX(4px);background:color-mix(in srgb,#faefc0 64%,var(--panel));box-shadow:0 0 0 3px color-mix(in srgb,#faefc0 22%,transparent)}52%{transform:translateX(-2px);background:color-mix(in srgb,#faefc0 42%,var(--panel))}72%{transform:translateX(1px);background:color-mix(in srgb,#faefc0 18%,var(--panel))}}.chat-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.chat-heading h2{margin:0;font-size:16px}.chat-room-select{width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:inherit}.chat-log-wrap{position:relative;height:100%;min-height:80px}.chat-log{height:100%;overflow:auto;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--panel2);font-size:12px}.chat-unread{position:absolute;right:10px;bottom:9px;z-index:3;border:1px solid #b89524;border-radius:999px;padding:5px 10px;background:var(--panel);color:#d0a91e;font-size:12px;font-weight:800;box-shadow:0 4px 14px #0003}.chat-empty{color:var(--muted);font-size:12px}.chat-message{padding:6px 4px;border-bottom:1px solid var(--border)}.chat-message:last-child{border-bottom:0}.chat-message.own{background:#dfeff2;border-radius:6px;padding-left:7px;padding-right:7px;color:#20242a}.chat-message.server{background:#f1f2d6;border-radius:6px;padding-left:7px;padding-right:7px;color:#20242a}.chat-meta{color:var(--muted);font-size:12px}.chat-content{margin-top:2px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.5}textarea{width:100%;min-height:76px;resize:vertical;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:inherit;font:12px/1.5 inherit}.chat-actions{display:flex;gap:7px;align-items:center}.chat-mode-button{flex:1;color:var(--muted);font-size:12px;white-space:normal;line-height:1.25}.chat-resize-handle{position:relative;height:10px;margin:0 -4px -5px;cursor:ns-resize;touch-action:none;border-radius:0 0 9px 9px}.chat-resize-handle:before,.chat-resize-handle:after{content:"";position:absolute;left:50%;width:42px;height:1px;transform:translateX(-50%);background:var(--border)}.chat-resize-handle:before{top:3px}.chat-resize-handle:after{top:6px}.chat-resize-handle:hover{background:var(--accent-soft)}body.resizing-chat,body.resizing-chat *{cursor:ns-resize!important;user-select:none!important}.notice{min-height:20px;color:var(--accent);font-size:12px}.console-card{grid-column:1/-1}.admin-modal{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:20px;background:#0007}.admin-modal-card{width:min(600px,100%);padding:24px;border:1px solid var(--border);border-radius:14px;background:var(--panel);box-shadow:0 16px 50px #0004}.admin-modal-card{text-align:left}.admin-modal-card h2{margin:0 0 18px;text-align:left}.admin-modal-card p{font-size:13px;line-height:1.7;overflow-wrap:anywhere}.admin-modal-actions{display:flex;justify-content:flex-end;margin-top:18px}.console-log{height:280px;overflow:auto;margin:0;padding:12px;border-radius:9px;background:#11151a;color:#dce5ef;font:12px/1.5 "Cascadia Mono",Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.hidden{display:none}
@media(max-width:900px){.dashboard{grid-template-columns:1fr}.side-column{position:static}.rooms-grid{grid-template-columns:1fr}.codes{grid-template-columns:1fr}.wrap{padding:9px}.topbar{align-items:flex-start;flex-direction:column}}
@media(prefers-color-scheme:dark){:root{--bg:#15181d;--panel:#20242a;--panel2:#191d22;--text:#e8ecf2;--muted:#aab2bd;--border:#444b55;--accent-soft:#26344f}.console-log{background:#0d1014}}
</style></head><body><main class="wrap">
<header class="topbar"><div><h1>双飞 v0.42.1 多房间服务端</h1><div class="muted">登录码自动绑定房间，客户端无需输入房间号。</div></div><div class="top-actions"><button id="createRoom" class="primary">新建房间</button><button id="aboutButton">关于</button><a id="gameLink" class="game-link" target="_blank">游戏端</a></div></header>
<div class="dashboard">
  <aside class="side-column">
    <section id="chatCard" class="card chat-card">
      <div class="chat-heading"><h2>局域网聊天</h2><span id="chatCount">0</span></div>
      <select id="chatRoomSelect" class="chat-room-select" aria-label="选择聊天房间"></select>
      <div class="chat-log-wrap"><div id="chatLog" class="chat-log" role="log" aria-live="polite"></div><button id="chatUnread" class="chat-unread hidden">未读 0</button></div>
      <textarea id="chatInput" maxlength="2000" placeholder=""></textarea>
      <div class="chat-actions"><button id="chatHint" class="chat-mode-button">当前：Enter发送</button><button id="sendChat" class="primary">发送</button></div>
      <div id="copyNotice" class="notice"></div>
      <div id="chatResizeHandle" class="chat-resize-handle" role="separator" aria-label="拖动调整聊天卡片高度" aria-orientation="horizontal"></div>
    </section>
  </aside>
  <section><div id="roomsGrid" class="rooms-grid"></div></section>
  <section class="card console-card"><h2>服务端控制台</h2><pre id="consoleLog" class="console-log"></pre></section>
</div>
<input id="importFile" class="hidden" type="file" accept="application/json,.json">
</main>
<div id="aboutModal" class="admin-modal hidden"><div class="admin-modal-card"><h2>关于</h2><p>by IQ Online Studio, github.com/iqonli/double-ludo</p><p>本项目使用MIT许可证。Copyright © 2026 IQ Online Studio.</p><div class="admin-modal-actions"><button id="closeAboutButton" class="primary">关闭</button></div></div></div>
<script>
const $=id=>document.getElementById(id);let latest=null;let selectedRoomId=null;let pendingImportRoomId=null;let chatSendKeyMode='enter';let lastChatByRoom=new Map();let unreadByRoom=new Map();let followByRoom=new Map();let lastNotice='';
async function api(path,body){const options=body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};const response=await fetch(path,options);let data=null;try{data=await response.json()}catch(_){data=null}if(!response.ok)throw new Error(data&&data.message?data.message:'HTTP '+response.status);return data}
function roomById(id){return latest&&Array.isArray(latest.rooms)?latest.rooms.find(r=>Number(r.roomId)===Number(id)):null}
function statusLabel(status){return status==='playing'?'对局中':status==='lobby'?'准备开局':'已关闭'}
function escapeText(value){return String(value==null?'':value)}
function copyText(value,label){if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(value).then(()=>notice('已复制'+label+'：'+value)).catch(e=>notice('复制失败：'+e.message));return}const t=document.createElement('textarea');t.value=value;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();notice('已复制'+label+'：'+value)}
function notice(text){lastNotice=text;$('copyNotice').textContent=text;setTimeout(()=>{if($('copyNotice').textContent===text)$('copyNotice').textContent=''},2200)}
function shakeChatBackground(){const card=$('chatCard');card.classList.remove('chat-bg-shake');void card.offsetWidth;card.classList.add('chat-bg-shake');setTimeout(()=>card.classList.remove('chat-bg-shake'),540)}
function renderRooms(){const grid=$('roomsGrid');grid.replaceChildren();const rooms=latest&&Array.isArray(latest.rooms)?latest.rooms:[];if(!rooms.length){const empty=document.createElement('div');empty.className='card muted';empty.textContent='暂无房间。';grid.appendChild(empty);return}for(const room of rooms){const card=document.createElement('article');card.className='card room-card'+(Number(room.roomId)===Number(selectedRoomId)?' selected':'');card.dataset.roomId=room.roomId;card.onclick=e=>{if(e.target.closest('button'))return;selectRoom(room.roomId)};const head=document.createElement('div');head.className='room-head';head.innerHTML='<div class="room-title">房间 '+room.roomId+'</div><div class="room-state">'+statusLabel(room.roomStatus)+' · v'+room.version+'</div>';card.appendChild(head);const codes=document.createElement('div');codes.className='codes';for(const role of ['A','B']){const code=room.codes&&room.codes[role]?room.codes[role]:'-----';const box=document.createElement('section');box.className='code';box.innerHTML='<span>玩家'+role+'登录码</span><strong>'+code+'</strong><span class="code-status">'+(room.connected&&room.connected[role]?'已登录':'未登录')+'</span>';const buttons=document.createElement('div');buttons.className='code-buttons';const copy=document.createElement('button');copy.textContent='复制登录码';copy.disabled=code==='-----';copy.onclick=()=>copyText(code,'登录码');const bundle=document.createElement('button');bundle.textContent='复制端口+登录码';bundle.disabled=code==='-----';bundle.onclick=()=>copyText(String(latest.port)+'-'+code,'端口+登录码');buttons.append(copy,bundle);box.appendChild(buttons);codes.appendChild(box)}card.appendChild(codes);const actions=document.createElement('div');actions.className='room-actions';const defs=room.roomStatus==='closed'?[['开房','open','primary']]:[['重新开局','restart',''],['刷新登录码','refresh',''],['导出对局','export',''],['恢复对局','import',''],['关闭房间','close','danger']];for(const def of defs){const b=document.createElement('button');b.textContent=def[0];if(def[2])b.className=def[2];b.onclick=()=>roomAction(room.roomId,def[1]);actions.appendChild(b)}card.appendChild(actions);const logTitle=document.createElement('div');logTitle.className='muted';logTitle.textContent='日志';card.appendChild(logTitle);const log=document.createElement('pre');log.className='room-log';log.textContent=Array.isArray(room.roomLog)&&room.roomLog.length?room.roomLog.join('\\n'):'暂无日志';card.appendChild(log);grid.appendChild(card)}}
function renderChat(){const rooms=latest&&Array.isArray(latest.rooms)?latest.rooms:[];const select=$('chatRoomSelect');select.replaceChildren();for(const room of rooms){const option=document.createElement('option');option.value=String(room.roomId);option.textContent='房间 '+room.roomId+' · '+statusLabel(room.roomStatus);select.appendChild(option)}if(!rooms.length){selectedRoomId=null}else if(!roomById(selectedRoomId)){selectedRoomId=rooms[0].roomId}select.value=String(selectedRoomId==null?'':selectedRoomId);const room=roomById(selectedRoomId);const roomId=Number(selectedRoomId);const log=$('chatLog');const near=followByRoom.get(roomId)!==false;const previousTop=log.scrollTop;const messages=room&&Array.isArray(room.chatMessages)?room.chatMessages:[];const newVersion=room?Number(room.chatVersion):-1;const oldVersion=lastChatByRoom.get(roomId);const incoming=oldVersion!==undefined&&newVersion>oldVersion&&messages.length&&messages[messages.length-1].player!=='SERVER';let unread=Number(unreadByRoom.get(roomId)||0);if(incoming){shakeChatBackground();unread=near?0:unread+Math.max(1,newVersion-oldVersion)}log.replaceChildren();$('chatCount').textContent=String(messages.length);if(!messages.length){const empty=document.createElement('div');empty.className='chat-empty';empty.textContent=room&&room.roomStatus!=='closed'?'暂无消息。':'请选择已开启的房间。';log.appendChild(empty)}else for(const msg of messages){const item=document.createElement('article');item.className='chat-message'+(msg.player==='SERVER'?' server':'');const meta=document.createElement('div');meta.className='chat-meta';meta.textContent=escapeText(msg.time)+' '+escapeText(msg.name)+':';const content=document.createElement('div');content.className='chat-content';content.textContent=escapeText(msg.content);item.append(meta,content);log.appendChild(item)}if(near)requestAnimationFrame(()=>{log.scrollTop=log.scrollHeight});else requestAnimationFrame(()=>{log.scrollTop=previousTop});unreadByRoom.set(roomId,unread);$('chatUnread').textContent='未读 '+unread;$('chatUnread').classList.toggle('hidden',unread<=0);const enabled=Boolean(room&&room.roomStatus!=='closed');$('chatInput').disabled=!enabled;$('chatHint').disabled=!enabled;$('sendChat').disabled=!enabled||!$('chatInput').value.trim();$('chatHint').textContent=enabled?'当前：'+(chatSendKeyMode==='enter'?'Enter':'Shift+Enter')+'发送':'请选择已开启房间';if(room)lastChatByRoom.set(roomId,newVersion)}
function paint(data){latest=data;if(selectedRoomId==null&&data.rooms&&data.rooms.length)selectedRoomId=data.rooms[0].roomId;$('gameLink').href=data.gameUrl||location.origin+'/game.html';$('gameLink').textContent=data.gameUrl||'游戏端';renderRooms();renderChat();const pre=$('consoleLog');const near=pre.scrollHeight-pre.clientHeight-pre.scrollTop<55;pre.textContent=data.consoleText||'';if(near)requestAnimationFrame(()=>{pre.scrollTop=pre.scrollHeight})}
async function status(){try{paint(await api('/api/admin/status'))}catch(e){notice('读取状态失败：'+e.message)}}
function selectRoom(roomId){selectedRoomId=Number(roomId);renderRooms();renderChat()}
async function roomAction(roomId,action){try{if(action==='export'){location.href='/api/admin/export-game?roomId='+encodeURIComponent(roomId)+'&download='+Date.now();return}if(action==='import'){pendingImportRoomId=Number(roomId);$('importFile').value='';$('importFile').click();return}const paths={open:'/api/admin/room/open',restart:'/api/admin/room/restart',refresh:'/api/admin/room/refresh-codes',close:'/api/admin/room/close'};paint(await api(paths[action],{roomId:Number(roomId)}));selectedRoomId=Number(roomId);notice('房间'+roomId+'操作完成')}catch(e){notice('操作失败：'+e.message);await status()}}
$('createRoom').onclick=async()=>{try{const data=await api('/api/admin/rooms/create',{});paint(data);selectedRoomId=data.createdRoomId;renderRooms();renderChat();notice('已新建房间'+data.createdRoomId)}catch(e){notice('新建失败：'+e.message)}};
$('chatRoomSelect').onchange=()=>selectRoom(Number($('chatRoomSelect').value));$('chatInput').oninput=renderChat;$('chatHint').onclick=()=>{chatSendKeyMode=chatSendKeyMode==='enter'?'shift-enter':'enter';renderChat()};$('sendChat').onclick=async()=>{const content=$('chatInput').value.replace(/\\r\\n?/g,'\\n').trim();if(!content||selectedRoomId==null)return;try{paint(await api('/api/admin/chat',{roomId:Number(selectedRoomId),content}));$('chatInput').value='';renderChat()}catch(e){notice('发送失败：'+e.message)}};$('chatInput').onkeydown=e=>{if(e.key!=='Enter')return;const send=chatSendKeyMode==='enter'?!e.shiftKey:e.shiftKey;if(send){e.preventDefault();$('sendChat').click()}};
$('chatUnread').onclick=()=>{const log=$('chatLog');const roomId=Number(selectedRoomId);unreadByRoom.set(roomId,0);followByRoom.set(roomId,true);$('chatUnread').classList.add('hidden');log.scrollTop=log.scrollHeight};$('chatLog').onscroll=()=>{const log=$('chatLog');const roomId=Number(selectedRoomId);const atBottom=log.scrollHeight-log.clientHeight-log.scrollTop<24;followByRoom.set(roomId,atBottom);if(atBottom){unreadByRoom.set(roomId,0);$('chatUnread').classList.add('hidden')}};$('aboutButton').onclick=()=>$('aboutModal').classList.remove('hidden');$('closeAboutButton').onclick=()=>$('aboutModal').classList.add('hidden');$('aboutModal').onclick=e=>{if(e.target===$('aboutModal'))$('aboutModal').classList.add('hidden')};$('importFile').onchange=async()=>{const file=$('importFile').files[0];if(!file||pendingImportRoomId==null)return;try{const parsed=JSON.parse(await file.text());paint(await api('/api/admin/import-game',{roomId:pendingImportRoomId,gameFile:parsed}));selectedRoomId=pendingImportRoomId;notice('已恢复：'+file.name)}catch(e){notice('恢复失败，原局未改变：'+e.message);await status()}finally{pendingImportRoomId=null}};
(()=>{const card=$('chatCard'),handle=$('chatResizeHandle');let startY=0,startHeight=0;try{const saved=Number(localStorage.getItem('doubleFlightAdminChatHeight'));if(Number.isFinite(saved)&&saved>=300)card.style.height=Math.min(saved,window.innerHeight-28)+'px'}catch(_){}const move=e=>{card.style.height=Math.max(300,Math.min(window.innerHeight-28,startHeight+e.clientY-startY))+'px'};const stop=()=>{document.body.classList.remove('resizing-chat');window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop);try{localStorage.setItem('doubleFlightAdminChatHeight',String(Math.round(card.getBoundingClientRect().height)))}catch(_){}};handle.onpointerdown=e=>{e.preventDefault();startY=e.clientY;startHeight=card.getBoundingClientRect().height;handle.setPointerCapture&&handle.setPointerCapture(e.pointerId);document.body.classList.add('resizing-chat');window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop,{once:true});window.addEventListener('pointercancel',stop,{once:true})}})();
status();setInterval(status,500);
</script></body></html>`;
}

function roomIdFromBody(body) {
  const roomId = Number(body && body.roomId);
  if (!Number.isInteger(roomId) || roomId < 1) throw new ApiError(400, 'INVALID_ROOM_ID', '房间号无效');
  return roomId;
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (pathname.startsWith('/api/admin/')) requireLocalAdmin(req);

  if (req.method === 'GET' && pathname === '/api/info') {
    return sendJson(res, 200, {
      ok: true,
      name: 'double-flight-lan-server',
      version: APP_VERSION,
      port: activePort,
      portMode: EXPLICIT_PORT === null ? 'random' : 'explicit',
      portRange: [PORT_MIN, PORT_MAX],
      roomCount: manager.rooms.size,
      roomStatus: manager.rooms.size ? 'multiroom' : 'closed',
      pollingIntervalMs: 500,
      autosave: true
    });
  }

  if (req.method === 'GET' && pathname === '/api/admin/status') return sendJson(res, 200, adminStatePayload());
  if (req.method === 'POST' && pathname === '/api/admin/rooms/create') {
    const room = mutate('create-room', () => manager.createRoom());
    return sendJson(res, 200, { ...adminStatePayload(), createdRoomId: room.roomId });
  }
  if (req.method === 'GET' && pathname === '/api/admin/export-game') {
    const roomId = Number(url.searchParams.get('roomId') || legacyRoomId());
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return sendJsonDownload(res, manager.exportRoom(roomId), `double-flight-room-${roomId}-${stamp}.json`);
  }
  if (req.method === 'POST' && pathname === '/api/admin/room/open') {
    const body = await jsonBody(req);
    return sendJson(res, 200, adminMutate('open-room', () => manager.openRoom(roomIdFromBody(body))));
  }
  if (req.method === 'POST' && pathname === '/api/admin/room/refresh-codes') {
    const body = await jsonBody(req);
    return sendJson(res, 200, adminMutate('refresh-codes', () => manager.refreshCodes(roomIdFromBody(body))));
  }
  if (req.method === 'POST' && pathname === '/api/admin/room/restart') {
    const body = await jsonBody(req);
    return sendJson(res, 200, adminMutate('restart-lobby', () => manager.restartRoom(roomIdFromBody(body))));
  }
  if (req.method === 'POST' && pathname === '/api/admin/room/close') {
    const body = await jsonBody(req);
    return sendJson(res, 200, adminMutate('close-room', () => manager.closeRoom(roomIdFromBody(body))));
  }
  if (req.method === 'POST' && pathname === '/api/admin/import-game') {
    const body = await jsonBody(req);
    const roomId = Number(body.roomId || legacyRoomId());
    return sendJson(res, 200, adminMutate('manual-import', () => manager.importRoom(roomId, body.gameFile || body)));
  }
  if (req.method === 'POST' && pathname === '/api/admin/chat') {
    const body = await jsonBody(req, 16 * 1024);
    const roomId = Number(body.roomId || legacyRoomId());
    mutate('server-chat', () => manager.sendServerChat(roomId, body.content));
    return sendJson(res, 200, adminStatePayload());
  }

  // Backward-compatible single-room admin aliases.
  if (req.method === 'POST' && pathname === '/api/admin/open') return sendJson(res, 200, adminMutate('open-room', () => manager.openRoom(legacyRoomId())));
  if (req.method === 'POST' && pathname === '/api/admin/refresh-codes') return sendJson(res, 200, adminMutate('refresh-codes', () => manager.refreshCodes(legacyRoomId())));
  if (req.method === 'POST' && pathname === '/api/admin/restart') return sendJson(res, 200, adminMutate('restart-lobby', () => manager.restartRoom(legacyRoomId())));
  if (req.method === 'POST' && pathname === '/api/admin/close') return sendJson(res, 200, adminMutate('close-room', () => manager.closeRoom(legacyRoomId())));

  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await jsonBody(req);
    return sendJson(res, 200, manager.login(body.code));
  }
  if (req.method === 'POST' && pathname === '/api/logout') {
    const body = await jsonBody(req);
    return sendJson(res, 200, manager.logout(body.sessionToken));
  }
  if (req.method === 'POST' && pathname === '/api/poll') {
    const body = await jsonBody(req);
    const payload = manager.poll(body.sessionToken, body.knownVersion, body.knownChatVersion);
    return payload ? sendJson(res, 200, payload) : sendNoContent(res);
  }
  if (req.method === 'POST' && pathname === '/api/chat') {
    const body = await jsonBody(req, 16 * 1024);
    return sendJson(res, 200, mutate('chat', () => manager.sendChat(body.sessionToken, body.content)));
  }
  if (req.method === 'POST' && pathname === '/api/lobby-config') {
    const body = await jsonBody(req);
    return sendJson(res, 200, mutate('lobby-config', () => manager.setLobbyConfig(body.sessionToken, body.config)));
  }
  if (req.method === 'POST' && pathname === '/api/lobby-ready') {
    const body = await jsonBody(req);
    return sendJson(res, 200, mutate('lobby-ready', () => manager.setLobbyReady(body.sessionToken, body.ready)));
  }
  if (req.method === 'POST' && pathname === '/api/lobby-order-roll') {
    const body = await jsonBody(req);
    return sendJson(res, 200, mutate('lobby-order-roll', () => manager.rollLobbyOrder(body.sessionToken)));
  }
  if (req.method === 'POST' && pathname === '/api/start-game') {
    const body = await jsonBody(req);
    return sendJson(res, 200, mutate('start-game', () => manager.startGame(body.sessionToken, body.config)));
  }
  if (req.method === 'POST' && pathname === '/api/action') {
    const body = await jsonBody(req);
    return sendJson(res, 200, mutate('action', () => manager.action(body.sessionToken, body)));
  }
  if (req.method === 'POST' && pathname === '/api/command') {
    const body = await jsonBody(req);
    return sendJson(res, 200, mutate('command', () => manager.command(body.sessionToken, body)));
  }
  if (req.method === 'POST' && pathname === '/api/undo-request') {
    const body = await jsonBody(req);
    return sendJson(res, 200, mutate('undo-request', () => manager.requestUndo(body.sessionToken)));
  }
  if (req.method === 'POST' && pathname === '/api/undo-response') {
    const body = await jsonBody(req);
    return sendJson(res, 200, mutate('undo-response', () => manager.respondUndo(body.sessionToken, Boolean(body.allow))));
  }
  if (req.method === 'POST' && pathname === '/api/defeat-regret-request') {
    const body = await jsonBody(req);
    return sendJson(res, 200, mutate('defeat-regret-request', () => manager.requestDefeatRegret(body.sessionToken)));
  }
  if (req.method === 'POST' && pathname === '/api/defeat-regret-response') {
    const body = await jsonBody(req);
    return sendJson(res, 200, mutate('defeat-regret-response', () => manager.respondDefeatRegret(body.sessionToken, Boolean(body.allow))));
  }
  throw new ApiError(404, 'NOT_FOUND', '接口不存在');
}

restoreAutosave();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...commonHeaders(),
        'Access-Control-Max-Age': '600'
      });
      return res.end();
    }
    if (url.pathname === '/admin') {
      requireLocalAdmin(req);
      const html = adminHtml();
      res.writeHead(200, {
        ...commonHeaders(),
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html)
      });
      return res.end(html);
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method === 'GET' && serveFile(req, res, url.pathname)) return;
    throw new ApiError(404, 'NOT_FOUND', '文件不存在');
  } catch (error) {
    sendError(res, error);
  }
});

server.requestTimeout = 10_000;
server.headersTimeout = 12_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 2_000;
server.on('clientError', (error, socket) => {
  console.error('客户端协议错误：', error.message);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

function randomLanPort(excluded = new Set()) {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const port = crypto.randomInt(PORT_MIN, PORT_MAX + 1);
    if (!excluded.has(port)) return port;
  }
  throw new Error('无法在6666到8888之间找到候选端口');
}

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

function announceServer() {
  console.log('='.repeat(68));
  console.log('双飞 v0.42.1 多房间局域网服务器已启动');
  console.log(`${EXPLICIT_PORT === null ? '本次随机端口' : '监听端口（已指定）'}：${activePort}`);
  console.log(`管理页面：http://127.0.0.1:${activePort}/admin`);
  console.log(`本机游戏：http://127.0.0.1:${activePort}/game.html`);
  console.log('也可直接双击 public/game.html，再输入服务器IP、端口和登录码。');
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) console.log(`局域网游戏：http://${entry.address}:${activePort}/game.html  (${name})`);
    }
  }
  console.log(`当前房间数：${manager.rooms.size}`);
  console.log(`自动存档：${AUTOSAVE_FILE}`);
  console.log('='.repeat(68));
}

async function startListening() {
  if (EXPLICIT_PORT !== null) {
    await listenOnce(EXPLICIT_PORT);
    activePort = EXPLICIT_PORT;
    announceServer();
    return;
  }
  const attempted = new Set();
  const capacity = PORT_MAX - PORT_MIN + 1;
  while (attempted.size < capacity) {
    const candidate = randomLanPort(attempted);
    attempted.add(candidate);
    try {
      await listenOnce(candidate);
      activePort = candidate;
      announceServer();
      return;
    } catch (error) {
      if (error && error.code === 'EADDRINUSE') continue;
      throw error;
    }
  }
  throw new Error('6666到8888之间没有可用端口');
}

startListening().catch(error => {
  console.error('服务器启动失败：', error);
  persistRooms('startup-error');
  process.exitCode = 1;
});

server.on('error', error => {
  if (!activePort && error && error.code === 'EADDRINUSE') return;
  console.error('服务器运行错误：', error);
  persistRooms('server-error');
});

function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n收到${signal}，正在保存并关闭服务器……`);
  persistRooms(`shutdown-${signal}`);
  server.close(() => process.exit(exitCode));
  setTimeout(() => process.exit(exitCode || 1), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', reason => {
  console.error('未处理的Promise异常：', reason);
  persistRooms('unhandled-rejection');
});
process.on('uncaughtException', error => {
  console.error('未捕获异常，服务端将安全退出：', error);
  shutdown('uncaughtException', 1);
});
