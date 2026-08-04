/**
 * Server WebSocket protocol tests.
 *
 * These use the real server process and a fake Agent, so they cover routing,
 * auth, validation, and session list behavior without requiring node-pty.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('./ws-client');
const { TerminalState } = require('../server/terminal-state');

const browserToken = `browser-${'b'.repeat(40)}`;
const agentToken = `agent-${'a'.repeat(40)}`;
const port = 32000 + Math.floor(Math.random() * 1000);
const configPath = path.join(os.tmpdir(), `remote-terminal-test-${process.pid}.json`);
const target = `ws://127.0.0.1:${port}`;

fs.writeFileSync(configPath, JSON.stringify({
  port,
  bindHost: '127.0.0.1',
  devices: {
    'test-agent': { name: 'test-agent', browserToken, agentToken },
  },
  serverHost: '127.0.0.1',
  serverPort: port,
  useTLS: false,
  maxSessions: 3,
  maxBrowsersPerToken: 2,
  workspaceRoot: path.join(os.tmpdir(), `remote-terminal-ws-${process.pid}`),
}, null, 2));

let serverProc;
const results = [];

function check(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail });
  console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForHealth(timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    function once() {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(500, () => {
        req.destroy();
        retry();
      });
    }
    function retry() {
      if (Date.now() - started > timeoutMs) reject(new Error('server did not start'));
      else setTimeout(once, 100);
    }
    once();
  });
}

function httpGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${pathname}`, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
  });
}

function connect(role, authToken = role === 'agent' ? agentToken : browserToken, protocolVersion = 2) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    const timer = setTimeout(() => reject(new Error(`${role} auth timeout`)), 5000);
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'auth',
      token: authToken,
      role,
      ...(role === 'browser' && protocolVersion >= 2 ? { protocolVersion } : {}),
    })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth_ok' || msg.type === 'error') {
        clearTimeout(timer);
        resolve({ ws, msg });
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function nextMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('message timeout'));
    }, timeoutMs);
    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    }
    ws.on('message', onMessage);
  });
}

function noMatchingMessage(ws, predicate, waitMs = 150) {
  return new Promise((resolve) => {
    let matched = false;
    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) matched = true;
    }
    ws.on('message', onMessage);
    setTimeout(() => {
      ws.off('message', onMessage);
      resolve(!matched);
    }, waitMs);
  });
}

(async () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Server WebSocket 协议集成测试          ║');
  console.log('╚══════════════════════════════════════════╝');

  serverProc = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, CW_CONFIG_PATH: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', (d) => process.env.DEBUG_TESTS && process.stdout.write(d));
  serverProc.stderr.on('data', (d) => process.env.DEBUG_TESTS && process.stderr.write(d));

  await waitForHealth();

  const indexPage = await httpGet('/');
  check('页面启用 CSP 且隐藏 Express 标识',
    indexPage.headers['content-security-policy']?.includes("default-src 'self'") &&
    !indexPage.headers['x-powered-by']);
  check('页面不依赖公共 CDN',
    indexPage.body.includes('/vendor/xterm.js') && !indexPage.body.includes('cdn.jsdelivr.net'));
  const xtermAsset = await httpGet('/vendor/xterm.js');
  const fitAsset = await httpGet('/vendor/addon-fit.js');
  const unicodeAsset = await httpGet('/vendor/addon-unicode11.js');
  check('xterm、FitAddon 与 Unicode11Addon 由本机 Server 提供',
    xtermAsset.status === 200 && xtermAsset.body.includes('Terminal') &&
    fitAsset.status === 200 && fitAsset.body.includes('FitAddon') &&
    unicodeAsset.status === 200 && unicodeAsset.body.includes('Unicode11Addon'));

  const invalidRole = await connect('__bad_role__');
  check('无效 role 被拒绝', invalidRole.msg.type === 'error' && invalidRole.msg.message === 'Invalid role');
  invalidRole.ws.close();

  const browserCannotBeAgent = await connect('agent', browserToken);
  check('浏览器凭据不能伪装 Agent', browserCannotBeAgent.msg.message === 'Invalid token');
  browserCannotBeAgent.ws.close();
  const agentCannotBeBrowser = await connect('browser', agentToken);
  check('Agent 凭据不能登录浏览器', agentCannotBeBrowser.msg.message === 'Invalid token');
  agentCannotBeBrowser.ws.close();

  const agent = await connect('agent');
  check('假 Agent 鉴权成功', agent.msg.type === 'auth_ok' && agent.msg.role === 'agent');

  const duplicateAgent = await connect('agent');
  check('重复 Agent 被拒绝且不会踢掉现有健康连接',
    duplicateAgent.msg.type === 'error' && duplicateAgent.msg.message === 'Agent already connected');
  duplicateAgent.ws.close();

  const browser = await connect('browser');
  check('浏览器鉴权成功并协商到序列化终端协议',
    browser.msg.type === 'auth_ok' && browser.msg.role === 'browser' && browser.msg.protocolVersion === 2);

  const sessions = [
    { id: 'same-1', title: 'Same', cwd: '/tmp/ws', status: 'running', pid: 1 },
    { id: 'same-2', title: 'Same', cwd: '/tmp/ws', status: 'running', pid: 2 },
    { id: 'bad-1', title: 'Recovered', cwd: '/tmp/ws', status: 'recovered', pid: 0 },
  ];
  agent.ws.send(JSON.stringify({ type: 'sessions', sessions }));
  const updated = await nextMessage(browser.ws, (m) => m.type === 'sessions');
  check('同 title+cwd 的不同 running 会话全部保留',
    updated.sessions.length === 2 &&
    updated.sessions.some((s) => s.id === 'same-1') &&
    updated.sessions.some((s) => s.id === 'same-2'));
  check('recovered 会话仍被过滤', !updated.sessions.some((s) => s.id === 'bad-1'));

  browser.ws.send(JSON.stringify({ type: 'terminal_create', sessionId: 'bad\u0000id', title: 'x' }));
  const invalidSession = await nextMessage(browser.ws, (m) => m.type === 'terminal_error');
  check('非法 sessionId 被拒绝', invalidSession.message === 'Invalid sessionId');

  const longTitle = 'A'.repeat(1000);
  const forwarded = nextMessage(agent.ws, (m) => m.type === 'terminal_create');
  browser.ws.send(JSON.stringify({ type: 'terminal_create', sessionId: 'valid-id', title: longTitle }));
  const createMsg = await forwarded;
  check('超长标题被截断后转发', createMsg.title.length === 120);

  const outputRejected = nextMessage(agent.ws, (m) => m.type === 'error' && m.message === 'Invalid terminal output');
  agent.ws.send(JSON.stringify({ type: 'terminal_output', sessionId: 'same-1', data: 'x'.repeat(129 * 1024) }));
  check('Agent 超大输出被拒绝', !!(await outputRejected));

  const initialSnapshotPromise = nextMessage(browser.ws, (m) => m.type === 'terminal_snapshot' && m.sessionId === 'same-1');
  const initialAttachedPromise = nextMessage(browser.ws, (m) => m.type === 'terminal_attached' && m.sessionId === 'same-1');
  browser.ws.send(JSON.stringify({ type: 'terminal_attach', sessionId: 'same-1' }));
  const initialSnapshot = await initialSnapshotPromise;
  const initialAttached = await initialAttachedPromise;
  check('attach 先返回带尺寸和精确序号的完整快照',
    initialSnapshot.seq === 0 && initialAttached.seq === 0 &&
    initialSnapshot.cols >= 2 && initialSnapshot.rows >= 2);

  const validOutput = nextMessage(browser.ws, (m) => m.type === 'terminal_output' && m.sessionId === 'same-1');
  agent.ws.send(JSON.stringify({ type: 'terminal_output', sessionId: 'same-1', data: 'VALID_OUTPUT' }));
  const validOutputMessage = await validOutput;
  check('订阅后的合法 Agent 输出携带连续序号',
    validOutputMessage.data === 'VALID_OUTPUT' && validOutputMessage.seq === 1);

  browser.ws.send(JSON.stringify({ type: 'terminal_detach', sessionId: 'same-1' }));
  await wait(50);
  const hiddenNotForwarded = noMatchingMessage(
    browser.ws,
    (m) => m.type === 'terminal_output' && m.data === '-隐藏期间中文-',
    200
  );
  agent.ws.send(JSON.stringify({
    type: 'terminal_output',
    sessionId: 'same-1',
    data: '-隐藏期间中文-',
  }));
  check('detach 后隐藏会话不再向浏览器推送输出', await hiddenNotForwarded);

  const restoredSnapshotPromise = nextMessage(browser.ws, (m) => m.type === 'terminal_snapshot' && m.sessionId === 'same-1');
  const restoredAttachedPromise = nextMessage(browser.ws, (m) => m.type === 'terminal_attached' && m.sessionId === 'same-1');
  browser.ws.send(JSON.stringify({ type: 'terminal_attach', sessionId: 'same-1' }));
  const restoredSnapshot = await restoredSnapshotPromise;
  const restoredAttached = await restoredAttachedPromise;
  check('重新 attach 可用完整状态补回隐藏期间输出且序号衔接',
    restoredSnapshot.seq === 2 && restoredAttached.seq === 2 &&
    restoredSnapshot.data.includes('VALID_OUTPUT') && restoredSnapshot.data.includes('隐藏期间中文'));

  const liveAfterRestorePromise = nextMessage(browser.ws, (m) => m.type === 'terminal_output' && m.sessionId === 'same-1');
  agent.ws.send(JSON.stringify({ type: 'terminal_output', sessionId: 'same-1', data: '-LIVE-3' }));
  const liveAfterRestore = await liveAfterRestorePromise;
  check('快照后的实时输出从下一序号继续', liveAfterRestore.seq === 3 && liveAfterRestore.data === '-LIVE-3');

  const resyncSnapshotPromise = nextMessage(browser.ws, (m) => m.type === 'terminal_snapshot' && m.sessionId === 'same-1');
  browser.ws.send(JSON.stringify({ type: 'terminal_resync', sessionId: 'same-1' }));
  const resyncSnapshot = await resyncSnapshotPromise;
  check('浏览器可在发现序号断档后主动请求安全重同步', resyncSnapshot.seq === 3);

  const authoritativeState = new TerminalState({ cols: 55, rows: 12 });
  await authoritativeState.append('\x1b[2J\x1b[HAGENT_RESTORED_中文\x1b[6;4HREADY').completion;
  const authoritativeSnapshot = await authoritativeState.snapshot();
  const agentRestorePromise = nextMessage(browser.ws, (m) =>
    m.type === 'terminal_snapshot' && m.sessionId === 'same-1' && m.seq > 3);
  agent.ws.send(JSON.stringify({
    type: 'terminal_state',
    sessionId: 'same-1',
    data: authoritativeSnapshot.data,
    cols: authoritativeSnapshot.cols,
    rows: authoritativeSnapshot.rows,
  }));
  const agentRestore = await agentRestorePromise;
  check('Agent 重连可用权威终端状态重建中继并刷新现有订阅',
    agentRestore.seq === 4 && agentRestore.cols === 55 && agentRestore.rows === 12 &&
    agentRestore.data.includes('AGENT_RESTORED_中文') && !agentRestore.data.includes('VALID_OUTPUT'));
  authoritativeState.dispose();

  const legacyBrowser = await connect('browser', browserToken, 1);
  const legacyReplayPromise = nextMessage(legacyBrowser.ws, (m) =>
    m.type === 'terminal_output' && m.sessionId === 'same-1' && m.replay === true);
  legacyBrowser.ws.send(JSON.stringify({ type: 'terminal_attach', sessionId: 'same-1' }));
  const legacyReplay = await legacyReplayPromise;
  check('滚动发布期间旧页面仍能收到兼容的完整回放',
    legacyReplay.data.includes('AGENT_RESTORED_中文') && legacyReplay.seq === 4);
  legacyBrowser.ws.close();
  await wait(50);

  const cappedSessions = [0, 1, 2, 3].map((i) => ({
    id: `cap-${i}`,
    title: `Cap ${i}`,
    cwd: '/tmp/ws',
    status: 'running',
    pid: i + 1,
  }));
  agent.ws.send(JSON.stringify({ type: 'sessions', sessions: cappedSessions }));
  const cappedUpdate = await nextMessage(browser.ws, (m) => m.type === 'sessions');
  check('Agent 会话列表受上限保护', cappedUpdate.sessions.length === 3);

  browser.ws.send(JSON.stringify({ type: 'terminal_create', sessionId: 'over-limit', title: 'Over' }));
  const overLimit = await nextMessage(browser.ws, (m) => m.type === 'terminal_error' && m.sessionId === 'over-limit');
  check('达到会话上限后拒绝继续创建', /上限/.test(overLimit.message));

  const browser2 = await connect('browser');
  check('上限内第二个浏览器可连接', browser2.msg.type === 'auth_ok');
  const browser3 = await connect('browser');
  check('超过每 Token 浏览器连接上限后被拒绝', browser3.msg.message === 'Too many browser connections');
  browser3.ws.close();

  const repeatedAuth = nextMessage(browser2.ws, (m) => m.type === 'error' && m.message === 'Already authenticated');
  browser2.ws.send(JSON.stringify({ type: 'auth', token: browserToken, role: 'agent' }));
  check('已鉴权连接不能再次鉴权切换角色', !!(await repeatedAuth));
  browser2.ws.close();

  agent.ws.close();
  browser.ws.close();
  await wait(100);

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${'='.repeat(50)}`);
  if (passed === results.length) {
    console.log(`🎉 全部 ${passed}/${results.length} 协议测试通过!`);
    process.exitCode = 0;
    return;
  }
  console.log(`❌ ${passed}/${results.length} 通过`);
  for (const r of results.filter((x) => !x.pass)) {
    console.log(`  ❌ ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  process.exitCode = 1;
})().catch((err) => {
  console.error('测试异常:', err.message);
  process.exitCode = 1;
}).finally(() => {
  try { fs.unlinkSync(configPath); } catch {}
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
});
