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

  function normalizeBase(host, port) {
    let value = String(host || '').trim();
    const portText = String(port || '').trim();
    if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
    const url = new URL(value);
    if (portText) url.port = portText;
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.origin;
  }

  class LanClient {
    constructor(options = {}) {
      this.intervalMs = options.intervalMs || 500;
      this.requestTimeoutMs = options.requestTimeoutMs || 5000;
      this.baseUrl = '';
      this.sessionToken = '';
      this.player = null;
      this.version = -1;
      this.stateHash = 0;
      this.chatVersion = -1;
      this.connected = false;
      this.running = false;
      this.pollPromise = null;
      this.pollingPauseDepth = 0;
      this.failureCount = 0;
      this.onState = options.onState || (() => {});
      this.onStatus = options.onStatus || (() => {});
      this.onSessionInvalid = options.onSessionInvalid || (() => {});
      this.latencyMs = null;
    }

    async request(path, body, allowNoContent = false) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timeout = controller ? setTimeout(() => controller.abort(), this.requestTimeoutMs) : null;
      let response;
      const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
          cache: 'no-store',
          signal: controller ? controller.signal : undefined
        });
      } catch (error) {
        const timeoutText = error && error.name === 'AbortError' ? '请求超时' : error.message;
        throw new NetworkError(`无法连接服务端：${timeoutText}`);
      } finally {
        if (timeout) clearTimeout(timeout);
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
      const incomingVersion = Number(payload.version);
      if (Number.isFinite(incomingVersion) && incomingVersion < this.version) return payload;
      if (Number.isFinite(incomingVersion)) this.version = incomingVersion;
      if (Number.isFinite(Number(payload.stateHash))) this.stateHash = Number(payload.stateHash);
      if (Number.isFinite(Number(payload.chatVersion))) this.chatVersion = Number(payload.chatVersion);
      if (payload.player) this.player = payload.player;
      // The state callback is deliberately not awaited. Visual animation may run
      // for seconds, while the polling loop and chat communication continue.
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
      const payload = await this.request('/api/login', { code: String(code || '').trim() });
      this.sessionToken = payload.sessionToken;
      this.player = payload.player;
      this.connected = true;
      this.failureCount = 0;
      this.apply(payload);
      this.start();
      return payload;
    }

    async sync(force = false) {
      if (!this.connected || !this.sessionToken) throw new NetworkError('尚未登录局域网服务器', 401, 'SESSION_INVALID');
      if (this.pollPromise) return this.pollPromise;
      this.pollPromise = this.request('/api/poll', {
        sessionToken: this.sessionToken,
        knownVersion: force ? -1 : this.version,
        knownChatVersion: force ? -1 : this.chatVersion
      }, true).then(payload => this.apply(payload)).finally(() => { this.pollPromise = null; });
      return this.pollPromise;
    }

    async pausePollingBeforeRequest(minimumMs = 550) {
      this.pollingPauseDepth += 1;
      try {
        if (this.pollPromise) {
          try { await this.pollPromise; } catch (_) {}
        }
        await new Promise(resolve => setTimeout(resolve, Math.max(500, Number(minimumMs) || 0)));
      } catch (error) {
        this.pollingPauseDepth = Math.max(0, this.pollingPauseDepth - 1);
        throw error;
      }
    }

    resumePolling() {
      this.pollingPauseDepth = Math.max(0, this.pollingPauseDepth - 1);
    }

    async setLobbyConfig(config) {
      const payload = await this.request('/api/lobby-config', { sessionToken: this.sessionToken, config });
      return this.apply(payload);
    }

    async setLobbyReady(ready = true) {
      const payload = await this.request('/api/lobby-ready', { sessionToken: this.sessionToken, ready: Boolean(ready) });
      return this.apply(payload);
    }

    async rollLobbyOrder() {
      const payload = await this.request('/api/lobby-order-roll', { sessionToken: this.sessionToken });
      return this.apply(payload);
    }

    async startGame(config) {
      const payload = await this.request('/api/start-game', { sessionToken: this.sessionToken, config });
      return this.apply(payload);
    }

    async action(actionCode, clientActionId) {
      const payload = await this.request('/api/action', {
        sessionToken: this.sessionToken,
        clientActionId,
        expectedVersion: this.version,
        expectedStateHash: this.stateHash,
        actionCode
      });
      return this.apply(payload);
    }

    async sendChat(content) {
      const payload = await this.request('/api/chat', {
        sessionToken: this.sessionToken,
        content: String(content || '')
      });
      return this.apply(payload);
    }

    async command(command) {
      const payload = await this.request('/api/command', {
        sessionToken: this.sessionToken,
        command
      });
      return this.apply(payload);
    }

    async requestUndo() {
      const payload = await this.request('/api/undo-request', {
        sessionToken: this.sessionToken
      });
      return this.apply(payload);
    }

    async respondUndo(allow) {
      const payload = await this.request('/api/undo-response', {
        sessionToken: this.sessionToken,
        allow: Boolean(allow)
      });
      return this.apply(payload);
    }

    async requestDefeatRegret() {
      const payload = await this.request('/api/defeat-regret-request', {
        sessionToken: this.sessionToken
      });
      return this.apply(payload);
    }

    async respondDefeatRegret(allow) {
      const payload = await this.request('/api/defeat-regret-response', {
        sessionToken: this.sessionToken,
        allow: Boolean(allow)
      });
      return this.apply(payload);
    }

    async logout() {
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
      this.pollingPauseDepth = 0;
      this.failureCount = 0;
      if (wasConnected || error) this.onSessionInvalid(error);
    }

    nextDelay() {
      if (this.failureCount <= 0) return this.intervalMs;
      return Math.min(1500, Math.max(this.intervalMs, 100 * (2 ** Math.min(this.failureCount, 4))));
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
          } catch (error) {
            if (error.status === 401) return;
            this.failureCount += 1;
            this.onStatus({ online: false, error, retryInMs: this.nextDelay() });
          }
          await new Promise(resolve => setTimeout(resolve, this.nextDelay()));
        }
      };
      loop();
    }

    stop() {
      this.running = false;
    }
  }

  root.DoubleFlightNetwork = { LanClient, NetworkError, normalizeBase };
})(typeof globalThis !== 'undefined' ? globalThis : window);
