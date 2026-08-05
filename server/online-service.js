'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { ApiError, assert } = require('./protocol.js');

const scryptAsync = promisify(crypto.scrypt);
const ACCOUNT_PASSWORD_MIN = 8;
const ACCOUNT_PASSWORD_MAX = 128;
const ACCOUNT_ROOM_LIMIT = 5;
const IP_ACCOUNT_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 1000;

function timingSafeEqualHex(left, right) {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

async function derivePasswordHash(password, salt) {
  const derived = await scryptAsync(String(password), salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
  return Buffer.from(derived).toString('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function maskIp(ip) {
  const value = String(ip || '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.*`;
  }
  if (value.includes(':')) {
    const parts = value.split(':').filter(Boolean);
    return `${parts.slice(0, 3).join(':') || 'IPv6'}:****`;
  }
  return value ? '已识别' : '未知';
}

class AccountManager {
  constructor(options = {}) {
    this.accounts = new Map();
    this.accountKeySecret = Buffer.from(options.accountKeySecret || randomToken(32));
    this.ipOwnedAccountKeys = new Map();
    this.ipActiveAccountKey = new Map();
  }

  normalizePassword(raw) {
    const password = String(raw ?? '');
    assert(password.length >= ACCOUNT_PASSWORD_MIN, 422, 'ACCOUNT_PASSWORD_TOO_SHORT', `账号不能少于${ACCOUNT_PASSWORD_MIN}个字符`);
    assert(password.length <= ACCOUNT_PASSWORD_MAX, 422, 'ACCOUNT_PASSWORD_TOO_LONG', `账号不能超过${ACCOUNT_PASSWORD_MAX}个字符`);
    return password;
  }

  accountKey(password) {
    return crypto.createHmac('sha256', this.accountKeySecret).update(password).digest('hex');
  }

  ownedKeys(ipKey) {
    const key = String(ipKey || '');
    const values = this.ipOwnedAccountKeys.get(key);
    return Array.isArray(values) ? values : [];
  }

  ownedAccounts(ipKey) {
    return this.ownedKeys(ipKey).map(key => this.accounts.get(key)).filter(Boolean);
  }

  countOwnedAccounts(ipKey) {
    return this.ownedAccounts(ipKey).length;
  }

  removeOwnership(ipKey, accountKey) {
    const ownerKey = String(ipKey || '');
    if (!ownerKey) return;
    const filtered = this.ownedKeys(ownerKey).filter(key => key !== accountKey && this.accounts.has(key));
    if (filtered.length) this.ipOwnedAccountKeys.set(ownerKey, filtered);
    else this.ipOwnedAccountKeys.delete(ownerKey);
    if (this.ipActiveAccountKey.get(ownerKey) === accountKey) this.ipActiveAccountKey.delete(ownerKey);
  }

  addOwnership(ipKey, accountKey) {
    const ownerKey = String(ipKey || '');
    const values = this.ownedKeys(ownerKey).filter(key => key !== accountKey && this.accounts.has(key));
    values.push(accountKey);
    this.ipOwnedAccountKeys.set(ownerKey, values);
    return values;
  }

  invalidateActiveAccount(ipKey, exceptAccountKey = '') {
    const ownerKey = String(ipKey || '');
    const activeKey = this.ipActiveAccountKey.get(ownerKey);
    if (!activeKey || activeKey === exceptAccountKey) return null;
    const active = this.accounts.get(activeKey);
    if (active) active.sessionToken = '';
    this.ipActiveAccountKey.delete(ownerKey);
    return active || null;
  }

  deleteAccountObject(account) {
    if (!account) return false;
    account.sessionToken = '';
    this.removeOwnership(account.ownerIpKey, account.key);
    for (const [ipKey, activeKey] of this.ipActiveAccountKey) {
      if (activeKey === account.key) this.ipActiveAccountKey.delete(ipKey);
    }
    return this.accounts.delete(account.key);
  }

  enforceIpAccountLimit(ipKey) {
    const ownerKey = String(ipKey || '');
    const evictedAccounts = [];
    let keys = this.ownedKeys(ownerKey).filter(key => this.accounts.has(key));
    while (keys.length > IP_ACCOUNT_LIMIT) {
      const oldestKey = keys.shift();
      const account = this.accounts.get(oldestKey);
      if (account) {
        this.deleteAccountObject(account);
        evictedAccounts.push(account);
      }
    }
    if (keys.length) this.ipOwnedAccountKeys.set(ownerKey, keys);
    else this.ipOwnedAccountKeys.delete(ownerKey);
    return evictedAccounts;
  }

  async login(rawPassword, ipKey, ipAddress = '', ipMasked = '') {
    const password = this.normalizePassword(rawPassword);
    const key = this.accountKey(password);
    const normalizedIpKey = String(ipKey || '');
    let account = this.accounts.get(key);
    let created = false;
    if (!account) {
      const salt = randomToken(16);
      account = {
        id: `acct_${key.slice(0, 12)}`,
        key,
        salt,
        passwordHash: await derivePasswordHash(password, salt),
        sessionToken: '',
        ownerIpKey: '',
        ownerIpAddress: '',
        ownerIpMasked: '',
        ownershipStartedAt: 0,
        createdAt: Date.now(),
        lastAccessAt: Date.now()
      };
      this.accounts.set(key, account);
      created = true;
    } else {
      const candidate = await derivePasswordHash(password, account.salt);
      if (!timingSafeEqualHex(candidate, account.passwordHash)) {
        throw new ApiError(401, 'ACCOUNT_LOGIN_FAILED', '账号无效');
      }
    }

    const previousOwnerIpKey = account.ownerIpKey;
    const takenOver = Boolean(previousOwnerIpKey && previousOwnerIpKey !== normalizedIpKey);
    if (takenOver) this.removeOwnership(previousOwnerIpKey, account.key);

    const newlyOwned = account.ownerIpKey !== normalizedIpKey || !this.ownedKeys(normalizedIpKey).includes(account.key);
    if (newlyOwned) {
      this.addOwnership(normalizedIpKey, account.key);
      account.ownershipStartedAt = Date.now();
    }

    this.invalidateActiveAccount(normalizedIpKey, account.key);
    account.sessionToken = randomToken(32);
    account.ownerIpKey = normalizedIpKey;
    account.ownerIpAddress = String(ipAddress || '');
    account.ownerIpMasked = String(ipMasked || maskIp(ipAddress));
    account.lastAccessAt = Date.now();
    this.ipActiveAccountKey.set(normalizedIpKey, account.key);

    const evictedAccounts = this.enforceIpAccountLimit(normalizedIpKey);
    if (!this.accounts.has(account.key)) {
      throw new ApiError(409, 'ACCOUNT_EVICTED', '该账号已因账号数量限制被删除，请重新进入');
    }

    return {
      account,
      created,
      takenOver,
      previousOwnerIpKey,
      sessionToken: account.sessionToken,
      evictedAccounts
    };
  }

  validate(sessionToken, ipKey) {
    const token = String(sessionToken || '');
    const ownerKey = String(ipKey || '');
    const account = [...this.accounts.values()].find(item => item.sessionToken && item.sessionToken === token);
    if (
      !account ||
      account.ownerIpKey !== ownerKey ||
      this.ipActiveAccountKey.get(ownerKey) !== account.key
    ) {
      throw new ApiError(401, 'ACCOUNT_SESSION_INVALID', '账号已在其他网络或其他账号页面登录，当前管理会话已失效');
    }
    account.lastAccessAt = Date.now();
    return account;
  }

  logout(sessionToken, ipKey) {
    const account = this.validate(sessionToken, ipKey);
    account.sessionToken = '';
    if (this.ipActiveAccountKey.get(account.ownerIpKey) === account.key) {
      this.ipActiveAccountKey.delete(account.ownerIpKey);
    }
    return account;
  }

  getById(accountId) {
    const id = String(accountId || '');
    return [...this.accounts.values()].find(account => account.id === id) || null;
  }

  list() {
    return [...this.accounts.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  remove(account) {
    return this.deleteAccountObject(account);
  }

  removeById(accountId) {
    const account = this.getById(accountId);
    return account ? (this.deleteAccountObject(account), account) : null;
  }
}

class FailedLoginLimiter {
  constructor(windowMs = LOGIN_FAILURE_WINDOW_MS) {
    this.windowMs = Number(windowMs) || LOGIN_FAILURE_WINDOW_MS;
    this.failedAt = new Map();
  }

  assertAllowed(ipKey, now = Date.now()) {
    const key = String(ipKey || '');
    const last = this.failedAt.get(key);
    if (!Number.isFinite(last)) return;
    const retryAfterMs = this.windowMs - (now - last);
    if (retryAfterMs > 0) {
      throw new ApiError(429, 'LOGIN_RATE_LIMITED', `登录码尝试过于频繁，请在${Math.max(1, Math.ceil(retryAfterMs / 1000))}秒后重试`, { retryAfterMs });
    }
  }

  recordFailure(ipKey, now = Date.now()) {
    this.failedAt.set(String(ipKey || ''), now);
  }

  recordSuccess(ipKey) {
    this.failedAt.delete(String(ipKey || ''));
  }

  cleanup(now = Date.now()) {
    for (const [key, timestamp] of this.failedAt) {
      if (now - timestamp > this.windowMs * 4) this.failedAt.delete(key);
    }
  }
}

module.exports = {
  AccountManager,
  FailedLoginLimiter,
  ACCOUNT_PASSWORD_MIN,
  ACCOUNT_PASSWORD_MAX,
  ACCOUNT_ROOM_LIMIT,
  IP_ACCOUNT_LIMIT,
  LOGIN_FAILURE_WINDOW_MS,
  derivePasswordHash,
  maskIp
};
