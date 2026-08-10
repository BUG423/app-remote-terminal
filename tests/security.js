'use strict';

const assert = require('node:assert');
const WebSocket = require('./ws-client');

const TARGET = process.env.TARGET || 'ws://127.0.0.1:3002';
const browserToken = process.env.REMOTE_TERMINAL_BROWSER_TOKEN;
const agentToken = process.env.REMOTE_TERMINAL_AGENT_TOKEN;
if (!browserToken || !agentToken) {
  console.error('❌ REMOTE_TERMINAL_BROWSER_TOKEN and REMOTE_TERMINAL_AGENT_TOKEN are required');
  process.exit(1);
}

const sockets = new Set();
const results = [];

function check(name, condition, detail = '') {
  results.push(!!condition);
  console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function openSocket(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(TARGET);
    sockets.add(ws);
    const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function nextMessage(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('message timeout'));
    }, timeoutMs);
    function onMessage(raw, isBinary) {
      clearTimeout(timer);
      ws.off('message', onMessage);
      if (isBinary) reject(new Error('unexpected binary response'));
      else {
        try { resolve(JSON.parse(raw.toString())); } catch (err) { reject(err); }
      }
    }
    ws.on('message', onMessage);
  });
}

function waitForClose(ws, timeoutMs = 5000) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function authenticate(token, role = 'browser') {
  const ws = await openSocket();
  const messagePromise = nextMessage(ws);
  ws.send(JSON.stringify({ type: 'auth', token, role, protocolVersion: 2 }));
  return { ws, message: await messagePromise };
}

async function sendAndReceive(ws, value, options) {
  const messagePromise = nextMessage(ws);
  ws.send(value, options);
  return messagePromise;
}

(async () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Relay / Agent 真实安全边界测试         ║');
  console.log('╚══════════════════════════════════════════╝');

  const valid = await authenticate(browserToken);
  check('有效浏览器 Token 只能以 browser 角色登录',
    valid.message.type === 'auth_ok' && valid.message.role === 'browser');

  const wrongRole = await authenticate(browserToken, 'agent');
  check('浏览器 Token 不能伪装 Agent', wrongRole.message.message === 'Invalid token');
  wrongRole.ws.close();

  const agentAsBrowser = await authenticate(agentToken, 'browser');
  check('Agent Token 不能登录客户端', agentAsBrowser.message.message === 'Invalid token');
  agentAsBrowser.ws.close();

  const unauthenticated = await openSocket();
  const unauthenticatedReply = await sendAndReceive(
    unauthenticated,
    JSON.stringify({ type: 'terminal_list' }),
  );
  check('未鉴权控制消息被拒绝', unauthenticatedReply.message === 'Not authenticated');
  unauthenticated.close();

  const malformed = await openSocket();
  const nullReply = await sendAndReceive(malformed, 'null');
  const arrayReply = await sendAndReceive(malformed, '[]');
  const closeAfterMalformed = waitForClose(malformed);
  const scalarReply = await sendAndReceive(malformed, '"scalar"');
  await closeAfterMalformed;
  check('JSON null、数组和标量被拒绝且不会使 Relay 崩溃',
    [nullReply, arrayReply, scalarReply].every((item) => item.message === 'Message must be a JSON object'));

  const binary = await openSocket();
  const binaryOne = await sendAndReceive(binary, Buffer.from('{}'), { binary: true });
  const binaryTwo = await sendAndReceive(binary, Buffer.from('{}'), { binary: true });
  const closeAfterBinary = waitForClose(binary);
  const binaryThree = await sendAndReceive(binary, Buffer.from('{}'), { binary: true });
  await closeAfterBinary;
  check('连续二进制协议消息被拒绝并关闭连接',
    [binaryOne, binaryTwo, binaryThree].every((item) => item.message === 'Binary messages are not supported'));

  const survived = await authenticate(browserToken);
  check('异常协议测试后 Relay 仍可正常鉴权', survived.message.type === 'auth_ok');

  const unknownReplyPromise = nextMessage(valid.ws);
  valid.ws.send(JSON.stringify({ type: '__UNKNOWN__', sessionId: 'safe-session' }));
  const unknownReply = await unknownReplyPromise;
  check('未知客户端消息返回受控错误且连接保持',
    unknownReply.type === 'terminal_error' && unknownReply.message === 'Unknown message type' &&
    valid.ws.readyState === WebSocket.OPEN);

  const invalidIdReplyPromise = nextMessage(valid.ws);
  valid.ws.send(JSON.stringify({ type: 'terminal_create', sessionId: '../escape', title: 'bad' }));
  const invalidIdReply = await invalidIdReplyPromise;
  check('路径型 sessionId 被拒绝', invalidIdReply.message === 'Invalid sessionId');

  const oversizedReplyPromise = nextMessage(valid.ws);
  valid.ws.send(JSON.stringify({
    type: 'terminal_input',
    sessionId: 'safe-session',
    data: 'x'.repeat(64 * 1024 + 1),
  }));
  const oversizedReply = await oversizedReplyPromise;
  check('超过 64 KiB 的单条终端输入被拒绝', oversizedReply.message === 'Invalid terminal input');

  const authTimeoutSocket = await openSocket();
  const authTimeoutMessage = await nextMessage(authTimeoutSocket, 12000);
  await waitForClose(authTimeoutSocket);
  check('未鉴权连接在 10 秒后关闭', authTimeoutMessage.message === 'Authentication timeout');

  survived.ws.close();
  // 最近一次成功鉴权已清空此前失败计数。随后故意触发本机地址限流；这项
  // 放在最后，避免封禁影响其他协议用例。
  const failures = [];
  for (let index = 0; index < 9; index++) {
    const fake = `invalid-${String(index).padStart(2, '0')}-${'x'.repeat(32)}`;
    const attempt = await authenticate(fake);
    failures.push(attempt.message);
    attempt.ws.close();
  }
  check('回环地址同样受暴力破解限流保护',
    failures.slice(0, 8).every((item) => item.message === 'Invalid token') &&
    /频繁|retry/i.test(failures[8].message || ''),
    failures[8].message || 'missing rate-limit response');

  valid.ws.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} 安全测试通过`);
  if (passed !== results.length) process.exitCode = 1;
})().catch((err) => {
  console.error(`  ❌ 安全测试异常: ${err.stack || err.message}`);
  process.exitCode = 1;
}).finally(() => {
  for (const ws of sockets) {
    try { ws.close(); } catch {}
  }
});
