// Android 与桌面端共用的本地设置模型。
(function expose(factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.ClientSettings = api;
})(function buildClientSettings() {
  'use strict';

  const STORAGE_KEY = 'remote-terminal-client-settings-v1';
  const DEFAULTS = Object.freeze({
    version: 1,
    fontSize: 14,
    scrollback: 10000,
    cursorBlink: true,
    showMobileKeybar: true,
    confirmLargePaste: true,
    pinnedSessionIds: [],
  });

  function clampInteger(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function sanitize(input) {
    const value = input && typeof input === 'object' ? input : {};
    const pinned = Array.isArray(value.pinnedSessionIds)
      ? [...new Set(value.pinnedSessionIds.filter((id) => typeof id === 'string' && id.length <= 300))].slice(0, 100)
      : [];
    return {
      version: 1,
      fontSize: clampInteger(value.fontSize, DEFAULTS.fontSize, 11, 24),
      scrollback: clampInteger(value.scrollback, DEFAULTS.scrollback, 1000, 20000),
      cursorBlink: value.cursorBlink !== false,
      showMobileKeybar: value.showMobileKeybar !== false,
      confirmLargePaste: value.confirmLargePaste !== false,
      pinnedSessionIds: pinned,
    };
  }

  class ClientSettingsStore {
    constructor(storage, key = STORAGE_KEY) {
      this.storage = storage;
      this.key = key;
      this.value = this.load();
    }

    load() {
      try {
        return sanitize(JSON.parse(this.storage.getItem(this.key) || 'null'));
      } catch {
        return sanitize(null);
      }
    }

    get() {
      return { ...this.value, pinnedSessionIds: [...this.value.pinnedSessionIds] };
    }

    update(patch) {
      this.value = sanitize({ ...this.value, ...(patch || {}) });
      this.storage.setItem(this.key, JSON.stringify(this.value));
      return this.get();
    }

    reset() {
      this.value = sanitize(null);
      this.storage.setItem(this.key, JSON.stringify(this.value));
      return this.get();
    }
  }

  return { ClientSettingsStore, DEFAULTS, STORAGE_KEY, sanitize };
});
