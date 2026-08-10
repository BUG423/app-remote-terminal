'use strict';

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

class RateLimiter {
  constructor(options = {}) {
    this.maxAttempts = boundedInt(options.maxAttempts, 8, 1, 1000);
    this.windowMs = boundedInt(options.windowMs, 60000, 1000, 60 * 60 * 1000);
    this.blockMs = boundedInt(options.blockMs, 300000, 1000, 24 * 60 * 60 * 1000);
    this.maxTrackedIps = boundedInt(options.maxTrackedIps, 10000, 100, 100000);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.attempts = new Map();
  }

  recordFailed(ip) {
    const now = this.now();
    let entry = this.attempts.get(ip);
    if (!entry || now - entry.firstAttempt > this.windowMs) {
      if (!entry && this.attempts.size >= this.maxTrackedIps) {
        this.cleanup();
        while (this.attempts.size >= this.maxTrackedIps) {
          this.attempts.delete(this.attempts.keys().next().value);
        }
      }
      entry = { count: 0, firstAttempt: now };
      this.attempts.set(ip, entry);
    }
    entry.count++;
    if (entry.count >= this.maxAttempts && !entry.blockedUntil) {
      entry.blockedUntil = now + this.blockMs;
      console.warn(`🚫 速率限制: IP ${ip} 已被封禁 ${this.blockMs / 1000}s（${entry.count} 次失败）`);
    }
  }

  checkBlocked(ip) {
    const now = this.now();
    const entry = this.attempts.get(ip);
    if (!entry) return { blocked: false };
    if (entry.blockedUntil && now >= entry.blockedUntil) {
      this.attempts.delete(ip);
      return { blocked: false };
    }
    if (entry.blockedUntil) {
      return {
        blocked: true,
        reason: `请求过于频繁，请 ${Math.ceil((entry.blockedUntil - now) / 1000)} 秒后重试`,
      };
    }
    return { blocked: false };
  }

  clearFor(ip) {
    this.attempts.delete(ip);
  }

  cleanup() {
    const now = this.now();
    for (const [ip, entry] of this.attempts) {
      if ((entry.blockedUntil && now >= entry.blockedUntil) ||
          (!entry.blockedUntil && now - entry.firstAttempt > this.windowMs * 2)) {
        this.attempts.delete(ip);
      }
    }
  }

  stats() {
    return {
      trackedIPs: this.attempts.size,
      threshold: this.maxAttempts,
      windowMs: this.windowMs,
      blockMs: this.blockMs,
      maxTrackedIps: this.maxTrackedIps,
    };
  }
}

const limiter = new RateLimiter({
  maxAttempts: process.env.CW_RATE_LIMIT_MAX,
  windowMs: process.env.CW_RATE_LIMIT_WINDOW,
  blockMs: process.env.CW_RATE_LIMIT_BLOCK,
  maxTrackedIps: process.env.CW_RATE_LIMIT_MAX_IPS,
});
const cleanupTimer = setInterval(() => limiter.cleanup(), 300000);
cleanupTimer.unref();

module.exports = {
  RateLimiter,
  recordFailed: (ip) => limiter.recordFailed(ip),
  checkBlocked: (ip) => limiter.checkBlocked(ip),
  clearFor: (ip) => limiter.clearFor(ip),
  stats: () => limiter.stats(),
};
