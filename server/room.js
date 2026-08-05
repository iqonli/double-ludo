'use strict';

const crypto = require('node:crypto');
const { AuthManager } = require('./auth.js');
const { ServerEngine } = require('./server-engine.js');
const { ApiError, assert } = require('./protocol.js');

const SAVE_FORMAT = 'double-flight-lan-save';
const SAVE_FORMAT_VERSION = 4;
const MAX_CHAT_MESSAGES = 200;
const MAX_CHAT_LENGTH = 2000;
const MAX_ROOM_LOG = 80;

class LanRoom {
  constructor(roomId = 1, options = {}) {
    this.roomId = Number(roomId) || 1;
    this.codeMode = options.codeMode === 'online' ? 'online' : 'local';
    this.ownerAccountId = options.ownerAccountId || null;
    this.createdByIpKey = options.createdByIpKey || null;
    this.createdByIpAddress = options.createdByIpAddress || '';
    this.createdByIpMasked = options.createdByIpMasked || '';
    this.createdAt = Number(options.createdAt) || Date.now();
    this.playerLastSeenAt = { A: null, B: null };
    this.playerConnection = {
      A: { ipAddress: '', ipMasked: '', ipKey: '' },
      B: { ipAddress: '', ipMasked: '', ipKey: '' }
    };
    this.pollWaiters = new Map();
    this.auth = new AuthManager({ codeMode: this.codeMode });
    this.status = 'closed';
    this.version = 0;
    this.serverEngine = null;
    this.lastEvents = [];
    this.processedActions = new Map();
    this.chatVersion = 0;
    this.chatMessages = [];
    this.transitions = [];
    this.lobbyConfig = null;
    this.lobbyReady = { B: false };
    this.lobbySpeedRolls = { A: null, B: null };
    this.undoRecord = null;
    this.undoRequest = null;
    this.undoRequestCounter = 0;
    this.defeatRegretRequest = null;
    this.defeatRegretRequestCounter = 0;
    this.activityLog = [];
    this.logActivity('房间已创建');
  }


  logActivity(message) {
    const line = `${LanRoom.chatTimestamp()} ${String(message || '')}`;
    this.activityLog.push(line);
    if (this.activityLog.length > MAX_ROOM_LOG) this.activityLog.splice(0, this.activityLog.length - MAX_ROOM_LOG);
    return line;
  }

  touchPlayer(role, now = Date.now(), identity = null) {
    if (role !== 'A' && role !== 'B') return;
    this.playerLastSeenAt[role] = Number(now) || Date.now();
    if (identity && typeof identity === 'object') {
      this.playerConnection[role] = {
        ipAddress: String(identity.address || ''),
        ipMasked: String(identity.masked || ''),
        ipKey: String(identity.key || '')
      };
    }
  }

  validate(token, options = {}) {
    const role = this.auth.validate(token);
    if (options.touch !== false) this.touchPlayer(role, Date.now(), options.identity || null);
    return role;
  }

  touchSession(token, identity = null) {
    const role = this.auth.validate(token);
    this.touchPlayer(role, Date.now(), identity);
    return role;
  }

  connected(now = Date.now(), activeWindowMs = 60_000) {
    const authenticated = this.auth.connected();
    return {
      A: Boolean(authenticated.A && this.playerLastSeenAt.A && now - this.playerLastSeenAt.A <= activeWindowMs),
      B: Boolean(authenticated.B && this.playerLastSeenAt.B && now - this.playerLastSeenAt.B <= activeWindowMs)
    };
  }

  onlinePlayers(now = Date.now(), activeWindowMs = 60_000) {
    const connected = this.connected(now, activeWindowMs);
    return ['A', 'B'].filter(role => connected[role]).map(role => ({
      roomId: this.roomId,
      role,
      ownerAccountId: this.ownerAccountId,
      ipAddress: this.playerConnection[role].ipAddress || '',
      ipMasked: this.playerConnection[role].ipMasked || '',
      lastSeenAt: new Date(this.playerLastSeenAt[role]).toISOString()
    }));
  }

  lastPlayerActivityAt() {
    return Math.max(this.createdAt, Number(this.playerLastSeenAt.A) || 0, Number(this.playerLastSeenAt.B) || 0);
  }

  isInactive(now = Date.now(), ttlMs = 15 * 60 * 1000) {
    return now - this.lastPlayerActivityAt() > ttlMs;
  }

  notifyPollWaiters(reason = 'update') {
    for (const done of this.pollWaiters.values()) done(reason);
    this.pollWaiters.clear();
  }

  waitForUpdate(token, knownVersion, knownChatVersion, timeoutMs = 25_000, request = null, response = null) {
    const role = this.validate(token);
    if (Number(knownVersion) !== this.version || Number(knownChatVersion) !== this.chatVersion) {
      return Promise.resolve('changed');
    }
    const normalizedToken = String(token || '');
    const existing = this.pollWaiters.get(normalizedToken);
    if (existing) existing('replaced');

    return new Promise(resolve => {
      let finished = false;
      let timer = null;
      const onClose = () => done('closed');
      const done = reason => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (request) request.off('aborted', onClose);
        if (response) response.off('close', onClose);
        if (this.pollWaiters.get(normalizedToken) === done) this.pollWaiters.delete(normalizedToken);
        resolve(reason || 'update');
      };
      timer = setTimeout(() => done('timeout'), Math.max(1000, Number(timeoutMs) || 25_000));
      this.pollWaiters.set(normalizedToken, done);
      if (request) request.once('aborted', onClose);
      if (response) response.once('close', onClose);
      this.touchPlayer(role);
      if (Number(knownVersion) !== this.version || Number(knownChatVersion) !== this.chatVersion) done('changed');
    });
  }

  bump(events = [], transitionMeta = null) {
    this.version += 1;
    this.lastEvents = Array.isArray(events) ? events.slice(-100) : [];
    if (transitionMeta && this.serverEngine) {
      const transition = {
        version: this.version,
        events: this.lastEvents.map(event => ({ ...event })),
        action: transitionMeta.action ? JSON.parse(JSON.stringify(transitionMeta.action)) : null,
        command: transitionMeta.command || null,
        state: this.serverEngine.snapshot(),
        openingRollPending: this.serverEngine.openingRollPending,
        stateHash: this.serverEngine.hash()
      };
      this.transitions.push(transition);
      if (this.transitions.length > 120) this.transitions.splice(0, this.transitions.length - 120);
    }
    this.notifyPollWaiters('version');
  }

  clearTransitions() {
    this.transitions = [];
  }

  clearUndoState() {
    this.undoRecord = null;
    this.undoRequest = null;
    this.defeatRegretRequest = null;
  }

  static buildUndoEvents(currentSnapshot, targetSnapshot) {
    const targetById = new Map();
    for (const group of Object.values((targetSnapshot && targetSnapshot.pieces) || {})) {
      if (!Array.isArray(group)) continue;
      for (const piece of group) if (piece && piece.id) targetById.set(piece.id, piece);
    }
    const events = [];
    for (const group of Object.values((currentSnapshot && currentSnapshot.pieces) || {})) {
      if (!Array.isArray(group)) continue;
      for (const piece of group) {
        const target = piece && targetById.get(piece.id);
        if (!target) continue;
        if (JSON.stringify(piece.location) === JSON.stringify(target.location) && Boolean(piece.finished) === Boolean(target.finished)) continue;
        events.push({ type: 'undoAction', pieceId: piece.id, location: JSON.parse(JSON.stringify(target.location)) });
      }
    }
    return events;
  }

  bumpChat() {
    this.chatVersion += 1;
    this.notifyPollWaiters('chat');
  }

  static chatTimestamp(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  ensureCodes(excludeCodes = new Set()) {
    const codes = this.auth.publicCodes();
    if (!codes.A || !codes.B) this.auth.refreshCodes(excludeCodes);
  }


  defaultLobbyConfig() {
    return {
      mode: 'classic',
      playerAColors: [],
      protectedColors: [],
      launchValues: [5, 6],
      tripleSixPenalty: true,
      firstPlayer: 'A'
    };
  }

  normalizeLobbyConfig(raw, role = 'A') {
    const input = raw && typeof raw === 'object' ? raw : {};
    const previous = this.lobbyConfig || this.defaultLobbyConfig();
    const mode = role === 'A'
      ? (input.mode === 'speed' ? 'speed' : 'classic')
      : (previous.mode === 'speed' ? 'speed' : 'classic');
    const playerAColors = role === 'A' && Array.isArray(input.playerAColors)
      ? Array.from(new Set(input.playerAColors.filter(color => ['red', 'yellow', 'blue', 'green'].includes(color)))).slice(0, 2)
      : (Array.isArray(previous.playerAColors) ? previous.playerAColors.slice(0, 2) : []);
    const bColors = ['red', 'yellow', 'blue', 'green'].filter(color => !playerAColors.includes(color));
    const previousProtected = Array.isArray(previous.protectedColors) ? previous.protectedColors.filter(color => ['red', 'yellow', 'blue', 'green'].includes(color)) : [];
    const incomingProtected = Array.isArray(input.protectedColors) ? Array.from(new Set(input.protectedColors.filter(color => ['red', 'yellow', 'blue', 'green'].includes(color)))) : [];
    const ownColors = role === 'B' ? bColors : playerAColors;
    const otherColors = role === 'B' ? playerAColors : bColors;
    const protectedColors = [
      ...previousProtected.filter(color => otherColors.includes(color)),
      ...incomingProtected.filter(color => ownColors.includes(color))
    ];
    const launchValues = role === 'A' && Array.isArray(input.launchValues)
      ? Array.from(new Set(input.launchValues.map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 6))).sort((a, b) => a - b)
      : (Array.isArray(previous.launchValues) ? previous.launchValues.slice() : [5, 6]);
    if (!launchValues.length) launchValues.push(5, 6);
    return {
      mode,
      playerAColors,
      protectedColors: mode === 'speed' ? [] : Array.from(new Set(protectedColors)),
      launchValues,
      tripleSixPenalty: role === 'A' ? input.tripleSixPenalty !== false : previous.tripleSixPenalty !== false,
      firstPlayer: mode === 'speed'
        ? (previous.mode === 'speed' && (previous.firstPlayer === 'A' || previous.firstPlayer === 'B') ? previous.firstPlayer : null)
        : 'A'
    };
  }

  resetSpeedOpeningRolls() {
    this.lobbySpeedRolls = { A: null, B: null };
    if (this.lobbyConfig && this.lobbyConfig.mode === 'speed') this.lobbyConfig.firstPlayer = null;
  }

  decideSpeedFirstPlayer() {
    const aRoll = this.lobbySpeedRolls.A;
    const bRoll = this.lobbySpeedRolls.B;
    if (!Array.isArray(aRoll) || !Array.isArray(bRoll)) return null;
    const aTotal = aRoll.reduce((total, value) => total + Number(value || 0), 0);
    const bTotal = bRoll.reduce((total, value) => total + Number(value || 0), 0);
    if (aTotal !== bTotal) return aTotal > bTotal ? 'A' : 'B';
    const aSorted = aRoll.slice().sort((a, b) => b - a);
    const bSorted = bRoll.slice().sort((a, b) => b - a);
    for (let index = 0; index < Math.min(aSorted.length, bSorted.length); index += 1) {
      if (aSorted[index] !== bSorted[index]) return aSorted[index] > bSorted[index] ? 'A' : 'B';
    }
    return crypto.randomInt(0, 2) === 0 ? 'A' : 'B';
  }

  rollLobbyOrder(token) {
    const role = this.validate(token);
    assert(this.status === 'lobby', 409, 'NOT_IN_LOBBY', '当前不在开局设置阶段');
    assert(this.lobbyConfig && this.lobbyConfig.mode === 'speed', 409, 'NOT_SPEED_MODE', '只有极速双飞需要开局投掷');
    assert(!this.lobbySpeedRolls[role], 409, 'ORDER_ROLL_ALREADY_USED', `玩家${role}已经投掷过`);
    this.lobbySpeedRolls[role] = [crypto.randomInt(1, 7), crypto.randomInt(1, 7)];
    if (this.lobbySpeedRolls.A && this.lobbySpeedRolls.B) {
      this.lobbyConfig.firstPlayer = this.decideSpeedFirstPlayer();
    }
    this.lobbyReady.B = false;
    this.logActivity(`玩家${role}完成极速双飞开局投掷：${this.lobbySpeedRolls[role].join('、')}`);
    this.bump([]);
    return { ok: true, ...this.payload(role) };
  }


  transferAccountOwner(identity = {}) {
    this.createdByIpKey = String(identity.key || '');
    this.createdByIpAddress = String(identity.address || '');
    this.createdByIpMasked = String(identity.masked || '');
    this.logActivity(`账号管理归属已转移到IP ${this.createdByIpAddress || '未知'}`);
    this.bump([]);
    return this.adminState();
  }

  open(excludeCodes = new Set()) {
    this.status = 'lobby';
    this.serverEngine = null;
    this.processedActions.clear();
    this.clearTransitions();
    this.chatMessages = [];
    this.lobbyConfig = this.defaultLobbyConfig();
    this.lobbyReady = { B: false };
    this.lobbySpeedRolls = { A: null, B: null };
    this.clearUndoState();
    this.bumpChat();
    const codes = this.auth.refreshCodes(excludeCodes);
    this.logActivity('已开房并生成登录码');
    this.bump([]);
    return { ...this.adminState(), codes };
  }

  refreshCodes(excludeCodes = new Set()) {
    assert(this.status !== 'closed', 409, 'ROOM_CLOSED', '请先开房');
    const codes = this.auth.refreshCodes(excludeCodes);
    this.lobbyReady = { B: false };
    this.clearUndoState();
    this.logActivity('登录码已刷新，旧会话失效');
    this.bump([]);
    return { ...this.adminState(), codes };
  }

  restartLobby() {
    assert(this.status !== 'closed', 409, 'ROOM_CLOSED', '房间尚未开启');
    this.status = 'lobby';
    this.serverEngine = null;
    this.processedActions.clear();
    this.clearTransitions();
    this.lobbyConfig = this.defaultLobbyConfig();
    this.lobbyReady = { B: false };
    this.lobbySpeedRolls = { A: null, B: null };
    this.clearUndoState();
    this.logActivity('已重新进入开局设置');
    this.bump([]);
    return this.adminState();
  }

  close() {
    this.notifyPollWaiters('room-closed');
    this.status = 'closed';
    this.serverEngine = null;
    this.processedActions.clear();
    this.clearTransitions();
    this.chatMessages = [];
    this.lobbyConfig = null;
    this.lobbyReady = { B: false };
    this.lobbySpeedRolls = { A: null, B: null };
    this.clearUndoState();
    this.bumpChat();
    this.auth.clear();
    this.logActivity('房间已关闭');
    this.bump([]);
    return this.adminState();
  }

  login(code, identity = null) {
    assert(this.status !== 'closed', 409, 'ROOM_CLOSED', '服务端尚未开房');
    const session = this.auth.login(code);
    this.touchPlayer(session.role, Date.now(), identity);
    this.logActivity(`玩家${session.role}已登录`);
    this.bump([]);
    return {
      ok: true,
      player: session.role,
      sessionToken: session.token,
      authEpoch: session.epoch,
      roomId: this.roomId,
      ...this.payload(session.role)
    };
  }

  logout(token) {
    const role = this.validate(token);
    this.auth.logout(token);
    if (role === 'B') this.lobbyReady.B = false;
    this.logActivity(`玩家${role}已退出`);
    this.bump([]);
    return { ok: true, player: role };
  }


  setLobbyConfig(token, config) {
    const role = this.validate(token);
    assert(this.status === 'lobby', 409, 'NOT_IN_LOBBY', '当前不在开局设置阶段');
    const previousMode = this.lobbyConfig && this.lobbyConfig.mode === 'speed' ? 'speed' : 'classic';
    this.lobbyConfig = this.normalizeLobbyConfig(config, role);
    const nextMode = this.lobbyConfig.mode;
    if (role === 'A' && previousMode !== nextMode) {
      this.resetSpeedOpeningRolls();
      if (nextMode === 'classic') this.lobbyConfig.firstPlayer = 'A';
    } else if (nextMode === 'speed') {
      this.lobbyConfig.firstPlayer = this.decideSpeedFirstPlayer();
    }
    this.lobbyReady.B = false;
    this.logActivity(`玩家${role}更新了开局设置`);
    this.bump([]);
    return { ok: true, ...this.payload(role) };
  }

  setLobbyReady(token, ready = true) {
    const role = this.validate(token);
    assert(role === 'B', 403, 'PLAYER_B_ONLY', '只有玩家B可以确认准备');
    assert(this.status === 'lobby', 409, 'NOT_IN_LOBBY', '当前不在开局设置阶段');
    if (Boolean(ready) && this.lobbyConfig && this.lobbyConfig.mode === 'speed') {
      assert(Array.isArray(this.lobbySpeedRolls.B), 409, 'PLAYER_B_MUST_ROLL', '玩家B必须先完成开局投掷');
    }
    this.lobbyReady.B = Boolean(ready);
    this.logActivity(this.lobbyReady.B ? '玩家B已准备' : '玩家B取消准备');
    this.bump([]);
    return { ok: true, ...this.payload(role) };
  }

  startGame(token, config) {
    const role = this.validate(token);
    assert(role === 'A', 403, 'PLAYER_A_ONLY', '只有玩家A可以设置并开始联机对局');
    assert(this.status === 'lobby', 409, 'GAME_ALREADY_STARTED', '当前不在开局设置阶段');
    assert(this.lobbyReady.B, 409, 'PLAYER_B_NOT_READY', '玩家B尚未准备');
    const authoritativeFirstPlayer = this.lobbyConfig && this.lobbyConfig.firstPlayer;
    this.lobbyConfig = this.normalizeLobbyConfig(config, 'A');
    if (this.lobbyConfig.mode === 'speed') {
      assert(Array.isArray(this.lobbySpeedRolls.A) && Array.isArray(this.lobbySpeedRolls.B), 409, 'ORDER_ROLLS_INCOMPLETE', '双方必须先完成开局投掷');
      assert(authoritativeFirstPlayer === 'A' || authoritativeFirstPlayer === 'B', 409, 'FIRST_PLAYER_UNDECIDED', '尚未决定先手');
      this.lobbyConfig.firstPlayer = authoritativeFirstPlayer;
    }
    const staged = new ServerEngine(this.lobbyConfig);
    this.serverEngine = staged;
    this.status = 'playing';
    this.processedActions.clear();
    this.clearTransitions();
    this.lobbyConfig = null;
    this.clearUndoState();
    this.logActivity('玩家A开始了对局');
    this.bump([]);
    return { ok: true, ...this.payload(role) };
  }

  poll(token, knownVersion, knownChatVersion) {
    const role = this.validate(token);
    if (Number(knownVersion) === this.version && Number(knownChatVersion) === this.chatVersion) return null;
    return { ok: true, ...this.payload(role, Number(knownVersion)) };
  }

  sendChat(token, rawContent) {
    const role = this.validate(token);
    const content = String(rawContent ?? '').replace(/\r\n?/g, '\n').trim();
    assert(content.length > 0, 422, 'EMPTY_CHAT', '消息不能为空');
    assert(content.length <= MAX_CHAT_LENGTH, 413, 'CHAT_TOO_LONG', `消息不能超过${MAX_CHAT_LENGTH}个字符`);
    const message = {
      id: `${Date.now()}-${role}-${this.chatVersion + 1}`,
      time: LanRoom.chatTimestamp(),
      player: role,
      name: `玩家${role}`,
      content
    };
    this.chatMessages.push(message);
    if (this.chatMessages.length > MAX_CHAT_MESSAGES) this.chatMessages.splice(0, this.chatMessages.length - MAX_CHAT_MESSAGES);
    this.bumpChat();
    this.logActivity(`玩家${role}发送聊天消息`);
    return { ok: true, message, ...this.payload(role) };
  }

  sendServerChat(rawContent) {
    assert(this.status !== 'closed', 409, 'ROOM_CLOSED', '请先开房');
    const content = String(rawContent ?? '').replace(/\r\n?/g, '\n').trim();
    assert(content.length > 0, 422, 'EMPTY_CHAT', '消息不能为空');
    assert(content.length <= MAX_CHAT_LENGTH, 413, 'CHAT_TOO_LONG', `消息不能超过${MAX_CHAT_LENGTH}个字符`);
    const message = {
      id: `${Date.now()}-SERVER-${this.chatVersion + 1}`,
      time: LanRoom.chatTimestamp(),
      player: 'SERVER',
      name: '服务端',
      content
    };
    this.chatMessages.push(message);
    if (this.chatMessages.length > MAX_CHAT_MESSAGES) this.chatMessages.splice(0, this.chatMessages.length - MAX_CHAT_MESSAGES);
    this.bumpChat();
    this.logActivity('服务端发送聊天消息');
    return { ok: true, message, ...this.adminState() };
  }

  action(token, request) {
    const role = this.validate(token);
    assert(this.status === 'playing' && this.serverEngine, 409, 'GAME_NOT_STARTED', '棋局尚未开始');
    assert(!this.undoRequest, 409, 'UNDO_REQUEST_PENDING', '撤销请求处理中，请先回应');
    assert(!this.defeatRegretRequest, 409, 'DEFEAT_REGRET_PENDING', '三6遣返反悔申请处理中，请先回应');
    const clientActionId = String(request.clientActionId || '');
    assert(clientActionId.length >= 4 && clientActionId.length <= 120, 400, 'INVALID_ACTION_ID', 'clientActionId无效');

    const duplicateKey = `${role}:${clientActionId}`;
    if (this.processedActions.has(duplicateKey)) return this.processedActions.get(duplicateKey);

    const expectedVersion = Number(request.expectedVersion);
    const currentHash = this.serverEngine.hash();
    if (expectedVersion !== this.version || Number(request.expectedStateHash) !== currentHash) {
      throw new ApiError(409, 'STALE_STATE', '客户端状态已经过期', this.payload(role));
    }
    assert(this.serverEngine.currentPlayerId() === role, 403, 'NOT_YOUR_TURN', '当前不是你的回合');

    const actionCode = Number(request.actionCode);
    const beforeSnapshot = this.serverEngine.snapshot();
    const beforeOpeningRollPending = this.serverEngine.openingRollPending;
    const existingSwapUndo = this.undoRecord && this.undoRecord.kind === 'swap' && this.undoRecord.requester === role
      ? this.undoRecord
      : null;
    const result = this.serverEngine.step(actionCode);

    if (actionCode >= 4 && actionCode <= 19 && !this.serverEngine.engine.pendingDefeat) {
      this.undoRecord = {
        requester: role,
        kind: 'move',
        snapshot: beforeSnapshot,
        openingRollPending: beforeOpeningRollPending
      };
    } else if (actionCode >= 20 && actionCode <= 275) {
      this.undoRecord = {
        requester: role,
        kind: 'swap',
        snapshot: beforeSnapshot,
        openingRollPending: beforeOpeningRollPending
      };
    } else if (actionCode >= 276 && actionCode <= 291 && existingSwapUndo) {
      this.undoRecord = existingSwapUndo;
    } else if (!(actionCode >= 276 && actionCode <= 291)) {
      this.undoRecord = null;
    }

    this.bump(result.events || [], { action: result.meta });
    this.logActivity(`玩家${role}执行动作 ${request.actionCode}`);
    const response = { ok: true, action: result.meta, ...this.payload(role, expectedVersion) };
    this.processedActions.set(duplicateKey, response);
    if (this.processedActions.size > 300) {
      const first = this.processedActions.keys().next().value;
      this.processedActions.delete(first);
    }
    return response;
  }

  requestUndo(token) {
    const role = this.validate(token);
    assert(this.status === 'playing' && this.serverEngine, 409, 'GAME_NOT_STARTED', '棋局尚未开始');
    assert(this.undoRecord && this.undoRecord.requester === role, 409, 'UNDO_NOT_AVAILABLE', '当前没有可撤销的操作');
    const approver = role === 'A' ? 'B' : 'A';
    this.undoRequestCounter += 1;
    this.undoRequest = {
      id: `${this.roomId}-${this.undoRequestCounter}-${Date.now()}`,
      requester: role,
      approver,
      requestedAt: LanRoom.chatTimestamp()
    };
    this.logActivity(`玩家${role}申请撤销`);
    this.bump([]);
    return { ok: true, ...this.payload(role) };
  }

  respondUndo(token, allow) {
    const role = this.validate(token);
    assert(this.status === 'playing' && this.serverEngine, 409, 'GAME_NOT_STARTED', '棋局尚未开始');
    assert(this.undoRequest, 409, 'NO_UNDO_REQUEST', '当前没有待处理的撤销请求');
    assert(this.undoRequest.approver === role, 403, 'UNDO_APPROVER_ONLY', '只有对方玩家可以回应撤销请求');
    const requester = this.undoRequest.requester;
    if (!allow) {
      this.undoRequest = null;
      this.logActivity(`玩家${role}拒绝玩家${requester}撤销`);
      this.bump([]);
      return { ok: true, undoAllowed: false, ...this.payload(role) };
    }
    assert(this.undoRecord && this.undoRecord.requester === requester, 409, 'UNDO_NOT_AVAILABLE', '可撤销状态已经失效');
    const currentSnapshot = this.serverEngine.snapshot();
    const targetSnapshot = this.undoRecord.snapshot;
    const events = LanRoom.buildUndoEvents(currentSnapshot, targetSnapshot);
    this.serverEngine = ServerEngine.fromSave({
      snapshot: targetSnapshot,
      openingRollPending: this.undoRecord.openingRollPending
    });
    this.undoRecord = null;
    this.undoRequest = null;
    this.processedActions.clear();
    this.logActivity(`玩家${role}允许玩家${requester}撤销`);
    this.bump(events, { command: 'undo-approved' });
    return { ok: true, undoAllowed: true, ...this.payload(role) };
  }

  requestDefeatRegret(token) {
    const role = this.validate(token);
    assert(this.status === 'playing' && this.serverEngine, 409, 'GAME_NOT_STARTED', '棋局尚未开始');
    assert(!this.undoRequest, 409, 'UNDO_REQUEST_PENDING', '普通撤销请求处理中，请先回应');
    const pending = this.serverEngine.engine.pendingDefeat;
    assert(pending, 409, 'NO_PENDING_DEFEAT', '当前没有待确认的三6遣返');
    assert(this.serverEngine.currentPlayerId() === role, 403, 'DEFEATED_PLAYER_ONLY', '只有被三6遣返的玩家可以申请反悔');
    const approver = role === 'A' ? 'B' : 'A';
    this.defeatRegretRequestCounter += 1;
    this.defeatRegretRequest = {
      id: `${this.roomId}-defeat-${this.defeatRegretRequestCounter}-${Date.now()}`,
      requester: role,
      approver,
      color: pending.color,
      requestedAt: LanRoom.chatTimestamp()
    };
    this.logActivity(`玩家${role}申请反悔三6遣返`);
    this.bump([]);
    return { ok: true, ...this.payload(role) };
  }

  respondDefeatRegret(token, allow) {
    const role = this.validate(token);
    assert(this.status === 'playing' && this.serverEngine, 409, 'GAME_NOT_STARTED', '棋局尚未开始');
    assert(this.defeatRegretRequest, 409, 'NO_DEFEAT_REGRET_REQUEST', '当前没有待处理的三6遣返反悔申请');
    assert(this.defeatRegretRequest.approver === role, 403, 'DEFEAT_REGRET_APPROVER_ONLY', '只有对方玩家可以回应三6遣返反悔申请');
    const requester = this.defeatRegretRequest.requester;
    if (!allow) {
      this.defeatRegretRequest = null;
      this.logActivity(`玩家${role}拒绝玩家${requester}反悔三6遣返`);
      this.bump([]);
      return { ok: true, defeatRegretAllowed: false, ...this.payload(role) };
    }
    assert(this.serverEngine.engine.pendingDefeat, 409, 'NO_PENDING_DEFEAT', '三6遣返状态已经失效');
    assert(this.serverEngine.currentPlayerId() === requester, 409, 'DEFEAT_REGRET_EXPIRED', '申请反悔的回合已经失效');
    const result = this.serverEngine.command('undo-defeat');
    this.defeatRegretRequest = null;
    this.undoRecord = null;
    this.processedActions.clear();
    this.logActivity(`玩家${role}同意玩家${requester}反悔三6遣返`);
    this.bump(result.events || [], { command: 'defeat-regret-approved' });
    return { ok: true, defeatRegretAllowed: true, ...this.payload(role) };
  }

  command(token, request) {
    const role = this.validate(token);
    assert(this.status === 'playing' && this.serverEngine, 409, 'GAME_NOT_STARTED', '棋局尚未开始');
    assert(!this.undoRequest, 409, 'UNDO_REQUEST_PENDING', '撤销请求处理中，请先回应');
    const command = String(request.command || '');
    assert(command !== 'undo-defeat', 403, 'DEFEAT_REGRET_REQUIRES_APPROVAL', '联机三6遣返反悔必须由对方同意');
    if (command === 'accept-defeat') {
      assert(this.serverEngine.currentPlayerId() === role, 403, 'NOT_YOUR_TURN', '当前不是你的回合');
    }
    const beforeVersion = this.version;
    const result = this.serverEngine.command(command);
    if (command === 'accept-defeat') this.defeatRegretRequest = null;
    this.undoRecord = null;
    this.bump(result.events || [], { command });
    this.logActivity(`玩家${role}执行命令 ${command}`);
    return { ok: true, ...this.payload(role, beforeVersion) };
  }

  exportGame() {
    return {
      format: SAVE_FORMAT,
      formatVersion: SAVE_FORMAT_VERSION,
      appVersion: '0.42.2',
      roomId: this.roomId,
      exportedAt: new Date().toISOString(),
      roomStatus: this.status,
      lobbyConfig: this.lobbyConfig ? JSON.parse(JSON.stringify(this.lobbyConfig)) : null,
      lobbyReady: { ...this.lobbyReady },
      lobbySpeedRolls: JSON.parse(JSON.stringify(this.lobbySpeedRolls)),
      sourceVersion: this.version,
      chatVersion: this.chatVersion,
      chat: this.chatMessages.map(message => ({ ...message })),
      roomLog: this.activityLog.slice(),
      game: this.serverEngine ? this.serverEngine.exportData() : null
    };
  }

  importGame(raw, options = {}) {
    const file = raw && typeof raw === 'object' && raw.gameFile ? raw.gameFile : raw;
    assert(file && typeof file === 'object' && !Array.isArray(file), 422, 'INVALID_SAVE', '对局文件必须是JSON对象');
    const rawGame = file.game || (file.snapshot || file.state ? file : null);
    let stagedEngine = null;
    if (rawGame) stagedEngine = ServerEngine.fromSave(rawGame);
    const stagedLog = Array.isArray(file.roomLog) ? file.roomLog.slice(-MAX_ROOM_LOG).map(String) : [];
    const stagedChat = Array.isArray(file.chat)
      ? file.chat.slice(-MAX_CHAT_MESSAGES).map((message, index) => ({
          id: String(message && message.id || `imported-${index}`),
          time: String(message && message.time || LanRoom.chatTimestamp()),
          player: message && message.player === 'SERVER' ? 'SERVER' : (message && message.player === 'B' ? 'B' : 'A'),
          name: message && message.player === 'SERVER' ? '服务端' : (message && message.player === 'B' ? '玩家B' : '玩家A'),
          content: String(message && message.content || '').slice(0, MAX_CHAT_LENGTH)
        })).filter(message => message.content.trim())
      : [];

    const nextStatus = stagedEngine ? 'playing' : (file.roomStatus === 'closed' ? 'closed' : 'lobby');
    // Commit only after the entire candidate has loaded successfully.
    this.serverEngine = stagedEngine;
    this.status = nextStatus;
    this.lobbyConfig = nextStatus === 'lobby'
      ? this.normalizeLobbyConfig(file.lobbyConfig || this.defaultLobbyConfig(), 'A')
      : null;
    this.lobbyReady = { B: nextStatus === 'lobby' && Boolean(file.lobbyReady && file.lobbyReady.B) };
    this.lobbySpeedRolls = nextStatus === 'lobby' && file.lobbySpeedRolls && typeof file.lobbySpeedRolls === 'object'
      ? {
          A: Array.isArray(file.lobbySpeedRolls.A) ? file.lobbySpeedRolls.A.slice(0, 2).map(Number) : null,
          B: Array.isArray(file.lobbySpeedRolls.B) ? file.lobbySpeedRolls.B.slice(0, 2).map(Number) : null
        }
      : { A: null, B: null };
    if (nextStatus === 'lobby' && this.lobbyConfig && this.lobbyConfig.mode === 'speed') this.lobbyConfig.firstPlayer = this.decideSpeedFirstPlayer();
    this.processedActions.clear();
    this.clearUndoState();
    this.lastEvents = [];
    this.clearTransitions();
    this.chatMessages = stagedChat;
    this.activityLog = stagedLog;
    const importedChatVersion = Number(file.chatVersion);
    this.chatVersion = Math.max(
      this.chatVersion + 1,
      Number.isInteger(importedChatVersion) && importedChatVersion >= 0 ? importedChatVersion : 0
    );
    if (nextStatus === 'closed') this.auth.clear();
    else if (options.refreshAuth || !this.auth.publicCodes().A || !this.auth.publicCodes().B) this.auth.refreshCodes(options.excludeCodes || new Set());
    this.logActivity('已恢复对局文件');
    this.bump([]);
    return this.adminState();
  }

  payload(role, sinceVersion = null) {
    const engine = this.serverEngine;
    const numericSince = Number(sinceVersion);
    const hasSinceVersion = sinceVersion !== null && sinceVersion !== undefined && Number.isFinite(numericSince);
    const transitions = hasSinceVersion
      ? this.transitions.filter(item => item.version > numericSince).map(item => JSON.parse(JSON.stringify(item)))
      : [];
    return {
      roomId: this.roomId,
      roomStatus: this.status,
      player: role,
      version: this.version,
      stateHash: engine ? engine.hash() : 0,
      openingRollPending: engine ? engine.openingRollPending : true,
      state: engine ? engine.snapshot() : null,
      legalActions: engine ? engine.legalActions() : [],
      connected: this.connected(),
      lobbyConfig: this.lobbyConfig ? JSON.parse(JSON.stringify(this.lobbyConfig)) : null,
      lobbyReady: { ...this.lobbyReady },
      lobbySpeedRolls: JSON.parse(JSON.stringify(this.lobbySpeedRolls)),
      undoAvailable: Boolean(this.undoRecord && this.undoRecord.requester === role),
      undoRequest: this.undoRequest ? { ...this.undoRequest } : null,
      defeatRegretRequest: this.defeatRegretRequest ? { ...this.defeatRegretRequest } : null,
      events: this.lastEvents,
      transitions,
      chatVersion: this.chatVersion,
      chatMessages: this.chatMessages.map(message => ({ ...message })),
      roomLog: this.activityLog.slice()
    };
  }

  adminState() {
    return {
      ok: true,
      roomId: this.roomId,
      roomStatus: this.status,
      codeMode: this.codeMode,
      ownerAccountId: this.ownerAccountId,
      createdByIpAddress: this.createdByIpAddress,
      createdByIpMasked: this.createdByIpMasked,
      createdAt: new Date(this.createdAt).toISOString(),
      playerLastSeenAt: {
        A: this.playerLastSeenAt.A ? new Date(this.playerLastSeenAt.A).toISOString() : null,
        B: this.playerLastSeenAt.B ? new Date(this.playerLastSeenAt.B).toISOString() : null
      },
      playerConnections: {
        A: {
          ipAddress: this.playerConnection.A.ipAddress || '',
          ipMasked: this.playerConnection.A.ipMasked || ''
        },
        B: {
          ipAddress: this.playerConnection.B.ipAddress || '',
          ipMasked: this.playerConnection.B.ipMasked || ''
        }
      },
      lastPlayerActivityAt: new Date(this.lastPlayerActivityAt()).toISOString(),
      version: this.version,
      connected: this.connected(),
      codes: this.auth.publicCodes(),
      lobbyConfig: this.lobbyConfig ? JSON.parse(JSON.stringify(this.lobbyConfig)) : null,
      lobbyReady: { ...this.lobbyReady },
      lobbySpeedRolls: JSON.parse(JSON.stringify(this.lobbySpeedRolls)),
      gameStarted: Boolean(this.serverEngine),
      currentPlayer: this.serverEngine ? this.serverEngine.currentPlayerId() : null,
      undoRequest: this.undoRequest ? { ...this.undoRequest } : null,
      defeatRegretRequest: this.defeatRegretRequest ? { ...this.defeatRegretRequest } : null,
      undoAvailableFor: this.undoRecord ? this.undoRecord.requester : null,
      stateHash: this.serverEngine ? this.serverEngine.hash() : 0,
      chatVersion: this.chatVersion,
      chatCount: this.chatMessages.length,
      chatMessages: this.chatMessages.map(message => ({ ...message })),
      roomLog: this.activityLog.slice()
    };
  }
}

module.exports = { LanRoom, SAVE_FORMAT, SAVE_FORMAT_VERSION };
