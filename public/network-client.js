(function (root) {
  'use strict';

  class NetworkError extends Error {
    constructor(message, status = 0, code = 'NETWORK_ERROR', payload = null) {
      super(message);
      this.name = 'NetworkError';
      this.status = status;
      this.code = code;
      this.payload = payload;
    }
  }

  function defaultProtocol() {
    if (typeof location !== 'undefined' && location.protocol === 'https:') return 'https:';
    return 'http:';
  }

  function requestFetch(input, init) {
    const retry = root.DoubleLudoRequestRetry;
    if (retry && typeof retry.fetch === 'function') return retry.fetch(input, init);
    return root.fetch(input, init);
  }

  function normalizeBase(host, port) {
    let value = String(host || '').trim();
    const portText = String(port || '').trim();
    if (!value && typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) value = location.origin;
    if (!/^https?:\/\//i.test(value)) value = `${defaultProtocol()}//${value}`;
    const url = new URL(value);
    if (portText) url.port = portText;
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.origin;
  }

  class LanClient {
    constructor(options = {}) {
      this.intervalMs = options.intervalMs || 1000;
      this.requestTimeoutMs = options.requestTimeoutMs || 10_000;
      this.pollTimeoutMs = options.pollTimeoutMs || 35_000;
      this.baseUrl = '';
      this.sessionToken = '';
      this.player = null;
      this.version = -1;
      this.stateHash = 0;
      this.chatVersion = -1;
      this.serverInstanceId = '';
      this.connected = false;
      this.running = false;
      this.pollPromise = null;
      this.pollController = null;
      this.pollAbortRequested = false;
      this.pollingPauseDepth = 0;
      this.failureCount = 0;
      this.onState = options.onState || (() => {});
      this.onStatus = options.onStatus || (() => {});
      this.onSessionInvalid = options.onSessionInvalid || (() => {});
      this.latencyMs = null;
    }

    async request(path, body, allowNoContent = false, options = {}) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const isPoll = Boolean(options.poll);
      const timeoutMs = Number(options.timeoutMs) || (isPoll ? this.pollTimeoutMs : this.requestTimeoutMs);
      if (isPoll) {
        this.pollController = controller;
        this.pollAbortRequested = false;
      }
      const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      let response;
      const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      try {
        response = await requestFetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
          cache: 'no-store',
          signal: controller ? controller.signal : undefined
        });
      } catch (error) {
        if (error && error.name === 'AbortError' && isPoll && this.pollAbortRequested) {
          throw new NetworkError('长轮询已取消', 0, 'POLL_ABORTED');
        }
        const timeoutText = error && error.name === 'AbortError' ? '请求超时' : error.message;
        throw new NetworkError(`无法连接服务端：${timeoutText}`);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (isPoll && this.pollController === controller) this.pollController = null;
      }
      const endedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      this.latencyMs = Math.max(0, Math.round(endedAt - startedAt));
      this.onStatus({ online: true, latencyMs: this.latencyMs });
      if (allowNoContent && response.status === 204) return null;
      let payload = null;
      try { payload = await response.json(); } catch (_) { payload = null; }
      if (!response.ok) {
        const error = new NetworkError(
          payload && payload.message ? payload.message : `服务端返回HTTP ${response.status}`,
          response.status,
          payload && payload.error ? payload.error : 'HTTP_ERROR',
          payload
        );
        if (response.status === 401) this.invalidateSession(error);
        throw error;
      }
      if (!payload || typeof payload !== 'object') {
        throw new NetworkError('服务端返回了无法识别的数据', response.status, 'INVALID_RESPONSE');
      }
      return payload;
    }

    apply(payload) {
      if (!payload) return null;
      if (payload.serverInstanceId) {
        if (this.serverInstanceId && this.serverInstanceId !== payload.serverInstanceId) {
          const error = new NetworkError('服务器已重启或房间已过期，请重新加入房间', 401, 'SERVER_RESTARTED');
          this.invalidateSession(error);
          throw error;
        }
        this.serverInstanceId = payload.serverInstanceId;
      }
      const incomingVersion = Number(payload.version);
      if (Number.isFinite(incomingVersion) && incomingVersion < this.version) return payload;
      if (Number.isFinite(incomingVersion)) this.version = incomingVersion;
      if (Number.isFinite(Number(payload.stateHash))) this.stateHash = Number(payload.stateHash);
      if (Number.isFinite(Number(payload.chatVersion))) this.chatVersion = Number(payload.chatVersion);
      if (payload.player) this.player = payload.player;
      try {
        const callbackResult = this.onState(payload);
        if (callbackResult && typeof callbackResult.catch === 'function') callbackResult.catch(error => console.error(error));
      } catch (error) {
        console.error(error);
      }
      return payload;
    }

    async login(host, port, code) {
      this.stop();
      this.baseUrl = normalizeBase(host, port);
      const payload = await this.request('/api/login', { code: String(code || '').trim().toUpperCase() });
      this.sessionToken = payload.sessionToken;
      this.player = payload.player;
      this.connected = true;
      this.failureCount = 0;
      this.serverInstanceId = payload.serverInstanceId || '';
      this.apply(payload);
      this.start();
      return payload;
    }

    async sync(force = false) {
      if (!this.connected || !this.sessionToken) throw new NetworkError('尚未登录联机服务器', 401, 'SESSION_INVALID');
      if (this.pollPromise) return this.pollPromise;
      this.pollPromise = this.request('/api/poll', {
        sessionToken: this.sessionToken,
        knownVersion: force ? -1 : this.version,
        knownChatVersion: force ? -1 : this.chatVersion
      }, true, { poll: true, timeoutMs: this.pollTimeoutMs })
        .then(payload => this.apply(payload))
        .finally(() => { this.pollPromise = null; });
      return this.pollPromise;
    }

    abortPoll() {
      if (!this.pollController) return;
      this.pollAbortRequested = true;
      try { this.pollController.abort(); } catch (_) {}
    }

    async pausePollingBeforeRequest() {
      this.pollingPauseDepth += 1;
      this.abortPoll();
      if (this.pollPromise) {
        try { await this.pollPromise; } catch (error) {
          if (!error || error.code !== 'POLL_ABORTED') throw error;
        }
      }
    }

    resumePolling() {
      this.pollingPauseDepth = Math.max(0, this.pollingPauseDepth - 1);
    }

    async setLobbyConfig(config) { return this.apply(await this.request('/api/lobby-config', { sessionToken: this.sessionToken, config })); }
    async setLobbyReady(ready = true) { return this.apply(await this.request('/api/lobby-ready', { sessionToken: this.sessionToken, ready: Boolean(ready) })); }
    async rollLobbyOrder() { return this.apply(await this.request('/api/lobby-order-roll', { sessionToken: this.sessionToken })); }
    async startGame(config) { return this.apply(await this.request('/api/start-game', { sessionToken: this.sessionToken, config })); }

    async action(actionCode, clientActionId) {
      return this.apply(await this.request('/api/action', {
        sessionToken: this.sessionToken,
        clientActionId,
        expectedVersion: this.version,
        expectedStateHash: this.stateHash,
        actionCode
      }));
    }

    async sendChat(content) { return this.apply(await this.request('/api/chat', { sessionToken: this.sessionToken, content: String(content || '') })); }
    async command(command) { return this.apply(await this.request('/api/command', { sessionToken: this.sessionToken, command })); }
    async requestUndo() { return this.apply(await this.request('/api/undo-request', { sessionToken: this.sessionToken })); }
    async respondUndo(allow) { return this.apply(await this.request('/api/undo-response', { sessionToken: this.sessionToken, allow: Boolean(allow) })); }
    async requestDefeatRegret() { return this.apply(await this.request('/api/defeat-regret-request', { sessionToken: this.sessionToken })); }
    async respondDefeatRegret(allow) { return this.apply(await this.request('/api/defeat-regret-response', { sessionToken: this.sessionToken, allow: Boolean(allow) })); }

    async logout() {
      this.abortPoll();
      if (this.connected && this.sessionToken) {
        try { await this.request('/api/logout', { sessionToken: this.sessionToken }); } catch (_) {}
      }
      this.invalidateSession();
    }

    invalidateSession(error = null) {
      const wasConnected = this.connected;
      this.stop();
      this.connected = false;
      this.sessionToken = '';
      this.player = null;
      this.version = -1;
      this.stateHash = 0;
      this.chatVersion = -1;
      this.serverInstanceId = '';
      this.pollingPauseDepth = 0;
      this.failureCount = 0;
      if (wasConnected || error) this.onSessionInvalid(error);
    }

    nextDelay() {
      const schedule = [1000, 2000, 4000, 8000, 15000, 30000];
      const base = schedule[Math.min(Math.max(this.failureCount - 1, 0), schedule.length - 1)];
      const jitter = 0.85 + Math.random() * 0.3;
      return Math.round(base * jitter);
    }

    start() {
      if (this.running) return;
      this.running = true;
      const loop = async () => {
        while (this.running && this.connected) {
          if (this.pollingPauseDepth > 0) {
            await new Promise(resolve => setTimeout(resolve, 25));
            continue;
          }
          try {
            await this.sync(false);
            this.failureCount = 0;
            this.onStatus({ online: true });
            continue;
          } catch (error) {
            if (error && (error.status === 401 || error.code === 'SERVER_RESTARTED')) return;
            if (error && error.code === 'POLL_ABORTED') continue;
            this.failureCount += 1;
            const retryInMs = this.nextDelay();
            this.onStatus({ online: false, error, retryInMs });
            await new Promise(resolve => setTimeout(resolve, retryInMs));
          }
        }
      };
      loop();
    }

    stop() {
      this.running = false;
      this.abortPoll();
    }
  }

  root.DoubleFlightNetwork = { LanClient, NetworkError, normalizeBase };
})(typeof globalThis !== 'undefined' ? globalThis : window);
