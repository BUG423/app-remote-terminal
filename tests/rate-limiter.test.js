'use strict';

const assert = require('node:assert');
const { RateLimiter } = require('../server/rate-limiter');

let now = 1000;
const limiter = new RateLimiter({
  maxAttempts: 2,
  windowMs: 1000,
  blockMs: 5000,
  maxTrackedIps: 100,
  now: () => now,
});

limiter.recordFailed('127.0.0.1');
assert.equal(limiter.checkBlocked('127.0.0.1').blocked, false);
limiter.recordFailed('127.0.0.1');
assert.equal(limiter.checkBlocked('127.0.0.1').blocked, true);

now += 5001;
assert.equal(limiter.checkBlocked('127.0.0.1').blocked, false);
assert.equal(limiter.stats().trackedIPs, 0);

const immediate = new RateLimiter({ maxAttempts: 1, now: () => now });
immediate.recordFailed('203.0.113.1');
assert.equal(immediate.checkBlocked('203.0.113.1').blocked, true);
immediate.clearFor('203.0.113.1');
assert.equal(immediate.checkBlocked('203.0.113.1').blocked, false);

console.log('✅ 鉴权失败限流、回环地址保护和封禁过期测试通过');
