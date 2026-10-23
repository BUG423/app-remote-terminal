'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { addDevice, profiles, addToFile } = require('../scripts/manage-devices');
const { buildAgentConfig } = require('../scripts/setup-agent');
const { writePrivateJson } = require('../lib/private-json');
const { parseProfile } = require('../clients/ui/pairing-profile');
const { createAuthMiddleware } = require('../server/auth');
const { verifyRuntimeIdentity } = require('../agent/runtime-identity');
const { checkRemoteAgent } = require('../scripts/monitor-server');
const WebSocket = require('../server/node_modules/ws');

const original = {
  port: 443, bindHost: '0.0.0.0', useTLS: true,
  devices: { a100: { name: 'A100', browserToken: 'browser-' + 'a'.repeat(40), agentToken: 'agent-' + 'b'.repeat(40) } },
  maxSessions: 12,
};

test('新增设备保留旧凭据和服务设置，两种新凭据只路由到同一台新电脑', () => {
  const updated = addDevice(original, 'office-pc', '办公室电脑');
  assert.deepEqual(updated.devices.a100, original.devices.a100);
  assert.equal(updated.port, original.port);
  assert.equal(updated.maxSessions, original.maxSessions);
  assert.equal(Object.keys(original.devices).length, 1);
  const auth = createAuthMiddleware(updated);
  const d = updated.devices['office-pc'];
  const browser = auth.verify(d.browserToken, 'browser');
  const agent = auth.verify(d.agentToken, 'agent');
  assert.equal(browser.valid, true);
  assert.equal(agent.valid, true);
  assert.equal(browser.routingKey, agent.routingKey);
  assert.notEqual(browser.routingKey, auth.verify(original.devices.a100.browserToken, 'browser').routingKey);
  assert.equal(auth.verify(d.browserToken, 'agent').valid, false);
  assert.throws(() => addDevice(updated, 'office-pc'), /设备已存在/);
  for (const id of ['../bad', '__proto__', 'constructor']) assert.throws(() => addDevice(original, id));
});

test('配对配置不携带另一角色的凭据，Agent 导入绑定实际账户和工作目录', () => {
  const updated = addDevice(original, 'office');
  const pair = profiles(updated, 'office', 'wss://relay.example.cn');
  assert.equal(Object.hasOwn(pair.agent, 'browserToken'), false);
  assert.equal(Object.hasOwn(pair.app, 'agentToken'), false);
  assert.equal(parseProfile(JSON.stringify(pair.app), 'app').browserToken, updated.devices.office.browserToken);
  const config = buildAgentConfig(pair.agent);
  assert.equal(config.requiredUser, os.userInfo().username);
  assert.equal(config.requiredWorkingDirectory, fs.realpathSync(process.cwd()));
  assert.equal(verifyRuntimeIdentity(config).home, fs.realpathSync(os.userInfo().homedir));
  assert.throws(() => parseProfile(pair.agent, 'app'), /APP 配对/);
  assert.throws(() => parseProfile(pair.app, 'agent'), /Agent 配对/);
  assert.throws(() => parseProfile({ ...pair.app, agentToken: pair.agent.agentToken }, 'app'), /混合/);
  for (const address of ['ws://public.example.cn', 'wss://user:secret@relay.example.cn', 'wss://relay.example.cn?token=secret']) {
    assert.throws(() => profiles(updated, 'office', address));
  }
});

test('配置备份和原子写入限制文件权限，拒绝覆盖及符号链接', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-config-'));
  try {
    const configPath = path.join(temp, 'server.json');
    writePrivateJson(configPath, original);
    const updated = await addToFile(configPath, 'office', '办公室');
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), updated);
    const backups = fs.readdirSync(temp).filter((name) => name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp, backups[0]), 'utf8')), original);
    if (process.platform !== 'win32') {
      for (const name of ['server.json', ...backups]) assert.equal(fs.statSync(path.join(temp, name)).mode & 0o777, 0o600);
    }
    assert.equal(fs.existsSync(configPath + '.lock'), false);
    assert.throws(() => writePrivateJson(configPath, original), /已存在/);
    const link = path.join(temp, 'link.json');
    fs.symlinkSync(configPath, link);
    assert.throws(() => writePrivateJson(link, original, { replace: true }), /符号链接/);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), updated);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('重启失败时恢复原配置和服务，释放配置锁', { skip: process.platform === 'win32' }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-rollback-'));
  const server = http.createServer((_req, res) => res.end('{"status":"ok"}'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const savedPath = process.env.PATH;
  try {
    const configPath = path.join(temp, 'server.json');
    const config = { ...original, port: server.address().port, bindHost: '127.0.0.1', useTLS: false };
    writePrivateJson(configPath, config);
    const counter = path.join(temp, 'restarted');
    fs.writeFileSync(path.join(temp, 'systemctl'), '#!/bin/sh\nif [ ! -f "' + counter + '" ]; then\n  touch "' + counter + '"\n  exit 1\nfi\nexit 0\n', { mode: 0o700 });
    process.env.PATH = temp + path.delimiter + savedPath;
    await assert.rejects(() => addToFile(configPath, 'office', 'Office', true), /已恢复原配置并启动原服务/);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), config);
    assert.equal(fs.existsSync(configPath + '.lock'), false);
  } finally {
    process.env.PATH = savedPath;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('向导命令可导入 Agent 文件，不打印 Token，不覆盖已有配置', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-setup-'));
  try {
    const profilePath = path.join(temp, 'office.agent.json');
    const configPath = path.join(temp, 'agent.json');
    const pair = profiles(addDevice(original, 'office'), 'office', 'wss://relay.example.cn');
    writePrivateJson(profilePath, pair.agent);
    const args = ['scripts/setup-agent.js', '--profile', profilePath, '--config', configPath];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert(!first.stdout.includes(pair.agent.agentToken));
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).agentToken, pair.agent.agentToken);
    const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /已存在/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('在线探针区分离线和认证失败，完成后及时关闭连接', async () => {
  const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const config = { bindHost: '127.0.0.1', port: server.address().port, useTLS: false };
  server.on('connection', (ws) => ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    ws.send(JSON.stringify(m.token === 'valid' ? { type: 'auth_ok', role: 'browser', agentOnline: false } : { type: 'error', message: 'Invalid token' }));
  }));
  try {
    assert.deepEqual(await checkRemoteAgent(config, { id: 'office', name: 'Office', browserToken: 'valid' }), {
      ok: false, online: false, agentName: 'Office', sessions: 0,
    });
    const rejected = await checkRemoteAgent(config, { browserToken: 'bad' });
    assert.equal(rejected.error, 'Invalid token');
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});
