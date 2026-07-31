'use strict';

const crypto = require('node:crypto');
const { ApiError } = require('./protocol.js');

function fiveDigitCode(exclude = new Set()) {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const code = String(crypto.randomInt(10000, 100000));
    if (!exclude.has(code)) return code;
  }
  throw new Error('无法生成唯一登录码');
}

function sessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

class AuthManager {
  constructor() {
    this.epoch = 0;
    this.slots = {
      A: { code: null, token: null },
      B: { code: null, token: null }
    };
  }

  refreshCodes(exclude = new Set()) {
    const used = new Set(exclude);
    const a = fiveDigitCode(used);
    used.add(a);
    const b = fiveDigitCode(used);
    this.epoch += 1;
    this.slots.A = { code: a, token: null };
    this.slots.B = { code: b, token: null };
    return this.publicCodes();
  }

  setCodes(codes, options = {}) {
    const a = String(codes && codes.A || '').trim();
    const b = String(codes && codes.B || '').trim();
    if (!/^\d{5}$/.test(a) || !/^\d{5}$/.test(b) || a === b) {
      throw new Error('登录码必须是两个不同的五位数字');
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

  matchesCode(code) {
    const normalized = String(code || '').trim();
    return ['A', 'B'].find(id => this.slots[id].code === normalized) || null;
  }

  ownsToken(token) {
    const normalized = String(token || '');
    return ['A', 'B'].some(id => this.slots[id].token && this.slots[id].token === normalized);
  }

  login(code) {
    const normalized = String(code || '').trim();
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

module.exports = { AuthManager, fiveDigitCode };
