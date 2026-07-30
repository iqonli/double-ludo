'use strict';

const { LanRoom } = require('./room.js');
const { ApiError, assert } = require('./protocol.js');

const MULTI_SAVE_FORMAT = 'double-flight-lan-multiroom-autosave';
const MULTI_SAVE_VERSION = 1;

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.nextRoomId = 1;
  }

  roomIds() {
    return [...this.rooms.keys()].sort((a, b) => a - b);
  }

  allCodes(excludeRoomId = null) {
    const used = new Set();
    for (const [roomId, room] of this.rooms) {
      if (roomId === excludeRoomId) continue;
      const codes = room.auth.publicCodes();
      if (codes.A) used.add(codes.A);
      if (codes.B) used.add(codes.B);
    }
    return used;
  }

  getRoom(roomId) {
    const numeric = Number(roomId);
    const room = this.rooms.get(numeric);
    if (!room) throw new ApiError(404, 'ROOM_NOT_FOUND', `房间${roomId}不存在`);
    return room;
  }

  createRoom(options = {}) {
    const roomId = this.nextRoomId++;
    const room = new LanRoom(roomId);
    this.rooms.set(roomId, room);
    if (options.open !== false) room.open(this.allCodes(roomId));
    return room;
  }

  ensureInitialRoom() {
    if (!this.rooms.size) return this.createRoom();
    return this.rooms.get(this.roomIds()[0]);
  }

  openRoom(roomId) {
    const room = this.getRoom(roomId);
    return room.open(this.allCodes(room.roomId));
  }

  refreshCodes(roomId) {
    const room = this.getRoom(roomId);
    return room.refreshCodes(this.allCodes(room.roomId));
  }

  restartRoom(roomId) {
    return this.getRoom(roomId).restartLobby();
  }

  closeRoom(roomId) {
    return this.getRoom(roomId).close();
  }

  deleteRoom(roomId) {
    const room = this.getRoom(roomId);
    room.close();
    this.rooms.delete(room.roomId);
    return { ok: true, roomId: room.roomId };
  }

  findRoomByCode(code) {
    const normalized = String(code || '').trim();
    for (const room of this.rooms.values()) {
      if (room.status !== 'closed' && room.auth.matchesCode(normalized)) return room;
    }
    return null;
  }

  findRoomByToken(token) {
    const normalized = String(token || '');
    for (const room of this.rooms.values()) {
      if (room.auth.ownsToken(normalized)) return room;
    }
    return null;
  }

  requireRoomByToken(token) {
    const room = this.findRoomByToken(token);
    if (!room) throw new ApiError(401, 'SESSION_INVALID', '会话已失效，请重新输入登录码');
    return room;
  }

  login(code) {
    const room = this.findRoomByCode(code);
    if (!room) throw new ApiError(401, 'INVALID_LOGIN_CODE', '登录码无效或已经作废');
    return room.login(code);
  }

  logout(token) {
    return this.requireRoomByToken(token).logout(token);
  }

  poll(token, knownVersion, knownChatVersion) {
    return this.requireRoomByToken(token).poll(token, knownVersion, knownChatVersion);
  }

  sendChat(token, content) {
    return this.requireRoomByToken(token).sendChat(token, content);
  }

  setLobbyConfig(token, config) {
    return this.requireRoomByToken(token).setLobbyConfig(token, config);
  }

  setLobbyReady(token, ready) {
    return this.requireRoomByToken(token).setLobbyReady(token, ready);
  }

  rollLobbyOrder(token) {
    return this.requireRoomByToken(token).rollLobbyOrder(token);
  }

  startGame(token, config) {
    return this.requireRoomByToken(token).startGame(token, config);
  }

  action(token, request) {
    return this.requireRoomByToken(token).action(token, request);
  }

  command(token, request) {
    return this.requireRoomByToken(token).command(token, request);
  }

  requestUndo(token) {
    return this.requireRoomByToken(token).requestUndo(token);
  }

  respondUndo(token, allow) {
    return this.requireRoomByToken(token).respondUndo(token, allow);
  }

  requestDefeatRegret(token) {
    return this.requireRoomByToken(token).requestDefeatRegret(token);
  }

  respondDefeatRegret(token, allow) {
    return this.requireRoomByToken(token).respondDefeatRegret(token, allow);
  }

  sendServerChat(roomId, content) {
    return this.getRoom(roomId).sendServerChat(content);
  }

  importRoom(roomId, raw, options = {}) {
    const room = this.getRoom(roomId);
    return room.importGame(raw, {
      ...options,
      excludeCodes: this.allCodes(room.roomId)
    });
  }

  exportRoom(roomId) {
    return this.getRoom(roomId).exportGame();
  }

  adminState() {
    return {
      ok: true,
      nextRoomId: this.nextRoomId,
      roomCount: this.rooms.size,
      rooms: this.roomIds().map(id => this.rooms.get(id).adminState())
    };
  }

  exportAutosave() {
    return {
      format: MULTI_SAVE_FORMAT,
      formatVersion: MULTI_SAVE_VERSION,
      appVersion: '0.41.0',
      savedAt: new Date().toISOString(),
      nextRoomId: this.nextRoomId,
      rooms: this.roomIds().map(roomId => ({
        roomId,
        gameFile: this.rooms.get(roomId).exportGame()
      }))
    };
  }

  importAutosave(raw) {
    assert(raw && typeof raw === 'object', 422, 'INVALID_SAVE', '自动存档格式无效');
    const source = raw.gameFile || raw;
    this.rooms.clear();
    this.nextRoomId = 1;

    if (source.format === MULTI_SAVE_FORMAT && Array.isArray(source.rooms)) {
      const entries = source.rooms
        .map(entry => ({ roomId: Number(entry && entry.roomId), gameFile: entry && (entry.gameFile || entry.game) }))
        .filter(entry => Number.isInteger(entry.roomId) && entry.roomId > 0 && entry.gameFile)
        .sort((a, b) => a.roomId - b.roomId);
      for (const entry of entries) {
        const room = new LanRoom(entry.roomId);
        this.rooms.set(entry.roomId, room);
        room.importGame(entry.gameFile, { refreshAuth: true, excludeCodes: this.allCodes(entry.roomId) });
      }
      const highest = this.roomIds().at(-1) || 0;
      this.nextRoomId = Math.max(highest + 1, Number(source.nextRoomId) || 1);
    } else {
      const room = new LanRoom(1);
      this.rooms.set(1, room);
      room.importGame(source, { refreshAuth: true, excludeCodes: new Set() });
      this.nextRoomId = 2;
    }

    this.ensureInitialRoom();
    return this.adminState();
  }
}

module.exports = { RoomManager, MULTI_SAVE_FORMAT, MULTI_SAVE_VERSION };
