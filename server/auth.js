'use strict';

const crypto = require('node:crypto');
const { ApiError } = require('./protocol.js');

const ONLINE_CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';

function fiveDigitCode(exclude = new Set()) {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const code = String(crypto.randomInt(10000, 100000));
    if (!exclude.has(code)) return code;
  }
  throw new Error('无法生成唯一登录码');
}

function onlineLoginCode(exclude = new Set()) {
  for (let attempt = 0; attempt < 10000; attempt += 1) {
    const digits = String(crypto.randomInt(0, 100000)).padStart(5, '0');
    const letter = ONLINE_CODE_LETTERS[crypto.randomInt(0, ONLINE_CODE_LETTERS.length)];
    const code = `${digits}${letter}`;
    if (!exclude.has(code)) return code;
  }
  throw new Error('无法生成唯一在线登录码');
}

function normalizeLoginCode(code) {
  return String(code || '').trim().toUpperCase();
}

function sessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

class AuthManager {
  constructor(options = {}) {
    this.codeMode = options.codeMode === 'online' ? 'online' : 'local';
    this.epoch = 0;
    this.slots = {
      A: { code: null, token: null },
      B: { code: null, token: null }
    };
  }

  generateCode(exclude = new Set()) {
    return this.codeMode === 'online' ? onlineLoginCode(exclude) : fiveDigitCode(exclude);
  }

  codePattern() {
    return this.codeMode === 'online' ? /^\d{5}[A-HJ-KM-NP-Z]$/ : /^\d{5}$/;
  }

  refreshCodes(exclude = new Set()) {
    const used = new Set([...exclude].map(normalizeLoginCode));
    const a = this.generateCode(used);
    used.add(a);
    const b = this.generateCode(used);
    this.epoch += 1;
    this.slots.A = { code: a, token: null };
    this.slots.B = { code: b, token: null };
    return this.publicCodes();
  }

  setCodes(codes, options = {}) {
    const a = normalizeLoginCode(codes && codes.A);
    const b = normalizeLoginCode(codes && codes.B);
    if (!this.codePattern().test(a) || !this.codePattern().test(b) || a === b) {
      const description = this.codeMode === 'online'
        ? '登录码必须是两个不同的“5位数字+1位大写字母”'
        : '登录码必须是两个不同的五位数字';
      throw new Error(description);
    }
    this.epoch = Number.isInteger(options.epoch) && options.epoch >= 0 ? options.epoch : this.epoch + 1;
    this.slots.A = { code: a, token: null };
    this.slots.B = { code: b, token: null };
    return this.publicCodes();
  }

  clear() {
    this.epoch += 1;
    this.slots.A = { code: null, token: null };
    this.slots.B = { code: null, token: null };
    return this.publicCodes();
  }

  publicCodes() {
    return {
      A: this.slots.A.code,
      B: this.slots.B.code,
      epoch: this.epoch
    };
  }

  activeTokens() {
    return ['A', 'B'].map(id => this.slots[id].token).filter(Boolean);
  }

  matchesCode(code) {
    const normalized = normalizeLoginCode(code);
    return ['A', 'B'].find(id => this.slots[id].code === normalized) || null;
  }

  ownsToken(token) {
    const normalized = String(token || '');
    return ['A', 'B'].some(id => this.slots[id].token && this.slots[id].token === normalized);
  }

  login(code) {
    const normalized = normalizeLoginCode(code);
    const role = this.matchesCode(normalized);
    if (!role) throw new ApiError(401, 'INVALID_LOGIN_CODE', '登录码无效或已经作废');
    const token = sessionToken();
    this.slots[role].token = token;
    return { role, token, epoch: this.epoch };
  }

  validate(token) {
    const normalized = String(token || '');
    const role = ['A', 'B'].find(id => this.slots[id].token && this.slots[id].token === normalized);
    if (!role) throw new ApiError(401, 'SESSION_INVALID', '会话已失效，请重新输入登录码');
    return role;
  }

  logout(token) {
    const role = this.validate(token);
    this.slots[role].token = null;
    return role;
  }

  connected() {
    return {
      A: Boolean(this.slots.A.token),
      B: Boolean(this.slots.B.token)
    };
  }
}

module.exports = {
  AuthManager,
  fiveDigitCode,
  onlineLoginCode,
  normalizeLoginCode,
  ONLINE_CODE_LETTERS
};
