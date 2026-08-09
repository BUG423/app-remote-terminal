'use strict';

const assert = require('node:assert');
const { ClientSettingsStore, DEFAULTS, sanitize } = require('../clients/ui/client-settings');

class MemoryStorage {
  constructor(value = null) { this.value = value; }
  getItem() { return this.value; }
  setItem(_key, value) { this.value = value; }
}

assert.deepEqual(sanitize(null), DEFAULTS);
assert.deepEqual(sanitize({
  fontSize: 999,
  scrollback: -1,
  cursorBlink: false,
  pinnedSessionIds: ['a', 'a', 1, 'b'],
}), {
  ...DEFAULTS,
  fontSize: 24,
  scrollback: 1000,
  cursorBlink: false,
  pinnedSessionIds: ['a', 'b'],
});

const corrupt = new ClientSettingsStore(new MemoryStorage('{broken'));
assert.deepEqual(corrupt.get(), DEFAULTS);

const storage = new MemoryStorage();
const store = new ClientSettingsStore(storage);
const updated = store.update({ fontSize: 18, scrollback: 9000, pinnedSessionIds: ['session-a'] });
assert.equal(updated.fontSize, 18);
assert.equal(updated.scrollback, 9000);
assert.deepEqual(updated.pinnedSessionIds, ['session-a']);
updated.pinnedSessionIds.push('external-mutation');
assert.deepEqual(store.get().pinnedSessionIds, ['session-a']);
assert.deepEqual(JSON.parse(storage.value).pinnedSessionIds, ['session-a']);

store.reset();
assert.deepEqual(store.get(), DEFAULTS);

console.log('✅ 客户端设置校验、持久化、损坏恢复和边界限制通过');
