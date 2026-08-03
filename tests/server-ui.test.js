'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('服务端管理页、多房间、随机端口、聊天与自动存档接口完整', () => {
  assert(serverSource.includes('新建房间'));
  assert(serverSource.includes('恢复对局'));
  assert(serverSource.includes('/api/admin/export-game'));
  assert(serverSource.includes('/api/admin/import-game'));
  assert(serverSource.includes('/api/admin/rooms/create'));
  assert(serverSource.includes('/api/admin/room/refresh-codes'));
  assert(serverSource.includes('autosave.json'));
  assert(serverSource.includes("process.on('uncaughtException'"));
  assert(serverSource.includes('const PORT_MIN = 6666') && serverSource.includes('const PORT_MAX = 8888'));
  assert(serverSource.includes('randomLanPort') && serverSource.includes("error.code === 'EADDRINUSE'"));
  assert(serverSource.includes("pathname === '/api/chat'"));
  assert(serverSource.includes('选择聊天房间') && serverSource.includes('chatRoomSelect'));
});

test('嵌入式管理页脚本可解析，不会卡在正在读取状态', () => {
  const adminTemplate = serverSource.match(/return `<!doctype html>[\s\S]*?<\/html>`;/);
  assert(adminTemplate, '应包含嵌入式管理页');
  const adminHtml = adminTemplate[0].slice('return `'.length, -2);
  const scriptMatch = adminHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert(scriptMatch, '管理页应包含脚本');
  assert.doesNotThrow(() => new vm.Script(scriptMatch[1]));
});

test('服务端聊天抖动只作用于背景层且字号与game端一致', () => {
  assert(serverSource.includes('.chat-card::before'));
  assert(serverSource.includes('.chat-card.chat-bg-shake::before'));
  assert(!serverSource.includes('.chat-panel-shake{animation'));
  assert(serverSource.includes('.chat-content{') && serverSource.includes('font-size:12px'));
});

test('服务端管理页包含关于按钮和MIT声明', () => {
  assert(serverSource.includes('id="aboutButton"'));
  assert(serverSource.includes('id="aboutModal"'));
  assert(serverSource.includes('.admin-modal-card h2{margin:0 0 18px;text-align:left}'));
  assert(serverSource.includes("pathname === '/api/lobby-ready'"));
  assert(serverSource.includes('by IQ Online Studio, github.com/iqonli/double-ludo'));
  assert(serverSource.includes('本项目使用MIT许可证。Copyright © 2026 IQ Online Studio.'));
});


test('服务端版本和标签页图标更新到0.42.1', () => {
  assert(serverSource.includes("const APP_VERSION = '0.42.1'"));
  assert(serverSource.includes('双飞 v0.42.1 多房间服务端'));
  assert(serverSource.includes('rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,'));
});
