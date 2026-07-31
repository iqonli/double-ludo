'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthManager } = require('../server/auth.js');
const { LanRoom } = require('../server/room.js');

const CONFIG = {
  mode: 'classic',
  playerAColors: ['red', 'yellow'],
  protectedColors: [],
  launchValues: [5, 6],
  tripleSixPenalty: true,
  firstPlayer: 'A'
};

function readyPlayerB(room, opened) {
  const b = room.login(opened.codes.B);
  room.setLobbyReady(b.sessionToken, true);
  return b;
}

test('登录码为两个不同的五位数字，刷新后旧会话失效', () => {
  const auth = new AuthManager();
  const first = auth.refreshCodes();
  assert.match(first.A, /^\d{5}$/);
  assert.match(first.B, /^\d{5}$/);
  assert.notEqual(first.A, first.B);
  const login = auth.login(first.A);
  assert.equal(auth.validate(login.token), 'A');
  const second = auth.refreshCodes();
  assert.notEqual(second.epoch, first.epoch);
  assert.throws(() => auth.validate(login.token), error => error.code === 'SESSION_INVALID');
  assert.throws(() => auth.login(first.A), error => error.code === 'INVALID_LOGIN_CODE');
});

test('同一登录码再次登录会使旧会话失效', () => {
  const auth = new AuthManager();
  const codes = auth.refreshCodes();
  const first = auth.login(codes.A);
  const second = auth.login(codes.A);
  assert.notEqual(first.token, second.token);
  assert.throws(() => auth.validate(first.token), error => error.code === 'SESSION_INVALID');
  assert.equal(auth.validate(second.token), 'A');
});

test('房间支持开房、A设置游戏、权威动作与重复动作去重', () => {
  const room = new LanRoom();
  const opened = room.open();
  assert.equal(opened.roomStatus, 'lobby');
  const a = room.login(opened.codes.A);
  const b = readyPlayerB(room, opened);
  const started = room.startGame(a.sessionToken, CONFIG);
  assert.equal(started.roomStatus, 'playing');
  assert.equal(started.player, 'A');
  assert(started.legalActions.includes(0));

  const actionRequest = {
    clientActionId: 'test-action-0001',
    expectedVersion: started.version,
    expectedStateHash: started.stateHash,
    actionCode: 0
  };
  const moved = room.action(a.sessionToken, actionRequest);
  assert(moved.version > started.version);
  const duplicate = room.action(a.sessionToken, actionRequest);
  assert.equal(duplicate.version, moved.version);
  assert.equal(duplicate.stateHash, moved.stateHash);

  assert.throws(() => room.action(a.sessionToken, {
    ...actionRequest,
    clientActionId: 'test-action-stale',
    expectedVersion: started.version
  }), error => error.code === 'STALE_STATE');

  const polled = room.poll(b.sessionToken, -1, -1);
  assert.equal(polled.version, moved.version);
  assert.equal(room.poll(b.sessionToken, moved.version, polled.chatVersion), null);
});


test('局域网聊天支持多行内容并独立于棋局版本', () => {
  const room = new LanRoom();
  const opened = room.open();
  const a = room.login(opened.codes.A);
  const b = room.login(opened.codes.B);
  const gameVersion = room.version;
  const chatBefore = room.chatVersion;
  const sent = room.sendChat(a.sessionToken, '快点准备！！\n第二行');
  assert.equal(room.version, gameVersion, '聊天不应改变棋局版本');
  assert(sent.chatVersion > chatBefore);
  assert.equal(sent.chatMessages.at(-1).name, '玩家A');
  assert.equal(sent.chatMessages.at(-1).content, '快点准备！！\n第二行');
  assert.match(sent.chatMessages.at(-1).time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const polled = room.poll(b.sessionToken, gameVersion, chatBefore);
  assert.equal(polled.chatMessages.at(-1).content, '快点准备！！\n第二行');
  assert.equal(room.poll(b.sessionToken, gameVersion, polled.chatVersion), null);
  assert.throws(() => room.sendChat(a.sessionToken, '   '), error => error.code === 'EMPTY_CHAT');
});

test('玩家A必须等待玩家B准备，任一方更新设置后准备状态重置', () => {
  const room = new LanRoom();
  const opened = room.open();
  const a = room.login(opened.codes.A);
  const b = room.login(opened.codes.B);
  assert.throws(() => room.startGame(a.sessionToken, CONFIG), error => error.code === 'PLAYER_B_NOT_READY');
  const ready = room.setLobbyReady(b.sessionToken, true);
  assert.equal(ready.lobbyReady.B, true);
  const changed = room.setLobbyConfig(a.sessionToken, CONFIG);
  assert.equal(changed.lobbyReady.B, false);
  room.setLobbyReady(b.sessionToken, true);
  const started = room.startGame(a.sessionToken, CONFIG);
  assert.equal(started.roomStatus, 'playing');
});

test('玩家B不能替玩家A开始游戏', () => {
  const room = new LanRoom();
  const opened = room.open();
  const b = room.login(opened.codes.B);
  assert.throws(() => room.startGame(b.sessionToken, CONFIG), error => error.code === 'PLAYER_A_ONLY');
});

test('刷新登录码保留棋局但使两方重新登录', () => {
  const room = new LanRoom();
  const opened = room.open();
  const a = room.login(opened.codes.A);
  const b = readyPlayerB(room, opened);
  room.startGame(a.sessionToken, CONFIG);
  const beforeHash = room.adminState().stateHash;
  const refreshed = room.refreshCodes();
  assert.equal(refreshed.roomStatus, 'playing');
  assert.equal(refreshed.stateHash, beforeHash);
  assert.throws(() => room.poll(a.sessionToken, -1), error => error.code === 'SESSION_INVALID');
  assert.throws(() => room.poll(b.sessionToken, -1), error => error.code === 'SESSION_INVALID');
});

test('对局可以导出、宽松修改并恢复，且不包含登录令牌', () => {
  const room = new LanRoom();
  const opened = room.open();
  const a = room.login(opened.codes.A);
  readyPlayerB(room, opened);
  room.startGame(a.sessionToken, CONFIG);
  const exported = room.exportGame();
  assert.equal(exported.format, 'double-flight-lan-save');
  assert.equal(exported.roomStatus, 'playing');
  assert(exported.game && exported.game.snapshot);
  assert.equal(JSON.stringify(exported).includes(a.sessionToken), false);

  exported.game.snapshot.turnNumber = 77;
  exported.game.snapshot.messages.push('手工修改的对局文件');
  const beforeVersion = room.version;
  const restored = room.importGame(exported);
  assert.equal(restored.roomStatus, 'playing');
  assert(restored.version > beforeVersion);
  assert.equal(room.serverEngine.snapshot().turnNumber, 77);
  assert(room.serverEngine.snapshot().messages.includes('手工修改的对局文件'));
});

test('损坏对局导入失败时不覆盖当前棋局', () => {
  const room = new LanRoom();
  const opened = room.open();
  const a = room.login(opened.codes.A);
  readyPlayerB(room, opened);
  room.startGame(a.sessionToken, CONFIG);
  const before = room.exportGame();
  const beforeHash = room.adminState().stateHash;
  assert.throws(() => room.importGame({ game: { snapshot: { bad: true } } }), error => error.code === 'INVALID_SAVE');
  assert.equal(room.adminState().stateHash, beforeHash);
  assert.deepEqual(room.exportGame().game.snapshot, before.game.snapshot);
});

test('启动恢复可刷新登录码并保留对局', () => {
  const first = new LanRoom();
  const opened = first.open();
  const a = first.login(opened.codes.A);
  readyPlayerB(first, opened);
  first.startGame(a.sessionToken, CONFIG);
  const saved = first.exportGame();

  const restored = new LanRoom();
  restored.importGame(saved, { refreshAuth: true });
  const state = restored.adminState();
  assert.equal(state.roomStatus, 'playing');
  assert.match(state.codes.A, /^\d{5}$/);
  assert.match(state.codes.B, /^\d{5}$/);
  assert.equal(state.connected.A, false);
  assert.equal(state.connected.B, false);
});

test('服务端动作响应包含可供客户端分步动画的版本转场', () => {
  const room = new LanRoom();
  const opened = room.open();
  const a = room.login(opened.codes.A);
  readyPlayerB(room, opened);
  const started = room.startGame(a.sessionToken, CONFIG);
  const moved = room.action(a.sessionToken, {
    clientActionId: 'transition-roll-0001',
    expectedVersion: started.version,
    expectedStateHash: started.stateHash,
    actionCode: 0
  });
  assert.equal(moved.transitions.length, 1);
  assert.equal(moved.transitions[0].version, moved.version);
  assert.equal(moved.transitions[0].action.actionCode, 0);
  assert(Array.isArray(moved.transitions[0].action.values));
  assert(moved.transitions[0].state && moved.transitions[0].state.currentRoll);
});

test('服务端可以用“服务端”名称向房间发送多行聊天', () => {
  const room = new LanRoom();
  room.open();
  const sent = room.sendServerChat('通知第一行\n通知第二行');
  assert.equal(sent.chatMessages.at(-1).player, 'SERVER');
  assert.equal(sent.chatMessages.at(-1).name, '服务端');
  assert.equal(sent.chatMessages.at(-1).content, '通知第一行\n通知第二行');
});

test('局域网开局阶段A/B分别设置本方永久保护并在开始时合并', () => {
  const room = new LanRoom();
  const opened = room.open();
  const sessionA = room.login(opened.codes.A);
  const sessionB = room.login(opened.codes.B);
  const aLobby = room.setLobbyConfig(sessionA.sessionToken, {
    mode: 'classic',
    playerAColors: ['yellow', 'blue'],
    protectedColors: ['yellow'],
    launchValues: [5, 6],
    tripleSixPenalty: true
  });
  assert.deepEqual(aLobby.lobbyConfig.playerAColors, ['yellow', 'blue']);
  assert(aLobby.lobbyConfig.protectedColors.includes('yellow'));
  const bLobby = room.setLobbyConfig(sessionB.sessionToken, {
    mode: 'classic',
    playerAColors: ['yellow', 'blue'],
    protectedColors: ['red'],
    launchValues: [5, 6],
    tripleSixPenalty: true
  });
  assert(bLobby.lobbyConfig.protectedColors.includes('yellow'));
  assert(bLobby.lobbyConfig.protectedColors.includes('red'));
  room.setLobbyReady(sessionB.sessionToken, true);
  const started = room.startGame(sessionA.sessionToken, {
    mode: 'classic',
    playerAColors: ['yellow', 'blue'],
    protectedColors: ['yellow'],
    launchValues: [5, 6],
    tripleSixPenalty: true
  });
  const protectedColors = Object.entries(started.state.colorState)
    .filter(([, value]) => value.protected)
    .map(([color]) => color)
    .sort();
  assert.deepEqual(protectedColors, ['red', 'yellow']);
});

const { RoomManager } = require('../server/room-manager.js');

test('多房间自动分配递增房间号且所有登录码全局唯一', () => {
  const manager = new RoomManager();
  const first = manager.createRoom();
  const second = manager.createRoom();
  const third = manager.createRoom();
  assert.deepEqual([first.roomId, second.roomId, third.roomId], [1, 2, 3]);
  const codes = [first, second, third].flatMap(room => {
    const value = room.auth.publicCodes();
    return [value.A, value.B];
  });
  assert.equal(new Set(codes).size, 6);
  assert(codes.every(code => /^\d{5}$/.test(code)));
});

test('客户端只凭登录码即可自动路由到对应房间', () => {
  const manager = new RoomManager();
  const first = manager.createRoom();
  const second = manager.createRoom();
  const loginA = manager.login(first.auth.publicCodes().A);
  const loginB = manager.login(second.auth.publicCodes().B);
  assert.equal(loginA.roomId, first.roomId);
  assert.equal(loginB.roomId, second.roomId);
  assert.equal(manager.requireRoomByToken(loginA.sessionToken).roomId, first.roomId);
  assert.equal(manager.requireRoomByToken(loginB.sessionToken).roomId, second.roomId);
});

test('多房间聊天、棋局和关闭操作互不影响', () => {
  const manager = new RoomManager();
  const first = manager.createRoom();
  const second = manager.createRoom();
  const a1 = manager.login(first.auth.publicCodes().A);
  const a2 = manager.login(second.auth.publicCodes().A);
  manager.sendChat(a1.sessionToken, '房间一');
  manager.sendChat(a2.sessionToken, '房间二');
  assert.equal(first.chatMessages.at(-1).content, '房间一');
  assert.equal(second.chatMessages.at(-1).content, '房间二');
  manager.closeRoom(first.roomId);
  assert.equal(first.status, 'closed');
  assert.equal(second.status, 'lobby');
  assert.equal(second.chatMessages.at(-1).content, '房间二');
});

test('多房间自动存档恢复后重新生成全局唯一登录码', () => {
  const manager = new RoomManager();
  const first = manager.createRoom();
  const second = manager.createRoom();
  const login = manager.login(first.auth.publicCodes().A);
  const loginB = manager.login(first.auth.publicCodes().B);
  manager.setLobbyReady(loginB.sessionToken, true);
  manager.startGame(login.sessionToken, CONFIG);
  manager.sendServerChat(second.roomId, '二号房消息');
  const saved = manager.exportAutosave();

  const restored = new RoomManager();
  restored.importAutosave(saved);
  assert.deepEqual(restored.roomIds(), [1, 2]);
  assert.equal(restored.getRoom(1).status, 'playing');
  assert.equal(restored.getRoom(2).chatMessages.at(-1).content, '二号房消息');
  const codes = restored.roomIds().flatMap(id => {
    const value = restored.getRoom(id).auth.publicCodes();
    return [value.A, value.B].filter(Boolean);
  });
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(restored.getRoom(1).auth.connected().A, false);
});


test('联机撤销支持拒绝、重复申请与允许后恢复权威快照', () => {
  const room = new LanRoom();
  const opened = room.open();
  const a = room.login(opened.codes.A);
  const b = readyPlayerB(room, opened);
  room.startGame(a.sessionToken, CONFIG);
  const target = room.serverEngine.snapshot();
  const changed = JSON.parse(JSON.stringify(target));
  const piece = changed.pieces.red[0];
  piece.location = { zone: 'main', index: 0 };
  room.serverEngine.engine.restore(changed);
  room.undoRecord = { requester: 'A', kind: 'move', snapshot: target, openingRollPending: room.serverEngine.openingRollPending };

  const requested = room.requestUndo(a.sessionToken);
  assert.equal(requested.undoRequest.requester, 'A');
  assert.equal(requested.undoRequest.approver, 'B');
  assert.throws(() => room.action(a.sessionToken, {
    clientActionId: 'blocked-during-undo', expectedVersion: requested.version,
    expectedStateHash: requested.stateHash, actionCode: 0
  }), error => error.code === 'UNDO_REQUEST_PENDING');

  const rejected = room.respondUndo(b.sessionToken, false);
  assert.equal(rejected.undoRequest, null);
  assert.equal(rejected.undoAllowed, false);
  assert.equal(rejected.undoAvailable, false, '回应方本身不应显示可撤销');

  const requestedAgain = room.requestUndo(a.sessionToken);
  assert(requestedAgain.undoRequest);
  const allowed = room.respondUndo(b.sessionToken, true);
  assert.equal(allowed.undoAllowed, true);
  assert.equal(allowed.undoRequest, null);
  assert.deepEqual(room.serverEngine.snapshot(), target);
  assert.equal(room.undoRecord, null);
});


test('极速双飞由A/B各自一次性投掷，B投掷前不能准备，切换模式才重置', () => {
  const room = new LanRoom();
  const opened = room.open();
  const a = room.login(opened.codes.A);
  const b = room.login(opened.codes.B);
  const speedConfig = {
    mode: 'speed',
    playerAColors: ['red', 'yellow'],
    protectedColors: [],
    launchValues: [5, 6],
    tripleSixPenalty: true,
    firstPlayer: null
  };

  const switched = room.setLobbyConfig(a.sessionToken, speedConfig);
  assert.equal(switched.lobbyConfig.mode, 'speed');
  assert.deepEqual(switched.lobbySpeedRolls, { A: null, B: null });
  assert.throws(() => room.setLobbyReady(b.sessionToken, true), error => error.code === 'PLAYER_B_MUST_ROLL');

  const aRolled = room.rollLobbyOrder(a.sessionToken);
  assert.equal(aRolled.lobbySpeedRolls.A.length, 2);
  assert.equal(aRolled.lobbySpeedRolls.B, null);
  assert(aRolled.lobbySpeedRolls.A.every(value => Number.isInteger(value) && value >= 1 && value <= 6));
  assert.throws(() => room.rollLobbyOrder(a.sessionToken), error => error.code === 'ORDER_ROLL_ALREADY_USED');

  const bRolled = room.rollLobbyOrder(b.sessionToken);
  assert.equal(bRolled.lobbySpeedRolls.B.length, 2);
  assert(['A', 'B'].includes(bRolled.lobbyConfig.firstPlayer));
  room.setLobbyReady(b.sessionToken, true);
  const started = room.startGame(a.sessionToken, speedConfig);
  assert.equal(started.roomStatus, 'playing');
  assert.equal(started.state.currentPlayerId, bRolled.lobbyConfig.firstPlayer);

  room.restartLobby();
  const classicConfig = { ...speedConfig, mode: 'classic', firstPlayer: 'A' };
  room.setLobbyConfig(a.sessionToken, speedConfig);
  room.rollLobbyOrder(a.sessionToken);
  room.rollLobbyOrder(b.sessionToken);
  room.setLobbyConfig(a.sessionToken, classicConfig);
  const reset = room.setLobbyConfig(a.sessionToken, speedConfig);
  assert.deepEqual(reset.lobbySpeedRolls, { A: null, B: null });
  assert.equal(reset.lobbyConfig.firstPlayer, null);
});


test('极速双飞大厅导出恢复保留双方一次性投掷结果', () => {
  const source = new LanRoom();
  const opened = source.open();
  const a = source.login(opened.codes.A);
  const b = source.login(opened.codes.B);
  const config = {
    mode: 'speed',
    playerAColors: ['blue', 'green'],
    protectedColors: [],
    launchValues: [6],
    tripleSixPenalty: true,
    firstPlayer: null
  };
  source.setLobbyConfig(a.sessionToken, config);
  source.rollLobbyOrder(a.sessionToken);
  source.rollLobbyOrder(b.sessionToken);
  source.setLobbyReady(b.sessionToken, true);
  const saved = source.exportGame();
  assert.equal(saved.formatVersion, 4);
  assert.equal(saved.roomStatus, 'lobby');
  assert(saved.lobbySpeedRolls.A && saved.lobbySpeedRolls.B);

  const restored = new LanRoom();
  restored.open();
  const state = restored.importGame(saved);
  assert.equal(state.roomStatus, 'lobby');
  assert.equal(state.lobbyConfig.mode, 'speed');
  assert.deepEqual(state.lobbySpeedRolls, saved.lobbySpeedRolls);
  assert(['A', 'B'].includes(state.lobbyConfig.firstPlayer));
  assert.equal(state.lobbyReady.B, true);
});

test('联机三6遣返支持拒绝、重复申请、接受惩罚与对方同意反悔', () => {
  const room = new LanRoom();
  const opened = room.open();
  const a = room.login(opened.codes.A);
  const b = readyPlayerB(room, opened);
  room.startGame(a.sessionToken, CONFIG);

  const engine = room.serverEngine.engine;
  const red = engine.getPiece('red-0');
  red.location = { zone: 'main', mainIndex: 7 };
  const savedPieces = engine.pieces.red.map(piece => ({
    id: piece.id,
    location: JSON.parse(JSON.stringify(piece.location)),
    finished: Boolean(piece.finished)
  }));
  engine.pendingDefeat = { color: 'red', pieces: savedPieces };
  engine._sendColorHome('red');

  const first = room.requestDefeatRegret(a.sessionToken);
  assert.equal(first.defeatRegretRequest.requester, 'A');
  assert.equal(first.defeatRegretRequest.approver, 'B');
  assert.equal(first.defeatRegretRequest.color, 'red');
  assert.throws(
    () => room.command(a.sessionToken, { command: 'undo-defeat' }),
    error => error.code === 'DEFEAT_REGRET_REQUIRES_APPROVAL'
  );

  const rejected = room.respondDefeatRegret(b.sessionToken, false);
  assert.equal(rejected.defeatRegretAllowed, false);
  assert.equal(rejected.defeatRegretRequest, null);
  assert(engine.pendingDefeat, '拒绝后应继续等待受罚方接受或再次申请');

  const second = room.requestDefeatRegret(a.sessionToken);
  const third = room.requestDefeatRegret(a.sessionToken);
  assert.notEqual(second.defeatRegretRequest.id, third.defeatRegretRequest.id, '申请次数不应受限');

  const allowed = room.respondDefeatRegret(b.sessionToken, true);
  assert.equal(allowed.defeatRegretAllowed, true);
  assert.equal(allowed.defeatRegretRequest, null);
  assert.equal(room.serverEngine.engine.pendingDefeat, null);
  assert.deepEqual(room.serverEngine.engine.pieces.red.map(piece => ({
    id: piece.id,
    location: JSON.parse(JSON.stringify(piece.location)),
    finished: Boolean(piece.finished)
  })), savedPieces);
  assert.equal(room.transitions.at(-1).command, 'defeat-regret-approved');

  // 再造一次遣返，确认受罚方直接接受时会同时撤销尚未回应的申请。
  const engine2 = room.serverEngine.engine;
  const savedAgain = engine2.pieces.yellow.map(piece => ({
    id: piece.id,
    location: JSON.parse(JSON.stringify(piece.location)),
    finished: Boolean(piece.finished)
  }));
  engine2.pendingDefeat = { color: 'yellow', pieces: savedAgain };
  engine2._sendColorHome('yellow');
  room.requestDefeatRegret(a.sessionToken);
  const accepted = room.command(a.sessionToken, { command: 'accept-defeat' });
  assert.equal(accepted.defeatRegretRequest, null);
  assert.equal(room.serverEngine.engine.pendingDefeat, null);
});
