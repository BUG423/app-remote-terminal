(function expose(factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.DeviceStore = api;
})(function buildDeviceStore() {
  'use strict';

  const STORAGE_KEY = 'remote-terminal-devices-v1';
  const MAX_DEVICES = 100;
  const MAX_ALIASES_PER_DEVICE = 500;

  function cleanText(value, fallback, maxLength) {
    const text = typeof value === 'string' ? value.trim() : '';
    return (text || fallback).slice(0, maxLength);
  }

  function validId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
  }

  function sanitizeDevice(value) {
    if (!value || typeof value !== 'object' || !validId(value.id)) return null;
    const relayUrl = cleanText(value.relayUrl, '', 2048);
    if (!relayUrl) return null;
    const now = Date.now();
    const createdAt = Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : now;
    const updatedAt = Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : createdAt;
    const lastConnectedAt = Number.isFinite(Number(value.lastConnectedAt)) ? Number(value.lastConnectedAt) : 0;
    return {
      id: value.id,
      name: cleanText(value.name, '未命名设备', 80),
      relayUrl,
      createdAt,
      updatedAt,
      lastConnectedAt,
    };
  }

  function sanitizeAliases(value, deviceIds) {
    const result = {};
    if (!value || typeof value !== 'object') return result;
    for (const deviceId of deviceIds) {
      const source = value[deviceId];
      if (!source || typeof source !== 'object') continue;
      const aliases = {};
      for (const [sessionId, alias] of Object.entries(source).slice(0, MAX_ALIASES_PER_DEVICE)) {
        if (!validId(sessionId)) continue;
        const name = cleanText(alias, '', 120);
        if (name) aliases[sessionId] = name;
      }
      if (Object.keys(aliases).length > 0) result[deviceId] = aliases;
    }
    return result;
  }

  function sanitizeState(input) {
    const value = input && typeof input === 'object' ? input : {};
    const devices = [];
    const seen = new Set();
    for (const candidate of Array.isArray(value.devices) ? value.devices : []) {
      const device = sanitizeDevice(candidate);
      if (!device || seen.has(device.id) || devices.length >= MAX_DEVICES) continue;
      seen.add(device.id);
      devices.push(device);
    }
    const activeDeviceId = seen.has(value.activeDeviceId)
      ? value.activeDeviceId
      : (devices[0]?.id || '');
    return {
      version: 1,
      activeDeviceId,
      devices,
      sessionAliases: sanitizeAliases(value.sessionAliases, seen),
    };
  }

  function cloneState(state) {
    return {
      version: 1,
      activeDeviceId: state.activeDeviceId,
      devices: state.devices.map((device) => ({ ...device })),
      sessionAliases: Object.fromEntries(
        Object.entries(state.sessionAliases).map(([deviceId, aliases]) => [deviceId, { ...aliases }]),
      ),
    };
  }

  class DeviceRegistry {
    constructor(storage, key = STORAGE_KEY) {
      this.storage = storage;
      this.key = key;
      this.state = this.load();
    }

    load() {
      try {
        return sanitizeState(JSON.parse(this.storage.getItem(this.key) || 'null'));
      } catch {
        return sanitizeState(null);
      }
    }

    save() {
      this.storage.setItem(this.key, JSON.stringify(this.state));
      return this.getState();
    }

    getState() {
      return cloneState(this.state);
    }

    list(query = '') {
      const needle = cleanText(query, '', 200).toLocaleLowerCase();
      return this.state.devices
        .filter((device) => !needle || `${device.name}\n${device.relayUrl}`.toLocaleLowerCase().includes(needle))
        .map((device) => ({ ...device }));
    }

    get(deviceId) {
      const device = this.state.devices.find((item) => item.id === deviceId);
      return device ? { ...device } : null;
    }

    getActive() {
      return this.get(this.state.activeDeviceId);
    }

    add(value) {
      if (this.state.devices.length >= MAX_DEVICES) throw new Error(`最多保存 ${MAX_DEVICES} 台设备`);
      const device = sanitizeDevice(value);
      if (!device) throw new Error('设备信息不完整');
      if (this.state.devices.some((item) => item.id === device.id)) throw new Error('设备 ID 已存在');
      this.state.devices.push(device);
      if (!this.state.activeDeviceId) this.state.activeDeviceId = device.id;
      this.save();
      return { ...device };
    }

    update(deviceId, patch) {
      const index = this.state.devices.findIndex((item) => item.id === deviceId);
      if (index < 0) throw new Error('设备不存在');
      const updated = sanitizeDevice({
        ...this.state.devices[index],
        ...(patch || {}),
        id: deviceId,
        updatedAt: Date.now(),
      });
      if (!updated) throw new Error('设备信息不完整');
      this.state.devices[index] = updated;
      this.save();
      return { ...updated };
    }

    remove(deviceId) {
      const index = this.state.devices.findIndex((item) => item.id === deviceId);
      if (index < 0) return false;
      this.state.devices.splice(index, 1);
      delete this.state.sessionAliases[deviceId];
      if (this.state.activeDeviceId === deviceId) {
        this.state.activeDeviceId = this.state.devices[Math.min(index, this.state.devices.length - 1)]?.id || '';
      }
      this.save();
      return true;
    }

    select(deviceId) {
      if (!this.state.devices.some((item) => item.id === deviceId)) throw new Error('设备不存在');
      this.state.activeDeviceId = deviceId;
      this.save();
      return this.get(deviceId);
    }

    setSessionAlias(deviceId, sessionId, alias) {
      if (!this.get(deviceId) || !validId(sessionId)) throw new Error('设备或会话不存在');
      const name = cleanText(alias, '', 120);
      const aliases = { ...(this.state.sessionAliases[deviceId] || {}) };
      if (name) {
        if (!Object.prototype.hasOwnProperty.call(aliases, sessionId) && Object.keys(aliases).length >= MAX_ALIASES_PER_DEVICE) {
          throw new Error(`每台设备最多保存 ${MAX_ALIASES_PER_DEVICE} 个会话名称`);
        }
        aliases[sessionId] = name;
      } else {
        delete aliases[sessionId];
      }
      if (Object.keys(aliases).length > 0) this.state.sessionAliases[deviceId] = aliases;
      else delete this.state.sessionAliases[deviceId];
      this.save();
      return name;
    }

    getSessionAlias(deviceId, sessionId) {
      return this.state.sessionAliases[deviceId]?.[sessionId] || '';
    }
  }

  return {
    DeviceRegistry,
    STORAGE_KEY,
    MAX_DEVICES,
    MAX_ALIASES_PER_DEVICE,
    sanitizeState,
    validId,
  };
});
