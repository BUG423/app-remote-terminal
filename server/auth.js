'use strict';

const crypto = require('node:crypto');

const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 512;
const MAX_TOKEN_BYTES = 1024;

function tokenShapeIsValid(token) {
  return typeof token === 'string' &&
    token.length >= MIN_TOKEN_LENGTH && token.length <= MAX_TOKEN_LENGTH &&
    Buffer.byteLength(token, 'utf8') <= MAX_TOKEN_BYTES;
}

function configuredTokenIsValid(token) {
  return tokenShapeIsValid(token) &&
    !/change-me|deprecated|your-token|shared-secret/i.test(token);
}

function cleanLabel(value, fallback) {
  const label = String(value || fallback || 'unknown')
    .replace(/[\x00-\x1F\x7F-\x9F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (label || fallback || 'unknown').slice(0, 120);
}

const digest = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();
const digestHex = (value) => digest(value).toString('hex');

function createAuthMiddleware(config) {
  const devices = config.devices;
  if (!devices || typeof devices !== 'object' || Array.isArray(devices)) {
    throw new Error('devices must be a non-empty object with role-separated credentials');
  }

  /** @type {Map<string, {name:string, digest:Buffer, routingKey:string, role:string}>} */
  const credentials = new Map();
  const routes = new Set();

  for (const [deviceId, device] of Object.entries(devices)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)) {
      throw new Error(`invalid device id: ${cleanLabel(deviceId, 'unknown')}`);
    }
    if (!device || typeof device !== 'object' || Array.isArray(device)) {
      throw new Error(`device ${deviceId} must be an object`);
    }

    const browserToken = device.browserToken;
    const agentToken = device.agentToken;
    if (!configuredTokenIsValid(browserToken) || !configuredTokenIsValid(agentToken)) {
      throw new Error(`device ${deviceId} tokens must be 32-512 characters and not use example values`);
    }
    if (browserToken === agentToken) {
      throw new Error(`device ${deviceId} must use different browser and Agent tokens`);
    }

    const browserKey = digestHex(browserToken);
    const agentKey = digestHex(agentToken);
    if (credentials.has(browserKey) || credentials.has(agentKey)) {
      throw new Error(`device ${deviceId} reuses a credential assigned to another device`);
    }

    const routingKey = digestHex(`device:${deviceId}`);
    const name = cleanLabel(device.name, deviceId);
    credentials.set(browserKey, { name, digest: digest(browserToken), routingKey, role: 'browser' });
    credentials.set(agentKey, { name, digest: digest(agentToken), routingKey, role: 'agent' });
    routes.add(routingKey);
  }

  if (routes.size === 0) {
    throw new Error('devices must contain at least one valid device');
  }

  return {
    verify(providedToken, role) {
      if (!tokenShapeIsValid(providedToken) || !['browser', 'agent'].includes(role)) {
        return { valid: false };
      }
      const providedDigest = digest(providedToken);
      const entry = credentials.get(providedDigest.toString('hex'));
      if (!entry || entry.role !== role || !crypto.timingSafeEqual(providedDigest, entry.digest)) {
        return { valid: false };
      }
      return { valid: true, name: entry.name, routingKey: entry.routingKey };
    },

    get tokenCount() {
      return routes.size;
    },

    get mode() {
      return 'devices';
    },

    generateSessionId() {
      return crypto.randomUUID();
    },
  };
}

module.exports = {
  createAuthMiddleware,
  configuredTokenIsValid,
  tokenShapeIsValid,
};
