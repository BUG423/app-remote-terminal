'use strict';

const assert = require('node:assert');
const {
  createAuthMiddleware,
  configuredTokenIsValid,
  tokenShapeIsValid,
} = require('../server/auth');

const browserToken = `browser-${'b'.repeat(40)}`;
const agentToken = `agent-${'a'.repeat(40)}`;
const secondBrowserToken = `browser-${'c'.repeat(40)}`;
const secondAgentToken = `agent-${'d'.repeat(40)}`;

const auth = createAuthMiddleware({
  devices: {
    production: { name: 'Production\nAgent', browserToken, agentToken },
    staging: { name: 'Staging', browserToken: secondBrowserToken, agentToken: secondAgentToken },
  },
});

const browser = auth.verify(browserToken, 'browser');
const agent = auth.verify(agentToken, 'agent');
assert(browser.valid);
assert(agent.valid);
assert.equal(browser.routingKey, agent.routingKey);
assert.notEqual(browser.routingKey, browserToken);
assert.equal(browser.name, 'Production Agent');
assert.equal(auth.verify(browserToken, 'agent').valid, false);
assert.equal(auth.verify(agentToken, 'browser').valid, false);
assert.equal(auth.verify('invalid', 'browser').valid, false);
assert.equal(auth.verify(browserToken, 'admin').valid, false);
assert.equal(auth.mode, 'devices');
assert.equal(auth.tokenCount, 2);
assert.match(auth.generateSessionId(), /^[0-9a-f-]{36}$/);

assert(tokenShapeIsValid('x'.repeat(32)));
assert(!tokenShapeIsValid('x'.repeat(31)));
assert(!tokenShapeIsValid('x'.repeat(513)));
assert(!tokenShapeIsValid('中'.repeat(400)));
assert(!configuredTokenIsValid('change-me-' + 'x'.repeat(32)));

assert.throws(() => createAuthMiddleware({}), /devices/);
assert.throws(() => createAuthMiddleware({ devices: {} }), /at least one/);
assert.throws(() => createAuthMiddleware({
  devices: { '../bad': { browserToken, agentToken } },
}), /invalid device id/);
assert.throws(() => createAuthMiddleware({
  devices: { bad: { browserToken: 'short', agentToken } },
}), /tokens must/);
assert.throws(() => createAuthMiddleware({
  devices: { bad: { browserToken, agentToken: browserToken } },
}), /different/);
assert.throws(() => createAuthMiddleware({
  devices: {
    one: { browserToken, agentToken },
    two: { browserToken, agentToken: secondAgentToken },
  },
}), /reuses a credential/);
assert.throws(() => createAuthMiddleware({
  tokens: { [browserToken]: 'legacy' },
}), /devices/);

console.log('✅ 角色分离鉴权、配置拒绝策略和 Token 边界测试通过');
