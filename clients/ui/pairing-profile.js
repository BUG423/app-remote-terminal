(function expose(factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.PairingProfile = api;
})(function buildPairingProfile() {
  'use strict';

  function relayUrl(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('配对配置缺少中转地址');
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && local)) {
      throw new Error('公网中转地址必须使用 wss://');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('中转地址不能包含 Token、用户名、查询参数或片段');
    }
    return url.toString();
  }

  function parseProfile(input, role) {
    if (typeof input === 'string' && input.length > 16384) throw new Error('配对配置过大');
    let value;
    try { value = typeof input === 'string' ? JSON.parse(input) : input; } catch {
      throw new Error('配对配置不是有效的 JSON');
    }
    if (!['app', 'agent'].includes(role)) throw new Error('未知的配对角色');
    if (!value || value.type !== 'remote-terminal-' + role || value.version !== 1) {
      throw new Error(role === 'app' ? '请粘贴 APP 配对配置，不能使用 Agent 配置' : '请使用 Agent 配对配置，不能使用 APP 配置');
    }
    const tokenKey = role === 'app' ? 'browserToken' : 'agentToken';
    const otherKey = role === 'app' ? 'agentToken' : 'browserToken';
    const token = value[tokenKey];
    if (Object.prototype.hasOwnProperty.call(value, otherKey)) throw new Error('配对配置不能混合两种 Token');
    if (typeof token !== 'string' || token.length < 32 || token.length > 512 ||
        new TextEncoder().encode(token).byteLength > 1024 || /change-me|deprecated|your-token|shared-secret/i.test(token)) {
      throw new Error(tokenKey + ' 必须是有效的 32–512 字符凭据');
    }
    const urlKey = role === 'app' ? 'relayUrl' : 'serverUrl';
    return {
      type: value.type,
      version: 1,
      name: String(value.name || '远程电脑').replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').trim().slice(0, 80),
      [urlKey]: relayUrl(value[urlKey]),
      [tokenKey]: token,
    };
  }

  return { relayUrl, parseProfile };
});
