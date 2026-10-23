#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const { parseProfile, relayUrl } = require('../clients/ui/pairing-profile');
const { verifyRuntimeIdentity } = require('../agent/runtime-identity');
const { loadConfig } = require('../lib/load-config');
const { writePrivateJson } = require('../lib/private-json');

function buildAgentConfig(profile, workingDirectory = process.cwd()) {
  const parsed = parseProfile(profile, 'agent');
  const account = os.userInfo();
  const config = {
    agentToken: parsed.agentToken,
    serverUrl: parsed.serverUrl,
    requiredUser: account.username,
    ...(process.platform === 'win32' ? {} : { requiredUid: account.uid }),
    requiredHome: fs.realpathSync(account.homedir),
    requiredWorkingDirectory: fs.realpathSync(workingDirectory),
  };
  // Fail before writing if HOME or the selected account does not match.
  verifyRuntimeIdentity(config, { cwd: config.requiredWorkingDirectory });
  return config;
}

async function question(prompt, { hidden = false } = {}) {
  let muted = false;
  const output = new Writable({ write(chunk, encoding, done) {
    if (!muted) process.stdout.write(chunk, encoding);
    done();
  } });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  try {
    process.stdout.write(prompt);
    muted = hidden;
    return (await rl.question('')).trim();
  } finally {
    rl.close();
    if (hidden) process.stdout.write('\n');
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    profile: { type: 'string' },
    workspace: { type: 'string' },
    config: { type: 'string' },
    replace: { type: 'boolean', default: false },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('用法：node scripts/setup-agent.js [--profile <Agent配对文件>] [--workspace <既有目录>] [--config <输出文件>] [--replace]');
    console.log('默认绑定当前登录账户和当前工作目录；只生成配置，不启动 Agent。');
    return;
  }
  const configPath = path.resolve(values.config || process.env.CW_CONFIG_PATH || path.join(__dirname, '../agent/config.json'));
  if (fs.existsSync(configPath) && !values.replace) throw new Error('配置已存在；如需重新配置，请加 --replace，原配置将自动备份');
  let profile;
  if (values.profile) {
    profile = loadConfig(values.profile, { label: 'Agent pairing profile' });
  } else {
    if (!process.stdin.isTTY) throw new Error('非交互运行请提供 --profile <Agent配对文件>');
    const serverUrl = relayUrl(await question('阿里云中转地址 [wss://webclaude.xmu-zss.cn]：') || 'wss://webclaude.xmu-zss.cn');
    const agentToken = await question('Agent 接入 Token（agentToken，输入不回显）：', { hidden: true });
    profile = { type: 'remote-terminal-agent', version: 1, serverUrl, agentToken };
  }
  const config = buildAgentConfig(profile, values.workspace || process.cwd());
  const result = writePrivateJson(configPath, config, { replace: values.replace });
  console.log('Agent 配置已保存：' + result.path);
  if (result.backupPath) console.log('原配置备份：' + result.backupPath);
  console.log('运行账户：' + config.requiredUser);
  console.log('工作目录：' + config.requiredWorkingDirectory);
  console.log('中转地址：' + config.serverUrl);
  console.log('启动方式（保持当前登录账户，不要 sudo）：');
  const entry = path.resolve(__dirname, '../agent/index.js');
  if (process.platform === 'win32') {
    const quote = (value) => "'" + value.replace(/'/g, "''") + "'";
    console.log('  Set-Location -LiteralPath ' + quote(config.requiredWorkingDirectory));
    console.log('  $env:CW_CONFIG_PATH = ' + quote(configPath));
    console.log('  node ' + quote(entry));
  } else {
    const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
    console.log('  cd -- ' + quote(config.requiredWorkingDirectory));
    console.log('  CW_CONFIG_PATH=' + quote(configPath) + ' node ' + quote(entry));
  }
  console.log('首次运行请先在项目目录执行 npm ci --prefix agent；本机 APP 使用该设备的 browserToken。');
}

if (require.main === module) main().catch((error) => {
  console.error('配置失败：' + error.message);
  process.exitCode = 1;
});

module.exports = { buildAgentConfig };
