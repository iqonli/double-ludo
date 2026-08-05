'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务端提前退出：${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/info`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('等待测试服务端启动超时');
}

async function jsonRequest(baseUrl, pathname, body, ip, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (ip) headers['X-Forwarded-For'] = ip;
  if (options.authorization) headers.Authorization = options.authorization;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = null;
  try { payload = await response.json(); } catch (_) {}
  return { response, payload };
}

test('在线HTTP账号接管、五账号淘汰、导入导出、玩家踢出和1秒限速', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const root = path.join(__dirname, '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      ONLINE_MODE: 'true',
      PORT: String(port),
      HOST: '127.0.0.1',
      PUBLIC_BASE_URL: baseUrl,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'test-admin-password',
      IP_KEY_SECRET: 'http-test-ip-secret',
      ACCOUNT_KEY_SECRET: 'http-test-account-secret'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  try {
    await waitForServer(baseUrl, child);

    const rootPage = await fetch(`${baseUrl}/`);
    assert.equal(rootPage.status, 200);
    assert.match(await rootPage.text(), /双飞联机服务器-联机开房/);

    const adminUnauthorized = await fetch(`${baseUrl}/admin`);
    assert.equal(adminUnauthorized.status, 401);
    const auth = `Basic ${Buffer.from('admin:test-admin-password').toString('base64')}`;
    const adminPage = await fetch(`${baseUrl}/admin`, { headers: { Authorization: auth } });
    assert.equal(adminPage.status, 200);
    assert.match(await adminPage.text(), /admin\.js/);

    const aLogin = await jsonRequest(baseUrl, '/api/account/login', { password: 'account-alpha' }, '192.0.2.10');
    assert.equal(aLogin.response.status, 200);
    const tokenA = aLogin.payload.sessionToken;

    const created = await jsonRequest(baseUrl, '/api/account/room/create', { sessionToken: tokenA }, '192.0.2.10');
    assert.equal(created.response.status, 200);
    const roomId = created.payload.createdRoom.roomId;
    const playerCode = created.payload.createdRoom.codes.A;
    assert.equal(created.payload.ownerIpAddress, '192.0.2.10');

    const playerLogin = await jsonRequest(baseUrl, '/api/login', { code: playerCode.toLowerCase() }, '203.0.113.50');
    assert.equal(playerLogin.response.status, 200);
    const playerToken = playerLogin.payload.sessionToken;

    const publicInfo = await jsonRequest(baseUrl, '/api/info', undefined, null, { method: 'GET' });
    assert.equal(publicInfo.response.status, 200);
    assert.equal(publicInfo.payload.activeRoomCount, 1);
    assert.equal(publicInfo.payload.onlinePlayerCount, 1);

    const earlyAdminStatus = await jsonRequest(baseUrl, '/api/admin/status', undefined, null, { method: 'GET', authorization: auth });
    assert.equal(earlyAdminStatus.response.status, 200);
    assert.equal(earlyAdminStatus.payload.onlinePlayers.length, 1);
    assert.equal(earlyAdminStatus.payload.onlinePlayers[0].ipAddress, '203.0.113.50');
    assert.equal(earlyAdminStatus.payload.onlinePlayers[0].roomId, roomId);
    assert.equal(earlyAdminStatus.payload.onlinePlayers[0].role, 'A');

    const exported = await jsonRequest(baseUrl, '/api/account/room/export', { sessionToken: tokenA, roomId }, '192.0.2.10');
    assert.equal(exported.response.status, 200);
    assert.equal(exported.payload.gameFile.appVersion, '0.42.2');
    const imported = await jsonRequest(baseUrl, '/api/account/room/import', { sessionToken: tokenA, roomId, gameFile: exported.payload.gameFile }, '192.0.2.10');
    assert.equal(imported.response.status, 200);

    const takeover = await jsonRequest(baseUrl, '/api/account/login', { password: 'account-alpha' }, '198.51.100.20');
    assert.equal(takeover.response.status, 200);
    assert.equal(takeover.payload.takenOver, true);
    assert.equal(takeover.payload.ownerIpAddress, '198.51.100.20');
    assert.equal(takeover.payload.rooms[0].ownerIpAddress, '198.51.100.20');

    const oldState = await jsonRequest(baseUrl, '/api/account/state', { sessionToken: tokenA }, '192.0.2.10');
    assert.equal(oldState.response.status, 401);

    let currentToken = takeover.payload.sessionToken;
    for (let index = 2; index <= 5; index += 1) {
      const login = await jsonRequest(baseUrl, '/api/account/login', { password: `account-000${index}` }, '198.51.100.20');
      assert.equal(login.response.status, 200);
      currentToken = login.payload.sessionToken;
      assert.equal(login.payload.ipAccountCount, index);
    }
    const sixth = await jsonRequest(baseUrl, '/api/account/login', { password: 'account-0006' }, '198.51.100.20');
    assert.equal(sixth.response.status, 200);
    assert.equal(sixth.payload.ipAccountCount, 5);
    assert.equal(sixth.payload.evictedAccounts.length, 1);
    assert.deepEqual(sixth.payload.evictedAccounts[0].deletedRoomIds, [roomId]);

    const playerPoll = await jsonRequest(baseUrl, '/api/poll', { sessionToken: playerToken, knownVersion: 0, knownChatVersion: 0 }, '203.0.113.50');
    assert.equal(playerPoll.response.status, 401);

    const wrong1 = await jsonRequest(baseUrl, '/api/login', { code: '00000A' }, '203.0.113.99');
    assert.equal(wrong1.response.status, 401);
    const wrong2 = await jsonRequest(baseUrl, '/api/login', { code: '00000B' }, '203.0.113.99');
    assert.equal(wrong2.response.status, 429);
    await new Promise(resolve => setTimeout(resolve, 1050));
    const wrong3 = await jsonRequest(baseUrl, '/api/login', { code: '00000C' }, '203.0.113.99');
    assert.equal(wrong3.response.status, 401);

    const adminStatus = await jsonRequest(baseUrl, '/api/admin/status', undefined, null, { method: 'GET', authorization: auth });
    assert.equal(adminStatus.response.status, 200);
    assert.equal(adminStatus.payload.onlineMode, true);
    assert.equal(adminStatus.payload.accounts.length, 5);
    assert(adminStatus.payload.accounts.every(account => account.ownerIpAddress === '198.51.100.20'));
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (child.exitCode && child.exitCode !== 0) throw new Error(output);
  }
});
