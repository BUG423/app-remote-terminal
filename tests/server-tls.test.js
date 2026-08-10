'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pinnedLocalTlsOptions } = require('../scripts/monitor-server');
const WebSocket = require('../server/node_modules/ws');

const root = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-terminal-tls-'));
const cert = path.join(temp, 'cert.pem');
const key = path.join(temp, 'key.pem');
const configPath = path.join(temp, 'config.json');
const port = 32000 + Math.floor(Math.random() * 1000);
const browserToken = `browser-${'b'.repeat(40)}`;
const agentToken = `agent-${'a'.repeat(40)}`;
const debug = process.env.DEBUG_TLS_TEST === '1';
let server;
let serverLog = '';
let tlsOptions;

function request(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: '127.0.0.1', port, path: pathname, ...tlsOptions,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.setTimeout(500, () => req.destroy(new Error('request timeout')));
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const health = await request('/health');
      if (health.status === 200) return health;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`TLS Relay did not start: ${serverLog}`);
}

function authenticate() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, tlsOptions);
    const timer = setTimeout(() => reject(new Error('WSS auth timeout')), 5000);
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'auth', role: 'browser', token: browserToken, protocolVersion: 2,
    })));
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'auth_ok') return;
      clearTimeout(timer);
      ws.close();
      resolve(message);
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

(async () => {
  try {
    const generated = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    tlsOptions = pinnedLocalTlsOptions({ tlsCertPath: cert });

    fs.writeFileSync(configPath, JSON.stringify({
      port,
      bindHost: '127.0.0.1',
      useTLS: true,
      tlsCertPath: cert,
      tlsKeyPath: key,
      devices: { test: { name: 'test', browserToken, agentToken } },
    }), { mode: 0o600 });

    server = spawn(process.execPath, ['server/index.js'], {
      cwd: root,
      env: { ...process.env, CW_CONFIG_PATH: configPath },
      stdio: debug ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (data) => { serverLog += data; });
    server.stderr?.on('data', (data) => { serverLog += data; });
    server.on('error', (error) => { serverLog += `spawn error: ${error.message}\n`; });
    server.on('exit', (code, signal) => { serverLog += `exit code=${code} signal=${signal}\n`; });

    const health = await waitForHealth();
    assert.equal(JSON.parse(health.body).status, 'ok');
    assert(health.headers['strict-transport-security']?.includes('max-age='));

    const retired = await request('/app.js');
    assert.equal(retired.status, 410);
    assert.equal(JSON.parse(retired.body).code, 'WEB_UI_RETIRED');

    const auth = await authenticate();
    assert.equal(auth.role, 'browser');
    assert.equal(auth.protocolVersion, 2);
    console.log('✅ Relay 原生 TLS、410 控制面与 WSS 鉴权通过');
  } finally {
    if (server && server.exitCode == null) server.kill('SIGTERM');
    if (debug) console.error(`TLS test files preserved at ${temp}`);
    else fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(`❌ Relay TLS 测试失败: ${error.stack || error.message}`);
  process.exitCode = 1;
});
