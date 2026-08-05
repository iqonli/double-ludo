'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(root, 'public', 'admin.js'), 'utf8');
const adminCss = fs.readFileSync(path.join(root, 'public', 'admin.css'), 'utf8');

test('服务端管理页、多房间、随机端口、聊天与自动存档接口完整', () => {
  assert(adminHtml.includes('id="createRoom"'));
  assert(adminJs.includes('恢复对局'));
  assert(serverSource.includes('/api/admin/export-game'));
  assert(serverSource.includes('/api/admin/import-game'));
  assert(serverSource.includes('/api/admin/rooms/create'));
  assert(serverSource.includes('/api/admin/room/refresh-codes'));
  assert(serverSource.includes('autosave.json'));
  assert(serverSource.includes("process.on('uncaughtException'"));
  assert(serverSource.includes('const PORT_MIN = 6666') && serverSource.includes('const PORT_MAX = 8888'));
  assert(serverSource.includes('randomLanPort') && serverSource.includes("error.code === 'EADDRINUSE'"));
  assert(serverSource.includes("pathname === '/api/chat'"));
  assert(adminHtml.includes('选择聊天房间') && adminHtml.includes('chatRoomSelect'));
});

test('独立管理页脚本可解析，不会卡在正在读取状态', () => {
  assert(serverSource.includes("path.join(PUBLIC_DIR, 'admin.html')"));
  assert.doesNotThrow(() => new vm.Script(adminJs));
});

test('服务端聊天抖动只作用于背景层且字号与game端一致', () => {
  assert(adminCss.includes('.chat-card::before'));
  assert(adminCss.includes('.chat-card.chat-bg-shake::before'));
  assert(adminCss.includes('.chat-content{') && adminCss.includes('font-size:12px'));
});

test('服务端管理页包含关于按钮、MIT声明和在线语料切换', () => {
  assert(adminHtml.includes('id="aboutButton"'));
  assert(adminHtml.includes('id="aboutModal"'));
  assert(adminCss.includes('.admin-modal-card h2'));
  assert(serverSource.includes("pathname === '/api/lobby-ready'"));
  assert(adminJs.includes('by IQ Online Studio'));
  assert(adminJs.includes('本项目使用MIT许可证。Copyright © 2026 IQ Online Studio.'));
  assert(adminJs.includes("latest.onlineMode"));
  assert(adminJs.includes("$('chatTitle').textContent=online?'联机聊天':'局域网聊天'"));
});

test('服务端包含Render账号、每IP五账号、长轮询和受保护管理页', () => {
  assert(serverSource.includes("pathname === '/api/account/login'"));
  assert(serverSource.includes("pathname === '/api/account/room/create'"));
  assert(serverSource.includes("pathname === '/api/account/room/export'"));
  assert(serverSource.includes("pathname === '/api/account/room/import'"));
  assert(serverSource.includes('ACCOUNT_ROOM_LIMIT'));
  assert(serverSource.includes('IP_ACCOUNT_LIMIT'));
  assert(!serverSource.includes('IP_ROOM_LIMIT'));
  assert(serverSource.includes('LONG_POLL_TIMEOUT_MS'));
  assert(serverSource.includes('manager.waitForUpdate'));
  assert(serverSource.includes('ADMIN_PASSWORD'));
  assert(serverSource.includes("relative = ONLINE_MODE ? 'host.html' : 'game.html'"));
});

test('服务端版本和管理页更新到0.42.2', () => {
  assert(serverSource.includes("const APP_VERSION = '0.42.2'"));
  assert(serverSource.includes('双飞 v0.42.2'));
  assert(adminHtml.includes('v__APP_VERSION__'));
  assert(adminHtml.includes('rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,'));
});

test('在线登录限速在校验登录码前执行且窗口为1秒', () => {
  const loginRouteStart = serverSource.indexOf("pathname === '/api/login'");
  const limiterIndex = serverSource.indexOf('loginLimiter.assertAllowed(identity.key)', loginRouteStart);
  const verifyIndex = serverSource.indexOf('manager.login(body.code, identity)', loginRouteStart);
  assert(loginRouteStart >= 0 && limiterIndex > loginRouteStart && verifyIndex > limiterIndex);
  assert(serverSource.includes('new FailedLoginLimiter(LOGIN_FAILURE_WINDOW_MS)'));
  assert(fs.existsSync(path.join(root, 'render.yaml')));
  assert(fs.existsSync(path.join(root, 'RENDER_DEPLOY.md')));
  assert(fs.existsSync(path.join(root, 'PLAYER_NOTICE.md')));
});

test('Render服务固定为dlol且管理页缺少密码时给出明确配置提示', () => {
  const renderYaml = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
  assert(renderYaml.includes('name: dlol'));
  assert(renderYaml.includes('value: https://dlol.onrender.com'));
  assert(serverSource.includes('ADMIN_NOT_CONFIGURED'));
  assert(serverSource.includes('adminNotConfiguredHtml'));
  assert(adminHtml.includes('<script src="/request-retry.js"></script>'));
  assert(adminJs.includes('DoubleLudoRequestRetry'));
});

test('管理页账号区域显示完整IP并可删除账号，复制按钮带气泡', () => {
  assert(adminHtml.includes('id="accountsCard"') && adminHtml.includes('账号管理'));
  assert(adminJs.includes('account.ownerIpAddress'));
  assert(adminJs.includes("'/api/admin/account/delete'"));
  assert(adminJs.includes('showCopyPop'));
  assert(adminHtml.includes('id="copyPop"'));
});


test('联机管理页显示在线玩家完整IP列表，公开状态只返回数量', () => {
  assert(adminHtml.includes('id="onlinePlayersCard"'));
  assert(adminHtml.includes('在线玩家IP列表'));
  assert(adminJs.includes('function renderOnlinePlayers()'));
  assert(adminJs.includes('player.ipAddress'));
  assert(serverSource.includes('onlinePlayers: ONLINE_MODE ? manager.onlinePlayers()'));
  assert(serverSource.includes('onlinePlayerCount: manager.onlinePlayerCount()'));
  assert(serverSource.includes('activeRoomCount: manager.activeRoomCount()'));
});

test('管理页和游戏页具有手机及窄容器适配规则', () => {
  assert(adminCss.includes('@media(max-width:720px)'));
  assert(adminCss.includes('.online-players-list'));
  const gameCss = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
  assert(gameCss.includes('comprehensive narrow-container/mobile adaptation'));
  assert(gameCss.includes('@media (max-width: 520px)'));
});

test('管理页使用响应式自定义确认弹窗且不会在窄屏铺满', () => {
  assert(adminHtml.includes('id="adminConfirmModal"'));
  assert(adminHtml.includes('id="adminConfirmMessage"'));
  assert(adminJs.includes('function askConfirm('));
  assert(!adminJs.includes('confirm('));
  assert(adminCss.includes('Responsive modal hardening'));
  assert(adminCss.includes('max-height:calc(100dvh - 28px)'));
  assert(adminCss.includes('env(safe-area-inset-left)'));
});
