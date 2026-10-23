#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { spawnSync } = require('node:child_process');
const { loadConfig } = require('../lib/load-config');
const { writePrivateJson } = require('../lib/private-json');
const { createAuthMiddleware } = require('../server/auth');
const { relayUrl } = require('../clients/ui/pairing-profile');
const { checkInternalHealth, checkRemoteAgent } = require('./monitor-server');

function addDevice(config, id, name) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id || '') || ['__proto__', 'constructor', 'prototype'].includes(id)) {
    throw new Error('设备 ID 需要 1–64 个字母、数字、点、下划线或短横线');
  }
  if (Object.hasOwn(config.devices || {}, id)) throw new Error('设备已存在：' + id + '；请用 show 查看，不能覆盖旧电脑');
  createAuthMiddleware(config);
  const updated = { ...config, devices: { ...config.devices, [id]: {
    name: String(name || id).replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').trim().slice(0, 80),
    browserToken: crypto.randomBytes(32).toString('base64url'),
    agentToken: crypto.randomBytes(32).toString('base64url'),
  } } };
  createAuthMiddleware(updated);
  return updated;
}

function profiles(config, id, url) {
  if (!Object.hasOwn(config.devices, id)) throw new Error('设备不存在：' + id);
  const device = config.devices[id];
  const address = relayUrl(url);
  return {
    agent: { type: 'remote-terminal-agent', version: 1, name: device.name || id, serverUrl: address, agentToken: device.agentToken },
    app: { type: 'remote-terminal-app', version: 1, name: device.name || id, relayUrl: address, browserToken: device.browserToken },
  };
}

async function waitForHealth(config) {
  const host = ['0.0.0.0', '::'].includes(config.bindHost) ? '127.0.0.1' : (config.bindHost || '127.0.0.1');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await checkInternalHealth(config, host, config.port || 3002, 1000);
    if (result.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Relay 启动后的健康检查失败');
}

function restartService() {
  const result = spawnSync('systemctl', ['restart', 'remote-terminal-server.service'], {
    encoding: 'utf8', timeout: 15000,
  });
  if (result.error || result.status !== 0) throw new Error('重启失败：' + (result.error?.message || result.stderr.trim()));
}

async function addToFile(configPath, id, name, restart = false) {
  // Serialize this tool's read/modify/write sequence; never silently steal a lock.
  const lockPath = configPath + '.lock';
  let lock;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('配置正在被修改：' + lockPath);
    throw error;
  }
  try {
    const original = loadConfig(configPath, { label: 'Relay configuration' });
    const updated = addDevice(original, id, name);
    const saved = writePrivateJson(configPath, updated, { replace: true });
    console.log('配置备份：' + saved.backupPath);
    if (restart) {
      try {
        restartService();
        await waitForHealth(updated);
      } catch (error) {
        // Preserve the failed candidate in a backup and restore the known config.
        writePrivateJson(configPath, original, { replace: true });
        try { restartService(); await waitForHealth(original); } catch (rollbackError) {
          throw new Error(error.message + '；原配置已恢复，但服务恢复失败：' + rollbackError.message);
        }
        throw new Error(error.message + '；已恢复原配置并启动原服务');
      }
    }
    return updated;
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

async function status(config) {
  const result = spawnSync('systemctl', ['show', 'remote-terminal-server.service',
    '-p', 'ActiveState', '-p', 'SubState', '-p', 'UnitFileState', '-p', 'ExecMainStartTimestamp', '-p', 'NRestarts', '--no-pager'], {
    encoding: 'utf8', timeout: 5000,
  });
  console.log(result.status === 0 ? result.stdout.trim() : 'systemd 状态不可用；继续检查 Relay 连接');
  const host = ['0.0.0.0', '::'].includes(config.bindHost) ? '127.0.0.1' : (config.bindHost || '127.0.0.1');
  const health = await checkInternalHealth(config, host, config.port || 3002);
  console.log('Relay 健康检查：' + (health.ok ? '正常' : '失败'));
  if (!health.ok) throw new Error(health.error || 'HTTP ' + health.statusCode);
  for (const [id, device] of Object.entries(config.devices)) {
    const probe = await checkRemoteAgent(config, { id, ...device });
    const state = probe.online ? 'Agent 在线' : (probe.error ? '连接检查失败：' + probe.error : 'Agent 离线（尚未连接或已停止）');
    console.log(id + ' | ' + (device.name || id) + ' | ' + state + ' | 会话 ' + (probe.sessions || 0));
    if (probe.error) process.exitCode = 1;
  }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, name: { type: 'string' }, relay: { type: 'string' },
    output: { type: 'string' }, restart: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  const [command = 'status', id] = positionals;
  if (values.help) {
    console.log(`在 Relay 服务器运行：node scripts/manage-devices.js <命令> [设备ID] [选项]
  status                         检查服务、健康探针和每台 Agent 的在线状态（不输出 Token）
  list                           列出已配置设备（不输出 Token）
  add <ID> --relay <wss://地址>    新增电脑，自动生成两枚独立 Token，不覆盖已有电脑
  show <ID> --relay <wss://地址>   分别显示 Agent 配对配置和 APP 配对配置
选项：--config <文件>（默认 /etc/remote-terminal/server.json）
      --name <名称> --output <新的私密目录> --restart（仅 add；重启失败自动回滚）
配对文件含访问凭据；Agent 文件发给远程电脑，APP 文件留在控制端。`);
    return;
  }
  if (positionals.length > 2 || !['status', 'list', 'add', 'show'].includes(command)) throw new Error('未知命令，请加 --help 查看用法');
  if (['add', 'show'].includes(command) && !id) throw new Error('请指定设备 ID');
  if (values.restart && command !== 'add') throw new Error('--restart 仅可用于 add');
  if (values.output && !['add', 'show'].includes(command)) throw new Error('--output 仅可用于 add 或 show');
  if (['add', 'show'].includes(command)) relayUrl(values.relay);
  if (values.output && fs.existsSync(values.output)) throw new Error('输出目录已存在，请使用一个新的私密目录');
  const configPath = path.resolve(values.config || process.env.CW_CONFIG_PATH || '/etc/remote-terminal/server.json');
  const config = command === 'add'
    ? await addToFile(configPath, id, values.name, values.restart)
    : loadConfig(configPath, { label: 'Relay configuration' });
  createAuthMiddleware(config);
  if (command === 'status') return status(config);
  if (command === 'list') {
    for (const [deviceId, device] of Object.entries(config.devices)) console.log(deviceId + ' | ' + (device.name || deviceId));
    return;
  }
  const pair = profiles(config, id, values.relay);
  if (values.output) {
    const directory = path.resolve(values.output);
    fs.mkdirSync(directory, { mode: 0o700 });
    for (const role of ['agent', 'app']) {
      const filePath = path.join(directory, id + '.' + role + '.json');
      writePrivateJson(filePath, pair[role]);
      console.log((role === 'agent' ? '发给远程电脑：' : '留在本机 APP：') + filePath);
    }
  } else {
    console.log('\n发给远程电脑的 Agent 配对配置：\n' + JSON.stringify(pair.agent, null, 2));
    console.log('\n留在本机的 APP 配对配置：\n' + JSON.stringify(pair.app, null, 2));
  }
  if (command === 'add') console.log(values.restart
    ? '\n新增设备已生效；已有 Agent 会自动重连。'
    : '\n配置已保存；执行 systemctl restart remote-terminal-server.service 后生效（已有 Agent 会短暂重连）。');
}

if (require.main === module) main().catch((error) => {
  console.error('设备管理失败：' + error.message);
  process.exitCode = 1;
});

module.exports = { addDevice, profiles, addToFile };
