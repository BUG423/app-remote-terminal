'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OutputBacklog, splitUtf8 } = require('../agent/output-backlog');
const { buildTerminalEnv, resolveShell } = require('../agent/terminal-environment');
const { verifyRuntimeIdentity } = require('../agent/runtime-identity');
const { loadConfig } = require('../lib/load-config');
const {
  buildServerUrl,
  createConnectionOptions,
  getProxyUrl,
  noProxyMatch,
} = require('../agent/connection-options');

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
console.log('║   Agent 连接、配置与凭据边界测试         ║');
console.log('╚══════════════════════════════════════════╝');

test('serverUrl 支持 WSS、自定义端口和路径', () => {
  const url = buildServerUrl({ serverUrl: 'wss://relay.test:8443/terminal' }, {});
  assert.equal(url.toString(), 'wss://relay.test:8443/terminal');
});

test('拒绝旧地址字段、远程明文 WS、查询参数和 URL 凭据', () => {
  assert.throws(() => buildServerUrl({ serverHost: '127.0.0.1', serverPort: 3002 }, {}), /serverUrl/);
  assert.throws(() => buildServerUrl({ serverUrl: 'ws://relay.test' }, {}), /must use wss/);
  assert.throws(() => buildServerUrl({ serverUrl: 'wss://relay.test/?token=x' }, {}), /query/);
  assert.throws(() => buildServerUrl({ serverUrl: 'wss://user:pass@relay.test' }, {}), /credentials/);
  assert.equal(buildServerUrl({ serverUrl: 'ws://127.0.0.1:3002' }, {}).port, '3002');
});

test('NO_PROXY 支持域名后缀、端口和通配符', () => {
  const url = new URL('wss://agent.internal.example:443/ws');
  assert(noProxyMatch(url, '.internal.example'));
  assert(noProxyMatch(url, 'agent.internal.example:443'));
  assert(!noProxyMatch(url, 'agent.internal.example:8443'));
  assert(noProxyMatch(url, '*'));
});

test('显式代理可用，NO_PROXY 可安全绕过', () => {
  const url = new URL('wss://relay.test/ws');
  assert.equal(getProxyUrl(url, { proxyUrl: 'http://proxy.local:8080' }, {}).host, 'proxy.local:8080');
  assert.equal(getProxyUrl(url, { proxyUrl: 'http://proxy.local:8080' }, { NO_PROXY: 'relay.test' }), null);
  assert.throws(() => getProxyUrl(url, { proxyUrl: 'socks://proxy.local' }, {}), /http:\/\/ or https:\/\//);
});

test('WebSocket 连接关闭压缩、重定向并限制负载', () => {
  const url = new URL('wss://relay.test');
  const { options } = createConnectionOptions(url, { maxPayloadBytes: 256 * 1024 }, { NO_PROXY: '*' });
  assert.equal(options.perMessageDeflate, false);
  assert.equal(options.followRedirects, false);
  assert.equal(options.maxPayload, 256 * 1024);
});

test('PTY 环境不会继承 Relay/Agent 凭据', () => {
  const env = buildTerminalEnv({
    PATH: '/usr/bin',
    HOME: '/home/original',
    CLOUD_PROFILE: 'production',
    XDG_CONFIG_HOME: '/home/original/.config',
    CW_AGENT_TOKEN: 'secret',
    CW_CONFIG_PATH: '/secret/config',
    CLAUDE_WEB_TOKEN: 'legacy-secret',
    REMOTE_TERMINAL_AGENT_TOKEN: 'other-secret',
  }, 'safe-session');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/original');
  assert.equal(env.CLOUD_PROFILE, 'production');
  assert.equal(env.XDG_CONFIG_HOME, '/home/original/.config');
  assert.equal(env.CW_AGENT_TOKEN, undefined);
  assert.equal(env.CW_CONFIG_PATH, undefined);
  assert.equal(env.CLAUDE_WEB_TOKEN, undefined);
  assert.equal(env.REMOTE_TERMINAL_SESSION_ID, 'safe-session');
  assert(path.isAbsolute(resolveShell({ SHELL: 'relative-shell' }, 'linux')));
});

test('Agent 严格绑定既有用户、UID、HOME 和启动目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-terminal-identity-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(workspace, { mode: 0o700 });
  const config = {
    requiredUser: 'original-user',
    requiredUid: 1234,
    requiredHome: home,
    requiredWorkingDirectory: workspace,
  };
  const runtime = {
    userInfo: { username: 'original-user', uid: 1234, homedir: home },
    uid: 1234,
    env: { HOME: home },
    cwd: workspace,
    platform: 'linux',
  };
  try {
    const identity = verifyRuntimeIdentity(config, runtime);
    assert.equal(identity.username, 'original-user');
    assert.equal(identity.workingDirectory, fs.realpathSync(workspace));
    assert.throws(() => verifyRuntimeIdentity(config, { ...runtime, uid: 4321 }), /uid 1234/);
    assert.throws(() => verifyRuntimeIdentity(config, {
      ...runtime,
      userInfo: { ...runtime.userInfo, username: 'silently-created-user' },
    }), /original-user/);
    assert.throws(() => verifyRuntimeIdentity(config, { ...runtime, env: { HOME: workspace } }), /HOME/);
    assert.throws(() => verifyRuntimeIdentity(config, { ...runtime, cwd: home }), /must start/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('配置读取拒绝符号链接，生产模式拒绝宽权限', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-terminal-config-'));
  const configPath = path.join(dir, 'config.json');
  const linkPath = path.join(dir, 'config-link.json');
  fs.writeFileSync(configPath, '{"ok":true}', { mode: 0o600 });
  fs.symlinkSync(configPath, linkPath);
  assert.equal(loadConfig(configPath).ok, true);
  assert.throws(() => loadConfig(linkPath), /regular file/);
  if (process.platform !== 'win32') {
    fs.chmodSync(configPath, 0o644);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { assert.throws(() => loadConfig(configPath), /permissions/); } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('断线输出按会话保留并限制 UTF-8 字节数', () => {
  const backlog = new OutputBacklog(12);
  backlog.append('a', '前缀-');
  backlog.append('a', '中文-TAIL');
  assert(Buffer.byteLength(backlog.get('a'), 'utf8') <= 12);
  assert(backlog.get('a').endsWith('TAIL'));
  assert(backlog.hasTruncatedOutput());
  backlog.clear();
  assert.equal(backlog.get('a'), '');
});

test('恢复输出始终按 UTF-8 边界拆分', () => {
  const chunks = splitUtf8('中'.repeat(100) + 'TAIL', 64);
  assert(chunks.length > 1);
  assert(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 64));
  assert.equal(chunks.join(''), '中'.repeat(100) + 'TAIL');
});

test('旧聊天子进程、原始按键审计和工作目录创建代码已移除', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'agent', 'index.js'), 'utf8');
  const sessionSource = fs.readFileSync(path.join(__dirname, '..', 'agent', 'session-manager.js'), 'utf8');
  const terminalSource = fs.readFileSync(path.join(__dirname, '..', 'agent', 'terminal.js'), 'utf8');
  assert(!source.includes("require('child_process')"));
  assert(!source.includes("type: 'chat'"));
  assert(!sessionSource.includes('mkdirSync'));
  assert(!terminalSource.includes('mkdirSync'));
  assert(!fs.existsSync(path.join(__dirname, '..', 'agent', 'audit-log.js')));
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} Agent 加固测试通过`);
if (passed !== results.length) process.exit(1);
