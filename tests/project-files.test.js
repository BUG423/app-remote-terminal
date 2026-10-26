'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const results = [];

function test(name, fn) {
  try {
    fn();
    results.push(true);
    console.log(`  ✅ ${name}`);
  } catch (err) {
    results.push(false);
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

console.log('╔══════════════════════════════════════════╗');
console.log('║   配置、部署脚本与静态资源检查           ║');
console.log('╚══════════════════════════════════════════╝');

test('Relay 与 Agent 配置模板合法且凭据职责分离', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json.example'), 'utf8'));
  const agentConfig = JSON.parse(fs.readFileSync(path.join(root, 'agent/config.json.example'), 'utf8'));
  assert.equal(config.bindHost, '0.0.0.0');
  assert.equal(config.port, 443);
  assert.equal(config.useTLS, true);
  const device = config.devices['server-a'];
  assert.notEqual(device.browserToken, device.agentToken);
  assert.equal(config.agentToken, undefined);
  assert.equal(config.serverUrl, undefined);
  assert.equal(agentConfig.devices, undefined);
  assert.equal(agentConfig.serverUrl, 'wss://terminal.example.com');
  assert.equal(agentConfig.workspaceRoot, undefined);
  assert.equal(agentConfig.allowRootAgent, undefined);
  assert.equal(typeof agentConfig.requiredUser, 'string');
  assert.equal(Number.isSafeInteger(agentConfig.requiredUid), true);
  assert.equal(path.isAbsolute(agentConfig.requiredHome), true);
  assert.equal(path.isAbsolute(agentConfig.requiredWorkingDirectory), true);
  assert.equal(agentConfig.auditLogPath, undefined);
});

for (const file of ['deploy.sh', 'start-local.sh', 'scripts/run-server-tests.sh', 'scripts/install-relay-certificate.sh']) {
  test(`${file} 通过 bash 语法检查`, () => {
    const result = spawnSync('bash', ['-n', file], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
}

test('部署脚本不上传密钥、不改防火墙和系统入口配置', () => {
  const source = fs.readFileSync(path.join(root, 'deploy.sh'), 'utf8');
  assert(!/scp\s/i.test(source));
  assert(!/ufw\s/i.test(source));
  assert(!/sites-enabled\/default/.test(source));
  assert(!/systemctl\s+(?:enable|disable)/.test(source));
});

test('部署脚本保留外置配置并只使用低权限 systemd 服务', () => {
  const source = fs.readFileSync(path.join(root, 'deploy.sh'), 'utf8');
  assert(source.includes('REMOTE_CONFIG_PATH'));
  assert(source.includes('systemctl cat "${SERVER_SERVICE}"'));
  assert(source.includes('systemctl restart "${SERVER_SERVICE}"'));
  assert(!source.includes('pm2'));
  assert(source.includes('systemctl cat "${SERVER_SERVICE}"'));
  assert(!source.includes('CW_CONFIG_PATH="${REMOTE_DIR}/config.json"'));
  assert(source.includes('for attempt in {1..15}'));
  assert(source.includes('health check failed after 15 seconds'));
});

test('本地 Agent 启动脚本不管理无关进程或旧聊天 CLI', () => {
  const source = fs.readFileSync(path.join(root, 'start-local.sh'), 'utf8');
  assert(!source.includes('pm2'));
  assert(!/useradd|adduser|chown/.test(source));
  assert(!source.includes('claude --version'));
  assert(source.includes('agent/config.json'));
  assert(source.includes('id -un'));
  assert(source.includes('Working directory'));
  assert(source.includes('NODE_ENV=production'));
  assert(source.includes('exec env'));
});

test('客户端 UI 只引用安装包内依赖', () => {
  const html = fs.readFileSync(path.join(root, 'clients/ui/index.html'), 'utf8');
  assert(html.includes('./vendor/xterm.js'));
  assert(html.includes('./vendor/addon-unicode11.js'));
  assert(html.includes('./strict-websocket.js'));
  assert(html.includes('./terminal-stream.js'));
  assert(!/https?:\/\//.test(html));
});

test('云端 Relay 不包含网页目录或 Express 运行时', () => {
  assert(!fs.existsSync(path.join(root, 'server/public')));
  const source = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
  const serverPackage = JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8'));
  assert(!source.includes("require('express')"));
  assert(!Object.hasOwn(serverPackage.dependencies, 'express'));
  assert(!Object.hasOwn(serverPackage.dependencies, '@xterm/xterm'));
  assert(!Object.hasOwn(serverPackage.dependencies, '@xterm/addon-fit'));
});

test('Relay 使用受限系统账户，Agent 用户单元保持当前身份', () => {
  const serverUnit = fs.readFileSync(path.join(root, 'deploy/systemd/remote-terminal-server.service'), 'utf8');
  const agentUnit = fs.readFileSync(path.join(root, 'deploy/systemd/remote-terminal-agent.service'), 'utf8');
  assert(serverUnit.includes('User=remote-terminal-server'));
  assert(serverUnit.includes('NoNewPrivileges=true'));
  assert(serverUnit.includes('AmbientCapabilities=CAP_NET_BIND_SERVICE'));
  assert(serverUnit.includes('CapabilityBoundingSet=CAP_NET_BIND_SERVICE'));
  assert(serverUnit.includes('MemoryMax='));
  assert(agentUnit.includes('MemoryMax='));
  assert(agentUnit.includes('EnvironmentFile=%h/.config/remote-terminal/agent.env'));
  assert(agentUnit.includes('REMOTE_TERMINAL_WORKING_DIRECTORY'));
  assert(!/^User=/m.test(agentUnit));
  assert(!/^Group=/m.test(agentUnit));
  assert(!agentUnit.includes('/var/lib/remote-terminal-agent'));
  assert(!/useradd|adduser|chown/.test(agentUnit));
  assert(!agentUnit.includes('remote-terminal-server.service'));
  assert(serverUnit.includes('PrivateDevices=true'));
  assert(serverUnit.includes('ProtectProc=invisible'));
});

test('Agent 不创建用户、HOME 或工作目录', () => {
  const source = [
    'agent/index.js', 'agent/session-manager.js', 'agent/terminal.js',
    'agent/runtime-identity.js', 'start-local.sh', 'deploy/systemd/remote-terminal-agent.service',
  ].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert(!/useradd|adduser/.test(source));
  assert(!source.includes('User=remote-terminal-agent'));
  assert(!source.includes("mkdirSync(cwd"));
  assert(!source.includes('mkdirSync(resolved'));
  assert(source.includes('Agent never creates workspaces'));
});

test('证书安装脚本只发布受限权限副本并支持 Certbot hook', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/install-relay-certificate.sh'), 'utf8');
  assert(source.includes('RENEWED_LINEAGE'));
  assert(source.includes('/etc/remote-terminal/tls'));
  assert(source.includes('-m 0640'));
  assert(source.includes('remote-terminal-server'));
  assert(!source.includes('chmod 777'));
});

test('定期监控单元默认只读且不持有进程扫描/强杀权限', () => {
  const monitorUnit = fs.readFileSync(path.join(root, 'deploy/systemd/remote-terminal-monitor.service'), 'utf8');
  const monitorTimer = fs.readFileSync(path.join(root, 'deploy/systemd/remote-terminal-monitor.timer'), 'utf8');
  assert(monitorUnit.includes('Type=oneshot'));
  assert(monitorUnit.includes('Environment=RT_MONITOR_AUTO_HEAL=0'));
  assert(monitorUnit.includes('EnvironmentFile=-/etc/remote-terminal/monitor.env'));
  assert(monitorUnit.includes('StateDirectory=remote-terminal-monitor'));
  assert(monitorUnit.includes('NoNewPrivileges=true'));
  assert(monitorUnit.includes('MemoryMax='));
  assert(monitorUnit.includes('CapabilityBoundingSet=CAP_DAC_READ_SEARCH'));
  assert(!monitorUnit.includes('CAP_KILL'));
  assert(!monitorUnit.includes('CAP_SYS_PTRACE'));
  assert(monitorTimer.includes('OnUnitInactiveSec=5min'));
  assert(monitorTimer.includes('Persistent=true'));
  assert(!monitorUnit.includes('/agent/index.js'));
  assert(!monitorUnit.includes('nginx.service'));
});

test('监控脚本通过 Node 语法检查', () => {
  const result = spawnSync(process.execPath, ['--check', 'scripts/monitor-server.js'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const source = fs.readFileSync(path.join(root, 'scripts/monitor-server.js'), 'utf8');
  assert(!source.includes("serviceState('nginx.service')"));
  assert(!source.includes('process.kill('));
});

test('旧聊天协议、原始按键审计和 PM2 回退代码均已删除', () => {
  assert(!fs.existsSync(path.join(root, 'agent/audit-log.js')));
  const combined = [
    'agent/index.js', 'server/index.js', 'deploy.sh', 'start-local.sh',
  ].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert(!combined.includes("type: 'chat'"));
  assert(!combined.includes('claudeDangerouslySkipPermissions'));
  assert(!combined.includes('auditLogPath'));
  assert(!combined.includes('pm2'));
});

test('公开文件不包含高风险凭据或内部连接路径', () => {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer' });
  assert.equal(listed.status, 0, listed.stderr?.toString());
  const names = listed.stdout.toString('utf8').split('\0').filter(Boolean);
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /\bsk-[A-Za-z0-9]{20,}\b/,
    /\bLTAI[A-Za-z0-9]{16,}\b/,
    /\/(?:home|Users)\/[A-Za-z0-9._-]+\/(?:\.ssh|\.config|workspace|RAL)\//,
    /\/root\/(?:autodl-tmp|miniconda\d*|anaconda\d*)\//,
    /connect\.[a-z0-9]+\.seetacloud\.com/,
  ];
  const hits = [];
  for (const name of names) {
    if (/(^|\/)(?:pairing\/|\.ssh\/|\.env(?:\.(?!example$)[^/]+)?$|config\.json$)|\.(?:agent|app)\.json$|\.(?:key|pem|p12|jks|keystore)$/.test(name)) {
      hits.push(name);
      continue;
    }
    const bytes = fs.readFileSync(path.join(root, name));
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    if (patterns.some((pattern) => pattern.test(text))) hits.push(name);
  }
  assert.deepEqual(hits, [], `sensitive pattern found in: ${hits.join(', ')}`);
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 项目文件检查通过`);
if (passed !== results.length) process.exit(1);
