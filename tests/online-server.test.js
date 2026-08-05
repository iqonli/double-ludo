'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AuthManager, onlineLoginCode, ONLINE_CODE_LETTERS } = require('../server/auth.js');
const { LanRoom } = require('../server/room.js');
const { RoomManager } = require('../server/room-manager.js');
const {
  AccountManager,
  FailedLoginLimiter,
  ACCOUNT_ROOM_LIMIT,
  IP_ACCOUNT_LIMIT,
  LOGIN_FAILURE_WINDOW_MS
} = require('../server/online-service.js');

test('在线登录码为5位数字加非I/L/O大写字母，并允许小写登录', () => {
  const generated = new Set();
  for (let index = 0; index < 200; index += 1) {
    const code = onlineLoginCode(generated);
    assert.match(code, /^\d{5}[A-HJ-KM-NP-Z]$/);
    assert(ONLINE_CODE_LETTERS.includes(code.at(-1)));
    generated.add(code);
  }
  const auth = new AuthManager({ codeMode: 'online' });
  const codes = auth.refreshCodes();
  const login = auth.login(codes.A.toLowerCase());
  assert.equal(auth.validate(login.token), 'A');
});

test('账号由密码识别，新IP接管后旧管理会话失效且房间归属可转移', async () => {
  const accounts = new AccountManager({ accountKeySecret: 'test-secret' });
  const manager = new RoomManager({ onlineMode: true });
  const first = await accounts.login('abcdefgh', 'ip-a', '192.0.2.1', '192.0.2.*');
  const room = manager.createRoom({ ownerAccountId: first.account.id, createdByIpKey: 'ip-a', createdByIpAddress: '192.0.2.1', createdByIpMasked: '192.0.2.*' });
  assert.equal(first.created, true);
  assert.equal(accounts.validate(first.sessionToken, 'ip-a').id, first.account.id);

  const second = await accounts.login('abcdefgh', 'ip-b', '198.51.100.7', '198.51.100.*');
  assert.equal(second.created, false);
  assert.equal(second.takenOver, true);
  manager.transferAccountRooms(second.account.id, { key: 'ip-b', address: '198.51.100.7', masked: '198.51.100.*' });
  assert.throws(() => accounts.validate(first.sessionToken, 'ip-a'), error => error.code === 'ACCOUNT_SESSION_INVALID');
  assert.equal(accounts.validate(second.sessionToken, 'ip-b').id, first.account.id);
  assert.equal(accounts.countOwnedAccounts('ip-a'), 0);
  assert.equal(accounts.countOwnedAccounts('ip-b'), 1);
  assert.equal(room.createdByIpKey, 'ip-b');
  assert.equal(room.createdByIpAddress, '198.51.100.7');
  await assert.rejects(() => accounts.login('short', 'ip-c'), error => error.code === 'ACCOUNT_PASSWORD_TOO_SHORT');
});

test('同一IP同时只能管理一个账号，但最多拥有5个账号', async () => {
  const accounts = new AccountManager({ accountKeySecret: 'single-active-test' });
  const first = await accounts.login('account-0001', 'ip-a', '203.0.113.2', '203.0.113.*');
  const second = await accounts.login('account-0002', 'ip-a', '203.0.113.2', '203.0.113.*');
  assert.throws(() => accounts.validate(first.sessionToken, 'ip-a'), error => error.code === 'ACCOUNT_SESSION_INVALID');
  assert.equal(accounts.validate(second.sessionToken, 'ip-a').id, second.account.id);
  assert.equal(accounts.countOwnedAccounts('ip-a'), 2);

  await accounts.login('account-0003', 'ip-a', '203.0.113.2', '203.0.113.*');
  await accounts.login('account-0004', 'ip-a', '203.0.113.2', '203.0.113.*');
  await accounts.login('account-0005', 'ip-a', '203.0.113.2', '203.0.113.*');
  const sixth = await accounts.login('account-0006', 'ip-a', '203.0.113.2', '203.0.113.*');
  assert.equal(IP_ACCOUNT_LIMIT, 5);
  assert.equal(accounts.countOwnedAccounts('ip-a'), 5);
  assert.equal(sixth.evictedAccounts.length, 1);
  assert.equal(sixth.evictedAccounts[0].id, first.account.id);
  assert.equal(accounts.getById(first.account.id), null);
});

test('删除第6个账号挤出的最早账号房间会使玩家会话失效', async () => {
  const accounts = new AccountManager({ accountKeySecret: 'eviction-room-test' });
  const manager = new RoomManager({ onlineMode: true });
  const first = await accounts.login('old-account', 'ip-a', '203.0.113.3', '203.0.113.*');
  const room = manager.createRoom({ ownerAccountId: first.account.id, createdByIpKey: 'ip-a', createdByIpAddress: '203.0.113.3' });
  const joined = room.login(room.auth.publicCodes().A);
  for (let index = 2; index <= 5; index += 1) await accounts.login(`account-000${index}`, 'ip-a', '203.0.113.3', '203.0.113.*');
  const sixth = await accounts.login('account-0006', 'ip-a', '203.0.113.3', '203.0.113.*');
  for (const evicted of sixth.evictedAccounts) manager.deleteRoomsForAccount(evicted.id);
  assert.equal(manager.rooms.size, 0);
  assert.throws(() => room.validate(joined.sessionToken), error => error.code === 'SESSION_INVALID');
});

test('在线房间限制仅按账号计算，每个账号最多5房', () => {
  assert.equal(ACCOUNT_ROOM_LIMIT, 5);
  const manager = new RoomManager({ onlineMode: true });
  for (let index = 0; index < 5; index += 1) {
    manager.createRoom({ ownerAccountId: 'acct-a', createdByIpKey: 'ip-a', createdByIpAddress: '192.0.2.1' });
  }
  assert.equal(manager.countRoomsForAccount('acct-a'), 5);
  assert.equal(manager.countRoomsForCreatorIp('ip-a'), 5);
  for (const room of manager.rooms.values()) assert.match(room.auth.publicCodes().A, /^\d{5}[A-HJ-KM-NP-Z]$/);
});

test('失败登录限速只记录失败并在1秒后恢复', () => {
  assert.equal(LOGIN_FAILURE_WINDOW_MS, 1000);
  const limiter = new FailedLoginLimiter();
  limiter.assertAllowed('ip', 1000);
  limiter.recordFailure('ip', 1000);
  assert.throws(() => limiter.assertAllowed('ip', 1500), error => error.code === 'LOGIN_RATE_LIMITED');
  limiter.assertAllowed('ip', 2000);
  limiter.recordSuccess('ip');
  limiter.assertAllowed('ip', 2001);
});

test('长轮询在房间变化时立即唤醒，等待器不会残留', async () => {
  const room = new LanRoom(1, { codeMode: 'online' });
  const opened = room.open();
  const a = room.login(opened.codes.A);
  const version = room.version;
  const chatVersion = room.chatVersion;
  const waiting = room.waitForUpdate(a.sessionToken, version, chatVersion, 1000);
  setTimeout(() => room.sendServerChat('唤醒'), 20);
  const reason = await waiting;
  assert.equal(reason, 'chat');
  assert.equal(room.pollWaiters.size, 0);
  assert(room.poll(a.sessionToken, version, chatVersion));
});

test('客户端关闭长轮询响应后立即移除等待器', async () => {
  const room = new LanRoom(2, { codeMode: 'online' });
  const opened = room.open();
  const a = room.login(opened.codes.A);
  const response = new EventEmitter();
  const waiting = room.waitForUpdate(a.sessionToken, room.version, room.chatVersion, 5000, null, response);
  assert.equal(room.pollWaiters.size, 1);
  response.emit('close');
  assert.equal(await waiting, 'closed');
  assert.equal(room.pollWaiters.size, 0);
});

test('双方停止请求超过15分钟的在线房间可被清理', () => {
  const manager = new RoomManager({ onlineMode: true });
  const room = manager.createRoom({ ownerAccountId: 'acct', createdByIpKey: 'ip', createdAt: 1000 });
  room.createdAt = 1000;
  room.playerLastSeenAt = { A: null, B: null };
  assert.equal(manager.cleanupInactive(1000 + 15 * 60 * 1000, 15 * 60 * 1000).length, 0);
  assert.equal(manager.cleanupInactive(1001 + 15 * 60 * 1000, 15 * 60 * 1000).length, 1);
  assert.equal(manager.rooms.size, 0);
});
