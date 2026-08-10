'use strict';

const assert = require('node:assert');
const { DeviceRegistry, sanitizeState } = require('../clients/ui/device-store');

class MemoryStorage {
  constructor(value = null) { this.value = value; }
  getItem() { return this.value; }
  setItem(_key, value) { this.value = value; }
}

const storage = new MemoryStorage();
const registry = new DeviceRegistry(storage);
assert.deepEqual(registry.list(), []);
assert.equal(registry.getActive(), null);

registry.add({
  id: 'device-a',
  name: '  生产服务器  ',
  relayUrl: 'wss://a.example.cn',
  createdAt: 1,
});
registry.add({
  id: 'device-b',
  name: '测试服务器',
  relayUrl: 'wss://b.example.cn',
  token: 'must-never-enter-local-storage',
  createdAt: 2,
});
assert(!storage.value.includes('must-never-enter-local-storage'));
assert.equal(registry.getActive().id, 'device-a');
assert.equal(registry.list('测试').length, 1);
assert.equal(registry.list('a.example').length, 1);

registry.select('device-b');
registry.update('device-b', { name: '测试服务器（广州）' });
assert.equal(registry.getActive().name, '测试服务器（广州）');

registry.setSessionAlias('device-b', 'session-1', '部署任务');
assert.equal(registry.getSessionAlias('device-b', 'session-1'), '部署任务');
registry.setSessionAlias('device-b', 'session-1', '');
assert.equal(registry.getSessionAlias('device-b', 'session-1'), '');

assert(registry.remove('device-b'));
assert.equal(registry.getActive().id, 'device-a');
assert.equal(registry.remove('missing'), false);

const repaired = sanitizeState({
  activeDeviceId: 'missing',
  devices: [
    { id: 'safe', name: '', relayUrl: 'wss://safe.example.cn' },
    { id: 'safe', name: 'duplicate', relayUrl: 'wss://duplicate.example.cn' },
    { id: '../bad', name: 'bad', relayUrl: 'wss://bad.example.cn' },
    { id: '__proto__', name: 'prototype', relayUrl: 'wss://bad.example.cn' },
  ],
  sessionAliases: { safe: { good: '别名', '../bad': '忽略' } },
});
assert.equal(repaired.activeDeviceId, 'safe');
assert.equal(repaired.devices.length, 1);
assert.deepEqual(repaired.sessionAliases.safe, { good: '别名' });
assert.throws(() => registry.add({ id: 'constructor', name: 'bad', relayUrl: 'wss://bad.example.cn' }), /不完整/);
registry.update('device-a', { name: '安全\n设备' });
assert.equal(registry.get('device-a').name, '安全 设备');

console.log('✅ 多设备增删改查、搜索、选择、会话别名和损坏数据恢复通过');
