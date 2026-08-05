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
  AccountManager,
  FailedLoginLimiter,
  ACCOUNT_ROOM_LIMIT,
  IP_ACCOUNT_LIMIT,
  LOGIN_FAILURE_WINDOW_MS,
  maskIp
} = require('./server/online-service.js');
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

const APP_VERSION = '0.42.2';
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
const ONLINE_MODE = process.env.ONLINE_MODE === 'true' || process.env.DEPLOY_MODE === 'render' || process.env.RENDER === 'true';
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const ROOM_IDLE_TTL_MS = Math.max(60_000, Number(process.env.ROOM_IDLE_TTL_MS) || 15 * 60 * 1000);
const LONG_POLL_TIMEOUT_MS = Math.min(30_000, Math.max(5_000, Number(process.env.LONG_POLL_TIMEOUT_MS) || 25_000));
const SERVER_INSTANCE_ID = crypto.randomBytes(12).toString('hex');
const IP_KEY_SECRET = Buffer.from(process.env.IP_KEY_SECRET || crypto.randomBytes(32).toString('hex'));
const manager = new RoomManager({ onlineMode: ONLINE_MODE });
const accountManager = new AccountManager({ accountKeySecret: process.env.ACCOUNT_KEY_SECRET || crypto.randomBytes(32).toString('hex') });
const loginLimiter = new FailedLoginLimiter(LOGIN_FAILURE_WINDOW_MS);
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

function clientAddress(req) {
  if (ONLINE_MODE || process.env.TRUST_PROXY === 'true') {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return normalizeAddress(forwarded);
  }
  return normalizeAddress(req.socket.remoteAddress);
}

function clientIpIdentity(req) {
  const address = clientAddress(req);
  return {
    address,
    key: crypto.createHmac('sha256', IP_KEY_SECRET).update(address || 'unknown').digest('hex'),
    masked: maskIp(address)
  };
}

function requestBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const protocol = ONLINE_MODE
    ? String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim()
    : (req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${activePort || ''}`).split(',')[0].trim();
  return `${protocol}://${host}`.replace(/\/$/, '');
}

function allowedOrigins(req) {
  const values = new Set(String(process.env.ALLOWED_ORIGINS || 'https://iqonli.github.io')
    .split(',').map(value => value.trim().replace(/\/$/, '')).filter(Boolean));
  values.add(requestBaseUrl(req));
  return values;
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || '');
  if (!ONLINE_MODE) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  } else if (origin) {
    const allowFileOrigin = process.env.ALLOW_FILE_ORIGIN !== 'false';
    if ((origin === 'null' && allowFileOrigin) || allowedOrigins(req).has(origin.replace(/\/$/, ''))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else {
      return false;
    }
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function localAddresses() {
  const values = new Set(['127.0.0.1', '::1']);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) values.add(normalizeAddress(entry.address));
  }
  return values;
}

function requireAdmin(req, res) {
  if (!ONLINE_MODE) {
    const remote = normalizeAddress(req.socket.remoteAddress);
    if (!localAddresses().has(remote)) {
      throw new ApiError(403, 'ADMIN_LOCAL_ONLY', '服务端管理接口只能在开服设备本机访问');
    }
    return;
  }
  const expectedPassword = String(process.env.ADMIN_PASSWORD || '');
  if (!expectedPassword) throw new ApiError(503, 'ADMIN_NOT_CONFIGURED', '管理员密码未配置，请在Render环境变量中设置ADMIN_PASSWORD');
  const expectedUsername = String(process.env.ADMIN_USERNAME || 'admin');
  const authorization = String(req.headers.authorization || '');
  let username = '';
  let password = '';
  if (authorization.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      username = separator >= 0 ? decoded.slice(0, separator) : decoded;
      password = separator >= 0 ? decoded.slice(separator + 1) : '';
    } catch (_) {}
  }
  if (!safeEqualText(username, expectedUsername) || !safeEqualText(password, expectedPassword)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Double Ludo Admin", charset="UTF-8"');
    throw new ApiError(401, 'ADMIN_AUTH_REQUIRED', '需要服务器管理员身份认证');
  }
}

function persistRooms(reason = 'change') {
  if (ONLINE_MODE) return true;
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
  if (ONLINE_MODE) return false;
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
  if (urlPath === '/') {
    root = PUBLIC_DIR;
    relative = ONLINE_MODE ? 'host.html' : 'game.html';
  } else if (urlPath === '/game.html') {
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
    onlineMode: ONLINE_MODE,
    serverInstanceId: SERVER_INSTANCE_ID,
    gameUrl: ONLINE_MODE ? `${PUBLIC_BASE_URL || ''}/game.html` : (activePort ? `http://127.0.0.1:${activePort}/game.html` : ''),
    accounts: ONLINE_MODE ? accountManager.list().map(account => ({
      accountId: account.id,
      ownerIpAddress: account.ownerIpAddress,
      ownerIpMasked: account.ownerIpMasked,
      createdAt: new Date(account.createdAt).toISOString(),
      ownershipStartedAt: account.ownershipStartedAt ? new Date(account.ownershipStartedAt).toISOString() : null,
      lastAccessAt: new Date(account.lastAccessAt).toISOString(),
      active: Boolean(account.sessionToken),
      roomCount: manager.countRoomsForAccount(account.id),
      roomIds: manager.roomsForAccount(account.id).map(room => room.roomId)
    })) : [],
    onlinePlayers: ONLINE_MODE ? manager.onlinePlayers().map(player => ({
      ...player,
      accountId: player.ownerAccountId || null
    })) : [],
    onlinePlayerCount: ONLINE_MODE ? manager.onlinePlayerCount() : 0,
    activeRoomCount: manager.activeRoomCount(),
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

function adminNotConfiguredHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>双飞服务端管理配置</title><style>body{margin:0;background:#eef1f5;color:#20242a;font-family:system-ui,"Microsoft YaHei",sans-serif}.card{width:min(680px,calc(100% - 32px));margin:72px auto;padding:24px;border:1px solid #ccd2da;border-radius:14px;background:#fff;box-shadow:0 8px 26px #0001}h1{margin-top:0;font-size:24px}code{padding:2px 6px;border-radius:5px;background:#eef1f5}p{line-height:1.7}a{color:#2457d6}</style></head><body><main class="card"><h1>管理员密码尚未配置</h1><p>请在Render服务的环境变量中设置<code>ADMIN_PASSWORD</code>，保存并重新部署。用户名默认是<code>admin</code>，也可以通过<code>ADMIN_USERNAME</code>修改。</p><p>配置完成后重新访问<a href="/admin">/admin</a>，浏览器会显示Basic Authentication登录窗口。</p></main></body></html>`;
}

function adminHtml() {
  const template = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'), 'utf8');
  return template.replaceAll('__APP_VERSION__', APP_VERSION);
}

function roomIdFromBody(body) {
  const roomId = Number(body && body.roomId);
  if (!Number.isInteger(roomId) || roomId < 1) throw new ApiError(400, 'INVALID_ROOM_ID', '房间号无效');
  return roomId;
}

function roomInvitePayload(room, baseUrl) {
  const codes = room.auth.publicCodes();
  const invite = code => `${baseUrl}/game.html?port=${encodeURIComponent(code)}&URL=${encodeURIComponent(baseUrl)}`;
  return {
    roomId: room.roomId,
    roomStatus: room.status,
    codes: { A: codes.A, B: codes.B },
    invites: { A: invite(codes.A), B: invite(codes.B) },
    createdAt: new Date(room.createdAt).toISOString(),
    lastPlayerActivityAt: new Date(room.lastPlayerActivityAt()).toISOString(),
    connected: room.connected(),
    ownerIpAddress: room.createdByIpAddress,
    ownerIpMasked: room.createdByIpMasked
  };
}

function accountStatePayload(account, req) {
  const identity = clientIpIdentity(req);
  const rooms = manager.roomsForAccount(account.id);
  const baseUrl = requestBaseUrl(req);
  return {
    ok: true,
    accountId: account.id,
    ownerIpAddress: account.ownerIpAddress,
    ownerIpMasked: account.ownerIpMasked,
    roomCount: rooms.length,
    accountRoomLimit: ACCOUNT_ROOM_LIMIT,
    ipAccountCount: accountManager.countOwnedAccounts(identity.key),
    ipAccountLimit: IP_ACCOUNT_LIMIT,
    rooms: rooms.map(room => roomInvitePayload(room, baseUrl)),
    serverUrl: baseUrl,
    serverInstanceId: SERVER_INSTANCE_ID
  };
}

function touchPlayerRequest(body, req) {
  if (!body || !body.sessionToken) return null;
  return manager.touchSession(body.sessionToken, clientIpIdentity(req));
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (pathname.startsWith('/api/admin/')) requireAdmin(req, res);

  if (req.method === 'GET' && pathname === '/api/info') {
    return sendJson(res, 200, {
      ok: true,
      name: 'double-flight-server',
      version: APP_VERSION,
      onlineMode: ONLINE_MODE,
      serverInstanceId: SERVER_INSTANCE_ID,
      port: activePort,
      portMode: EXPLICIT_PORT === null ? 'random' : 'explicit',
      portRange: [PORT_MIN, PORT_MAX],
      roomCount: manager.rooms.size,
      activeRoomCount: manager.activeRoomCount(),
      onlinePlayerCount: manager.onlinePlayerCount(),
      roomStatus: manager.rooms.size ? 'multiroom' : 'closed',
      pollingMode: 'long-poll',
      longPollTimeoutMs: LONG_POLL_TIMEOUT_MS,
      loginCodeFormat: ONLINE_MODE ? '5digits+letter' : '5digits',
      autosave: !ONLINE_MODE,
      accountRoomLimit: ONLINE_MODE ? ACCOUNT_ROOM_LIMIT : null,
      ipAccountLimit: ONLINE_MODE ? IP_ACCOUNT_LIMIT : null
    });
  }

  if (ONLINE_MODE && req.method === 'POST' && pathname === '/api/account/login') {
    const body = await jsonBody(req, 8 * 1024);
    const identity = clientIpIdentity(req);
    const result = await accountManager.login(body.password, identity.key, identity.address, identity.masked);
    if (result.takenOver) manager.transferAccountRooms(result.account.id, identity);
    const evictedAccounts = [];
    for (const evicted of result.evictedAccounts || []) {
      const deletedRooms = manager.deleteRoomsForAccount(evicted.id);
      evictedAccounts.push({ accountId: evicted.id, deletedRoomIds: deletedRooms.map(item => item.roomId) });
    }
    return sendJson(res, 200, {
      ...accountStatePayload(result.account, req),
      sessionToken: result.sessionToken,
      created: result.created,
      takenOver: result.takenOver,
      evictedAccounts
    });
  }
  if (ONLINE_MODE && req.method === 'POST' && pathname === '/api/account/state') {
    const body = await jsonBody(req, 8 * 1024);
    const identity = clientIpIdentity(req);
    const account = accountManager.validate(body.sessionToken, identity.key);
    return sendJson(res, 200, accountStatePayload(account, req));
  }
  if (ONLINE_MODE && req.method === 'POST' && pathname === '/api/account/logout') {
    const body = await jsonBody(req, 8 * 1024);
    const identity = clientIpIdentity(req);
    accountManager.logout(body.sessionToken, identity.key);
    return sendJson(res, 200, { ok: true });
  }
  if (ONLINE_MODE && req.method === 'POST' && pathname === '/api/account/room/create') {
    const body = await jsonBody(req, 8 * 1024);
    const identity = clientIpIdentity(req);
    const account = accountManager.validate(body.sessionToken, identity.key);
    if (manager.countRoomsForAccount(account.id) >= ACCOUNT_ROOM_LIMIT) {
      throw new ApiError(409, 'ACCOUNT_ROOM_LIMIT', `每个账号最多同时拥有${ACCOUNT_ROOM_LIMIT}个房间`);
    }
    const room = manager.createRoom({
      ownerAccountId: account.id,
      createdByIpKey: identity.key,
      createdByIpAddress: identity.address,
      createdByIpMasked: identity.masked
    });
    return sendJson(res, 200, {
      ...accountStatePayload(account, req),
      createdRoom: roomInvitePayload(room, requestBaseUrl(req))
    });
  }
  if (ONLINE_MODE && req.method === 'POST' && pathname === '/api/account/room/export') {
    const body = await jsonBody(req, 8 * 1024);
    const identity = clientIpIdentity(req);
    const account = accountManager.validate(body.sessionToken, identity.key);
    const room = manager.getRoom(Number(body.roomId));
    if (room.ownerAccountId !== account.id) throw new ApiError(403, 'ROOM_NOT_OWNED', '不能导出其他账号的房间');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return sendJson(res, 200, {
      ok: true,
      filename: `double-flight-room-${room.roomId}-${stamp}.json`,
      gameFile: manager.exportRoom(room.roomId)
    });
  }
  if (ONLINE_MODE && req.method === 'POST' && pathname === '/api/account/room/import') {
    const body = await jsonBody(req, 2 * 1024 * 1024);
    const identity = clientIpIdentity(req);
    const account = accountManager.validate(body.sessionToken, identity.key);
    const room = manager.getRoom(Number(body.roomId));
    if (room.ownerAccountId !== account.id) throw new ApiError(403, 'ROOM_NOT_OWNED', '不能恢复其他账号的房间');
    manager.importRoom(room.roomId, body.gameFile || body.file);
    return sendJson(res, 200, accountStatePayload(account, req));
  }

  if (ONLINE_MODE && req.method === 'POST' && pathname === '/api/account/room/delete') {
    const body = await jsonBody(req, 8 * 1024);
    const identity = clientIpIdentity(req);
    const account = accountManager.validate(body.sessionToken, identity.key);
    const room = manager.getRoom(Number(body.roomId));
    if (room.ownerAccountId !== account.id) throw new ApiError(403, 'ROOM_NOT_OWNED', '不能删除其他账号的房间');
    manager.deleteRoom(room.roomId);
    return sendJson(res, 200, accountStatePayload(account, req));
  }
  if (ONLINE_MODE && req.method === 'POST' && pathname === '/api/account/delete') {
    const body = await jsonBody(req, 8 * 1024);
    const identity = clientIpIdentity(req);
    const account = accountManager.validate(body.sessionToken, identity.key);
    manager.deleteRoomsForAccount(account.id);
    accountManager.remove(account);
    return sendJson(res, 200, { ok: true });
  }

  if (ONLINE_MODE && req.method === 'POST' && pathname === '/api/admin/account/delete') {
    const body = await jsonBody(req, 8 * 1024);
    const account = accountManager.getById(body.accountId);
    if (!account) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '账号不存在');
    manager.deleteRoomsForAccount(account.id);
    accountManager.remove(account);
    return sendJson(res, 200, adminStatePayload());
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
    const identity = clientIpIdentity(req);
    // A failed attempt starts a one-second cooldown for subsequent attempts
    // from this IP. Successful logins never start a cooldown.
    loginLimiter.assertAllowed(identity.key);
    try {
      const payload = manager.login(body.code, identity);
      loginLimiter.recordSuccess(identity.key);
      return sendJson(res, 200, { ...payload, serverInstanceId: SERVER_INSTANCE_ID });
    } catch (error) {
      if (error && error.code === 'INVALID_LOGIN_CODE') loginLimiter.recordFailure(identity.key);
      throw error;
    }
  }
  if (req.method === 'POST' && pathname === '/api/logout') {
    const body = await jsonBody(req);
    return sendJson(res, 200, manager.logout(body.sessionToken));
  }
  if (req.method === 'POST' && pathname === '/api/poll') {
    const body = await jsonBody(req);
    touchPlayerRequest(body, req);
    let payload = manager.poll(body.sessionToken, body.knownVersion, body.knownChatVersion);
    if (!payload) {
      await manager.waitForUpdate(body.sessionToken, body.knownVersion, body.knownChatVersion, LONG_POLL_TIMEOUT_MS, req, res);
      if (res.writableEnded || res.destroyed) return;
      payload = manager.poll(body.sessionToken, body.knownVersion, body.knownChatVersion);
    }
    return payload
      ? sendJson(res, 200, { ...payload, serverInstanceId: SERVER_INSTANCE_ID })
      : sendNoContent(res);
  }
  if (req.method === 'POST' && pathname === '/api/chat') {
    const body = await jsonBody(req, 16 * 1024);
    touchPlayerRequest(body, req);
    return sendJson(res, 200, mutate('chat', () => manager.sendChat(body.sessionToken, body.content)));
  }
  if (req.method === 'POST' && pathname === '/api/lobby-config') {
    const body = await jsonBody(req);
    touchPlayerRequest(body, req);
    return sendJson(res, 200, mutate('lobby-config', () => manager.setLobbyConfig(body.sessionToken, body.config)));
  }
  if (req.method === 'POST' && pathname === '/api/lobby-ready') {
    const body = await jsonBody(req);
    touchPlayerRequest(body, req);
    return sendJson(res, 200, mutate('lobby-ready', () => manager.setLobbyReady(body.sessionToken, body.ready)));
  }
  if (req.method === 'POST' && pathname === '/api/lobby-order-roll') {
    const body = await jsonBody(req);
    touchPlayerRequest(body, req);
    return sendJson(res, 200, mutate('lobby-order-roll', () => manager.rollLobbyOrder(body.sessionToken)));
  }
  if (req.method === 'POST' && pathname === '/api/start-game') {
    const body = await jsonBody(req);
    touchPlayerRequest(body, req);
    return sendJson(res, 200, mutate('start-game', () => manager.startGame(body.sessionToken, body.config)));
  }
  if (req.method === 'POST' && pathname === '/api/action') {
    const body = await jsonBody(req);
    touchPlayerRequest(body, req);
    return sendJson(res, 200, mutate('action', () => manager.action(body.sessionToken, body)));
  }
  if (req.method === 'POST' && pathname === '/api/command') {
    const body = await jsonBody(req);
    touchPlayerRequest(body, req);
    return sendJson(res, 200, mutate('command', () => manager.command(body.sessionToken, body)));
  }
  if (req.method === 'POST' && pathname === '/api/undo-request') {
    const body = await jsonBody(req);
    touchPlayerRequest(body, req);
    return sendJson(res, 200, mutate('undo-request', () => manager.requestUndo(body.sessionToken)));
  }
  if (req.method === 'POST' && pathname === '/api/undo-response') {
    const body = await jsonBody(req);
    touchPlayerRequest(body, req);
    return sendJson(res, 200, mutate('undo-response', () => manager.respondUndo(body.sessionToken, Boolean(body.allow))));
  }
  if (req.method === 'POST' && pathname === '/api/defeat-regret-request') {
    const body = await jsonBody(req);
    touchPlayerRequest(body, req);
    return sendJson(res, 200, mutate('defeat-regret-request', () => manager.requestDefeatRegret(body.sessionToken)));
  }
  if (req.method === 'POST' && pathname === '/api/defeat-regret-response') {
    const body = await jsonBody(req);
    touchPlayerRequest(body, req);
    return sendJson(res, 200, mutate('defeat-regret-response', () => manager.respondDefeatRegret(body.sessionToken, Boolean(body.allow))));
  }
  throw new ApiError(404, 'NOT_FOUND', '接口不存在');
}

restoreAutosave();

if (ONLINE_MODE) {
  setInterval(() => {
    const deleted = manager.cleanupInactive(Date.now(), ROOM_IDLE_TTL_MS);
    if (deleted.length) console.log(`已自动清理${deleted.length}个空闲超过15分钟的在线房间`);
    loginLimiter.cleanup();
  }, 60_000).unref();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const corsAllowed = applyCors(req, res);
    if (req.method === 'OPTIONS') {
      if (!corsAllowed) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', '该网页来源不允许连接此服务器');
      res.writeHead(204, commonHeaders());
      return res.end();
    }
    if (!corsAllowed && url.pathname.startsWith('/api/')) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', '该网页来源不允许连接此服务器');
    if (url.pathname === '/admin') {
      if (ONLINE_MODE && !String(process.env.ADMIN_PASSWORD || '')) {
        const html = adminNotConfiguredHtml();
        res.writeHead(503, {
          ...commonHeaders(),
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html)
        });
        return res.end(html);
      }
      requireAdmin(req, res);
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

server.requestTimeout = 40_000;
server.headersTimeout = 45_000;
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
  console.log(`双飞 v0.42.2 ${ONLINE_MODE ? '云端联机' : '多房间局域网'}服务器已启动`);
  console.log(`${EXPLICIT_PORT === null ? '本次随机端口' : '监听端口（已指定）'}：${activePort}`);
  console.log(`管理页面：${ONLINE_MODE ? `${PUBLIC_BASE_URL || '(当前Render域名)'}/admin` : `http://127.0.0.1:${activePort}/admin`}`);
  console.log(`游戏页面：${ONLINE_MODE ? `${PUBLIC_BASE_URL || '(当前Render域名)'}/game.html` : `http://127.0.0.1:${activePort}/game.html`}`);
  if (ONLINE_MODE) console.log(`开房页面：${PUBLIC_BASE_URL || '(当前Render域名)'}/`);
  console.log('也可直接打开 public/game.html，再输入服务器地址、可选端口和登录码。');
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) console.log(`局域网游戏：http://${entry.address}:${activePort}/game.html  (${name})`);
    }
  }
  console.log(`当前房间数：${manager.rooms.size}`);
  console.log(ONLINE_MODE ? '数据模式：仅内存，重启后账号和房间全部清空' : `自动存档：${AUTOSAVE_FILE}`);
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
