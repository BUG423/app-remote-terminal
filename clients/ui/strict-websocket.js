(function expose(factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.StrictWebSocket = api;
})(function buildStrictWebSocket() {
  'use strict';

  /**
   * A generation-guarded WebSocket client. At most one socket (including a
   * CONNECTING/CLOSING socket) and one reconnect timer can be active. Events
   * from superseded sockets are ignored.
   */
  class StrictWebSocketClient {
    constructor(options) {
      this.options = options;
      this.socket = null;
      this.generation = 0;
      this.reconnectTimer = null;
      this.reconnectAttempts = 0;
      this.reconnectEnabled = true;
      this.authenticated = false;
      // WebView timer functions require the Window receiver in some engines.
      // Calling a raw `setTimeout` stored as an object method can throw
      // "Illegal invocation", so always invoke captured functions lexically.
      const scheduleTimer = options.setTimer || setTimeout;
      const cancelTimer = options.clearTimer || clearTimeout;
      this.setTimer = (callback, delay) => scheduleTimer(callback, delay);
      this.clearTimer = (timer) => cancelTimer(timer);
      this.random = options.random || Math.random;
    }

    _isCurrent(socket, generation) {
      return this.socket === socket && this.generation === generation;
    }

    _reportError(error) {
      try {
        if (this.options.onError) this.options.onError(error);
      } catch { /* application callbacks must not break connection recovery */ }
    }

    _cancelReconnect() {
      if (this.reconnectTimer !== null) {
        this.clearTimer(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    }

    connect() {
      const token = this.options.getToken();
      if (!token) {
        if (this.options.onNoToken) this.options.onNoToken();
        return false;
      }

      // OPEN, CONNECTING and CLOSING all still represent the current socket.
      if (this.socket && this.socket.readyState !== 3) return false;
      this._cancelReconnect();

      const generation = ++this.generation;
      let socket;
      try {
        socket = this.options.createSocket(this.options.getUrl());
      } catch (err) {
        this._reportError(err);
        this._scheduleReconnect();
        return false;
      }
      this.socket = socket;
      this.authenticated = false;
      if (this.options.onSocket) this.options.onSocket(socket);

      socket.onopen = () => {
        if (!this._isCurrent(socket, generation)) return;
        try {
          socket.send(JSON.stringify({
            type: 'auth',
            token: this.options.getToken(),
            role: 'browser',
            protocolVersion: 2,
          }));
        } catch (err) {
          this._reportError(err);
          try { socket.close(); } catch { /* ignore */ }
        }
      };
      socket.onmessage = (event) => {
        if (!this._isCurrent(socket, generation)) return;
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        this.options.onMessage(data);
      };
      socket.onclose = (event) => {
        if (!this._isCurrent(socket, generation)) return;
        this.socket = null;
        this.authenticated = false;
        try {
          if (this.options.onSocket) this.options.onSocket(null);
          if (this.options.onDisconnect) this.options.onDisconnect(event);
        } catch (err) {
          this._reportError(err);
        }
        this._scheduleReconnect();
      };
      socket.onerror = (event) => {
        if (!this._isCurrent(socket, generation)) return;
        this._reportError(event);
      };
      return true;
    }

    markAuthenticated() {
      if (!this.socket || this.socket.readyState !== 1) return;
      this.authenticated = true;
      this.reconnectEnabled = true;
      this.reconnectAttempts = 0;
      this._cancelReconnect();
    }

    send(data) {
      if (!this.socket || this.socket.readyState !== 1 || !this.authenticated) return false;
      try {
        this.socket.send(JSON.stringify(data));
        return true;
      } catch {
        return false;
      }
    }

    _scheduleReconnect() {
      if (this.reconnectTimer !== null || !this.reconnectEnabled || !this.options.getToken()) return;
      const base = Math.min(1000 * Math.pow(2, Math.min(this.reconnectAttempts, 5)), 30000);
      const delay = Math.round(base * (0.8 + this.random() * 0.4));
      this.reconnectAttempts++;
      this.reconnectTimer = this.setTimer(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    }

    resetBackoff() {
      this.reconnectAttempts = 0;
    }

    disableReconnect() {
      this.reconnectEnabled = false;
      this._cancelReconnect();
    }

    enableReconnect() {
      this.reconnectEnabled = true;
    }
  }

  return { StrictWebSocketClient };
});
