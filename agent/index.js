/**
 * ═══════════════════════════════════════════════════════════════
 * Remote Terminal — 本地 Agent
 *
 * 职责：
 *   - 连接云服务器（带自动重连）
 *   - 管理多个交互式终端会话（创建 / 输入 / resize / 删除）
 *   - 每个会话在共享的工作区根目录下启动
 * ═══════════════════════════════════════════════════════════════
 */

const path = require('path');
const WebSocket = require('ws');
const sessionManager = require('./session-manager');
const { OutputBacklog, splitUtf8 } = require('./output-backlog');
const { TerminalState } = require('./terminal-state');
const { buildServerUrl, createConnectionOptions, displayUrl } = require('./connection-options');
const { verifyRuntimeIdentity } = require('./runtime-identity');
const { loadConfig } = require('../lib/load-config');

// ─── 配置 ───────────────────────────────────────────────────────
const CONFIG_PATH = process.env.CW_CONFIG_PATH || path.join(__dirname, 'config.json');
let config;
try {
  config = loadConfig(CONFIG_PATH, { label: 'Agent configuration' });
} catch (err) {
  console.error('❌ Agent 配置加载失败，请根据 agent/config.json.example 创建受限权限配置。');
  console.error(err.message);
  process.exit(1);
}

const token = process.env.CW_AGENT_TOKEN || config.agentToken;

const MAX_SESSION_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 120;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_COLS = 300;
const MAX_ROWS = 100;

function failConfig(message) {
  console.error(`❌ 配置错误: ${message}`);
  process.exit(1);
}

if (typeof token !== 'string' || token.length < 32 || token.length > 512 ||
    Buffer.byteLength(token, 'utf8') > 1024 || /change-me|deprecated|your-token|shared-secret/i.test(token)) {
  failConfig('agentToken 必须为 32-512 个字符，且不能使用示例值');
}

let SERVER_URL;
let WS_OPTIONS;
let proxyUrl;
try {
  SERVER_URL = buildServerUrl(config);
  ({ options: WS_OPTIONS, proxyUrl } = createConnectionOptions(SERVER_URL, config));
} catch (err) {
  failConfig(err.message);
}

let runtimeIdentity;
try {
  runtimeIdentity = verifyRuntimeIdentity(config);
} catch (err) {
  failConfig(`运行身份不符合配置: ${err.message}`);
}
const ROOT = sessionManager.setWorkspaceRoot(runtimeIdentity.workingDirectory);
console.log(
  `👤 运行身份已锁定: user=${runtimeIdentity.username}` +
  `${runtimeIdentity.uid === null ? '' : ` uid=${runtimeIdentity.uid}`}` +
  ` home=${runtimeIdentity.home} cwd=${ROOT}`
);

function positiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

const MAX_SESSIONS = positiveInt(process.env.CW_MAX_SESSIONS || config.maxSessions, 12, 1, 100);
const OFFLINE_OUTPUT_BYTES = positiveInt(
  process.env.CW_OFFLINE_OUTPUT_BYTES || config.offlineOutputBytes,
  256 * 1024,
  16 * 1024,
  4 * 1024 * 1024
);
const offlineOutput = new OutputBacklog(OFFLINE_OUTPUT_BYTES);
const terminalStates = new Map();
const closedTerminalIds = new Set();
const TERMINAL_STATE_BYTES = Math.min(OFFLINE_OUTPUT_BYTES, 768 * 1024);
let terminalStateBytes = TERMINAL_STATE_BYTES;

function ensureTerminalState(sessionId) {
  let state = terminalStates.get(sessionId);
  if (!state) {
    state = new TerminalState({
      scrollbackRows: 5000,
      maxSnapshotBytes: terminalStateBytes,
    });
    terminalStates.set(sessionId, state);
  }
  return state;
}

function dropTerminalState(sessionId) {
  const state = terminalStates.get(sessionId);
  if (!state) return;
  terminalStates.delete(sessionId);
  state.dispose();
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function validSessionId(sessionId) {
  return typeof sessionId === 'string' &&
    sessionId.length <= MAX_SESSION_ID_LENGTH &&
    /^[A-Za-z0-9._:-]+$/.test(sessionId);
}

function sanitizeTitle(title) {
  const value = typeof title === 'string'
    ? title.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  return (value || '新会话').slice(0, MAX_TITLE_LENGTH);
}

// ─── 状态 ───────────────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let authenticated = false;
let relaySynchronizing = false;
let shuttingDown = false;
let lastPongAt = 0;        // 最近一次收到服务器 pong 的时间戳
const MAX_RECONNECT_DELAY = 30000;
const MAX_WS_BUFFERED_BYTES = positiveInt(
  process.env.CW_MAX_WS_BUFFERED_BYTES || config.maxWsBufferedBytes,
  2 * 1024 * 1024,
  64 * 1024,
  32 * 1024 * 1024
);
const HEARTBEAT_MS = positiveInt(
  process.env.CW_HEARTBEAT_MS || config.heartbeatMs,
  25000,
  5000,
  120000
);
const PONG_TIMEOUT_MS = Math.max(
  HEARTBEAT_MS * 2,
  positiveInt(process.env.CW_PONG_TIMEOUT_MS || config.pongTimeoutMs, 70000, 15000, 300000)
);
const AUTH_TIMEOUT_MS = positiveInt(
  process.env.CW_AUTH_TIMEOUT_MS || config.authTimeoutMs,
  15000,
  3000,
  120000
);

// ─── WebSocket 连接 ─────────────────────────────────────────────
function connect() {
  if (shuttingDown) return;
  if (ws && ws.readyState !== WebSocket.CLOSED) return;
  console.log(`🔗 正在连接服务器: ${displayUrl(SERVER_URL)}`);
  let socket;
  let authTimer = null;
  try {
    socket = new WebSocket(SERVER_URL, WS_OPTIONS);
  } catch (err) {
    console.error('⚠  创建 WebSocket 连接失败:', err.message);
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.on('open', () => {
    if (ws !== socket || shuttingDown) {
      try { socket.close(1000, 'Connection no longer needed'); } catch { /* ignore */ }
      return;
    }
    console.log('✅ 已连接到服务器');
    lastPongAt = Date.now();
    // 交互式终端以小数据包为主，禁用 Nagle，避免逐键回显等待合包。
    try {
      if (socket._socket) {
        socket._socket.setNoDelay(true);
        socket._socket.setKeepAlive(true, 15000);
      }
    } catch { /* ignore */ }
    try {
      socket.send(JSON.stringify({ type: 'auth', token, role: 'agent' }));
    } catch (err) {
      console.warn('⚠  发送 Agent 鉴权消息失败:', err.message);
      try { socket.terminate(); } catch { /* ignore */ }
      return;
    }
    authTimer = setTimeout(() => {
      if (ws === socket && !authenticated) {
        console.warn(`⚠  ${AUTH_TIMEOUT_MS / 1000}s 内未完成 Agent 鉴权，主动重连`);
        try { socket.terminate(); } catch { /* ignore */ }
      }
    }, AUTH_TIMEOUT_MS);
    authTimer.unref();
  });

  // 协议层 pong（服务器若用 ws.ping() 探测，这里自动回应并记录存活）
  socket.on('pong', () => { lastPongAt = Date.now(); });

  socket.on('message', (raw, isBinary) => {
    if (ws !== socket) return;
    if (isBinary) {
      console.warn('⚠  Relay 发送了不支持的二进制消息，主动重连');
      try { socket.terminate(); } catch { /* ignore */ }
      return;
    }
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      console.warn('⚠  收到无效 JSON');
      return;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      console.warn('⚠  收到的消息不是 JSON 对象');
      return;
    }
    if (!authenticated && data.type !== 'auth_ok') {
      console.warn('⚠  Relay 在鉴权完成前发送了控制消息，主动重连');
      try { socket.terminate(); } catch { /* ignore */ }
      return;
    }
    handleMessage(data, socket);
    if (authenticated && authTimer) {
      clearTimeout(authTimer);
      authTimer = null;
    }
  });

  socket.on('close', (code) => {
    if (authTimer) clearTimeout(authTimer);
    console.log(`🔌 与服务器断开 (code: ${code})`);
    if (ws !== socket) return;
    authenticated = false;
    ws = null;
    relaySynchronizing = false;
    // code 4000 = 已有健康 Agent 占用该设备。Server 会保留先到者，当前
    // 进程低频重试；这样既不会互踢，也不会永远停在 systemd 看不出的空闲态。
    if (code === 4000) {
      console.warn('⚠  已有另一个健康 Agent 在线（code 4000），30s 后重新检查。');
      if (!shuttingDown) scheduleReconnect(30000);
      return;
    }
    if (!shuttingDown) scheduleReconnect();
  });

  socket.on('error', (err) => {
    console.error('⚠  WebSocket 错误:', err.message);
  });
}

function scheduleReconnect(minDelay = 0) {
  if (reconnectTimer || shuttingDown) return;
  const baseDelay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  const delay = Math.max(minDelay, Math.round(baseDelay * (0.8 + Math.random() * 0.4)));
  reconnectAttempts++;
  console.log(`🔄 ${delay / 1000}s 后重连 (第 ${reconnectAttempts} 次)...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function send(data) {
  if (authenticated && ws && ws.readyState === WebSocket.OPEN) {
    if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      console.warn(`⚠  WebSocket 发送积压超过 ${MAX_WS_BUFFERED_BYTES} 字节，主动重连`);
      try { ws.terminate(); } catch { /* ignore */ }
      return false;
    }
    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch (err) {
      console.warn('⚠  WebSocket 发送失败:', err.message);
    }
  }
  return false;
}

/** 向服务器上报完整会话列表（自动去重 + 过滤异常状态） */
function reportSessions() {
  const sessions = sessionManager.listSessions();
  send({ type: 'sessions', sessions });
}

// ─── 终端输出批处理 ─────────────────────────────────────────────
// 逐键回显要立即发送；连续刷屏则使用很短的合并窗口，避免大量 WebSocket
// 小包放大 Relay 和客户端负载。两者不能共用一个固定延迟。
const outBuffers = new Map();
const interactiveOutputPending = new Set();
const OUT_FLUSH_MS = positiveInt(
  process.env.CW_OUTPUT_FLUSH_MS ?? config.outputFlushMs,
  4,
  0,
  50
);
const OUT_MAX_BYTES = 64 * 1024;
const OUT_BULK_CHUNK_BYTES = 1024;
const OUT_BULK_WINDOW_MS = 10;
const OUT_BULK_WINDOW_BYTES = 2048;
const OUT_BULK_WINDOW_CHUNKS = 12;
const OUT_BULK_HOLD_MS = 50;

function scheduleOutputFlush(sessionId, buffer, delay) {
  if (buffer.timer && delay === buffer.scheduledDelay) return;
  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.scheduledDelay = delay;
  buffer.timer = setTimeout(() => flushOutput(sessionId), delay);
}

function queueOutput(sessionId, chunk) {
  if (closedTerminalIds.has(sessionId)) return;
  try {
    const appended = ensureTerminalState(sessionId).append(chunk);
    appended.completion.catch((err) => {
      console.error(`⚠  本地终端状态解析失败 (${sessionId}):`, err.message);
    });
  } catch (err) {
    console.error(`⚠  本地终端状态记录失败 (${sessionId}):`, err.message);
  }
  const chunkBytes = Buffer.byteLength(chunk);
  const now = Date.now();
  let b = outBuffers.get(sessionId);
  if (!b) {
    b = {
      data: '',
      bytes: 0,
      timer: null,
      scheduledDelay: 0,
      windowStartedAt: now,
      windowBytes: 0,
      windowChunks: 0,
      bulkUntil: 0,
    };
    outBuffers.set(sessionId, b);
  }
  if (now - b.windowStartedAt > OUT_BULK_WINDOW_MS) {
    b.windowStartedAt = now;
    b.windowBytes = 0;
    b.windowChunks = 0;
  }
  b.windowBytes += chunkBytes;
  b.windowChunks++;
  // 每次用户输入后的首段小输出优先立即回传；即使上一条命令正在刷屏，
  // 按键回显也不能被批处理窗口拖住。
  const interactiveOutput = interactiveOutputPending.delete(sessionId) && chunkBytes < OUT_BULK_CHUNK_BYTES;
  const bulkOutput = !interactiveOutput && (now < b.bulkUntil || chunkBytes >= OUT_BULK_CHUNK_BYTES ||
    b.windowBytes >= OUT_BULK_WINDOW_BYTES || b.windowChunks >= OUT_BULK_WINDOW_CHUNKS);
  if (bulkOutput) b.bulkUntil = now + OUT_BULK_HOLD_MS;

  b.data += chunk;
  b.bytes += chunkBytes;
  if (b.bytes >= OUT_MAX_BYTES) { flushOutput(sessionId); return; }
  scheduleOutputFlush(sessionId, b, bulkOutput ? OUT_FLUSH_MS : 0);
}

function flushOutput(sessionId) {
  const b = outBuffers.get(sessionId);
  if (!b) return;
  if (b.timer) clearTimeout(b.timer);
  b.timer = null;
  b.scheduledDelay = 0;
  if (b.data) {
    const data = b.data;
    b.data = '';
    b.bytes = 0;
    sendOutputData(sessionId, data, false);
  }
}

function sendOutputData(sessionId, data, recovered) {
  if (relaySynchronizing) {
    offlineOutput.append(sessionId, data);
    return true;
  }
  const chunks = splitUtf8(data, OUT_MAX_BYTES);
  for (let i = 0; i < chunks.length; i++) {
    if (!send({ type: 'terminal_output', sessionId, data: chunks[i], ...(recovered ? { recovered: true } : {}) })) {
      offlineOutput.append(sessionId, chunks.slice(i).join(''));
      return false;
    }
  }
  return true;
}

function dropOutputBuffer(sessionId) {
  const b = outBuffers.get(sessionId);
  if (b && b.timer) clearTimeout(b.timer);
  outBuffers.delete(sessionId);
  interactiveOutputPending.delete(sessionId);
  offlineOutput.drop(sessionId);
  dropTerminalState(sessionId);
}

function flushOfflineOutput() {
  if (relaySynchronizing) return;
  const entries = offlineOutput.drain();
  for (let i = 0; i < entries.length; i++) {
    const [sessionId, data] = entries[i];
    if (!sendOutputData(sessionId, data, true)) {
      for (let j = i + 1; j < entries.length; j++) offlineOutput.append(entries[j][0], entries[j][1]);
      break;
    }
  }
}

/**
 * Rebuild a freshly restarted relay from Agent-side emulator snapshots.
 * Snapshot boundaries are captured synchronously for every session; output
 * produced afterwards is held in offlineOutput and flushed only after all
 * snapshots have been accepted by the relay.
 */
async function synchronizeRelayState(socket) {
  try {
    while (ws === socket && authenticated && socket.readyState === WebSocket.OPEN) {
      const pending = [...terminalStates].map(([sessionId, state]) => ({
        sessionId,
        snapshot: state.snapshot(),
      }));
      // 快照边界之前的输出已包含在快照中；边界之后的输出由
      // relaySynchronizing 路径写入 offlineOutput。
      offlineOutput.clear();
      const snapshots = await Promise.all(pending.map(async (item) => ({
        sessionId: item.sessionId,
        snapshot: await item.snapshot,
      })));
      if (ws !== socket || !authenticated || socket.readyState !== WebSocket.OPEN) return;

      for (const item of snapshots) {
        const ok = send({
          type: 'terminal_state',
          sessionId: item.sessionId,
          data: item.snapshot.data,
          cols: item.snapshot.cols,
          rows: item.snapshot.rows,
          historyTruncated: item.snapshot.historyTruncated,
        });
        if (!ok) return;
      }
      if (offlineOutput.hasTruncatedOutput()) {
        // 同步窗口内仍在高速刷屏且增量缓冲已裁剪：循环取更靠后的完整
        // 状态，避免递归 Promise 链持续增长。
        continue;
      }
      relaySynchronizing = false;
      flushOfflineOutput();
      return;
    }
  } catch (err) {
    console.error('⚠  向中继同步终端状态失败:', err.message);
    try { socket.terminate(); } catch { /* ignore */ }
  }
}

// ─── 消息处理 ───────────────────────────────────────────────────
function handleMessage(data, socket) {
  switch (data.type) {
    case 'auth_ok':
      if (authenticated) {
        console.error('❌ Relay 重复发送了 Agent 鉴权响应');
        try { socket.terminate(); } catch { /* ignore */ }
        break;
      }
      if (data.role !== 'agent') {
        console.error('❌ Relay 返回了无效的 Agent 鉴权响应');
        try { socket.terminate(); } catch { /* ignore */ }
        break;
      }
      console.log('🤖 Agent 认证成功');
      authenticated = true;
      reconnectAttempts = 0;
      relaySynchronizing = true;
      {
        const relayStateLimit = positiveInt(
          data.maxTerminalStateBytes,
          TERMINAL_STATE_BYTES,
          16 * 1024,
          768 * 1024
        );
        terminalStateBytes = relayStateLimit;
        for (const [, state] of terminalStates) state.maxSnapshotBytes = relayStateLimit;
      }
      reportSessions();
      void synchronizeRelayState(socket);
      break;

    // ── 终端：创建 ────────────────────────────────────────────
    case 'terminal_create':
      onTerminalCreate(data);
      break;

    // ── 终端：输入 ────────────────────────────────────────────
    case 'terminal_input': {
      if (!validSessionId(data.sessionId) || typeof data.data !== 'string' || byteLength(data.data) > MAX_INPUT_BYTES) {
        send({ type: 'terminal_error', sessionId: data.sessionId, message: '无效的终端输入' });
        break;
      }
      const session = sessionManager.getSession(data.sessionId);
      if (session && session.status === 'running') {
        interactiveOutputPending.add(data.sessionId);
        if (!session.terminal.write(data.data)) {
          interactiveOutputPending.delete(data.sessionId);
          send({ type: 'terminal_error', sessionId: data.sessionId, message: '终端输入写入失败' });
        }
      } else {
        send({ type: 'terminal_error', sessionId: data.sessionId, message: '终端不存在或已退出，请重新创建会话' });
      }
      break;
    }

    // ── 终端：resize ─────────────────────────────────────────
    case 'terminal_resize': {
      if (!validSessionId(data.sessionId)) break;
      const session = sessionManager.getSession(data.sessionId);
      const cols = Math.max(2, Math.min(MAX_COLS, Number.parseInt(data.cols, 10) || 120));
      const rows = Math.max(2, Math.min(MAX_ROWS, Number.parseInt(data.rows, 10) || 30));
      if (session && session.status === 'running') {
        if (!session.terminal.resize(cols, rows)) {
          send({ type: 'terminal_error', sessionId: data.sessionId, message: '终端尺寸调整失败' });
        }
        const state = terminalStates.get(data.sessionId);
        if (state) state.resize(cols, rows).catch((err) => {
          console.warn(`⚠  本地终端状态 resize 失败 (${data.sessionId}):`, err.message);
        });
      }
      break;
    }

    // ── 终端：删除 ────────────────────────────────────────────
    case 'terminal_delete': {
      if (!validSessionId(data.sessionId)) break;
      closedTerminalIds.add(data.sessionId);
      const closedSessionId = data.sessionId;
      const forgetClosedTimer = setTimeout(() => closedTerminalIds.delete(closedSessionId), 10000);
      forgetClosedTimer.unref();
      dropOutputBuffer(data.sessionId);
      sessionManager.destroySession(data.sessionId);
      send({ type: 'terminal_closed', sessionId: data.sessionId });
      reportSessions();
      break;
    }

    // ── 请求会话列表 ──────────────────────────────────────────
    case 'terminal_list':
      reportSessions();
      break;

    case 'pong':
      lastPongAt = Date.now();
      break;

    default:
      console.log('📩 未知消息类型:', sanitizeTitle(data.type));
  }
}

function onTerminalCreate(data) {
  const { sessionId } = data;
  const title = sanitizeTitle(data.title);
  if (!validSessionId(sessionId)) {
    send({ type: 'terminal_error', sessionId, message: '无效的 sessionId' });
    return;
  }
  closedTerminalIds.delete(sessionId);

  // 已存在则直接回报，不重复创建
  if (sessionManager.getSession(sessionId)) {
    const s = sessionManager.getSession(sessionId);
    ensureTerminalState(sessionId);
    send({ type: 'terminal_created', sessionId, title: s.title, cwd: s.cwd, pid: s.pid, status: s.status });
    reportSessions();
    return;
  }

  if (sessionManager.listSessions().length >= MAX_SESSIONS) {
    send({
      type: 'terminal_error',
      sessionId,
      message: `会话数量已达上限 (${MAX_SESSIONS})，请先删除不再使用的会话`,
    });
    return;
  }

  try {
    const session = sessionManager.createSession(sessionId, title, {
      onData: (sid, chunk) => queueOutput(sid, chunk),
      onExit: (sid, evt) => {
        flushOutput(sid); // 先把残留输出发完
        send({ type: 'terminal_exit', sessionId: sid, exitCode: evt.exitCode, signal: evt.signal });
        reportSessions();
      },
    });
    send({
      type: 'terminal_created',
      sessionId,
      title: session.title,
      cwd: session.cwd,
      pid: session.pid,
      status: session.status,
    });
    reportSessions();
  } catch (err) {
    console.error('❌ 创建终端失败:', err.message);
    send({ type: 'terminal_error', sessionId, message: `创建终端失败: ${err.message}` });
  }
}

// ─── 心跳 + 死连接检测 ──────────────────────────────────────────
// half-open（半开）连接：TCP 一侧已死但本端 ws 不触发 close，导致永不重连。
// 这里主动发心跳并校验 pong：若超过 PONG_TIMEOUT_MS 没收到任何 pong，
// 判定连接已死，主动 terminate() 触发 close → 走正常重连流程（PTY 会话因进程
// 存活而保留，重连后自动重新上报，无需重建）。
const heartbeatTimer = setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // 死连接判定：长时间没有任何 pong
  if (lastPongAt && Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
    console.warn(`⚠  超过 ${PONG_TIMEOUT_MS / 1000}s 未收到服务器响应，判定连接已死，强制重连`);
    try { ws.terminate(); } catch { /* ignore */ }  // 立即触发 close → scheduleReconnect
    return;
  }

  // 同时发应用层 ping 和协议层 ping（任一条回应都会刷新 lastPongAt）
  try {
    ws.send(JSON.stringify({ type: 'ping' }));
    ws.ping();
  } catch { /* 发送失败说明链路有问题，下个周期会被超时逻辑兜底 */ }
}, HEARTBEAT_MS);

// ─── 启动 ───────────────────────────────────────────────────────
console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║       Remote Terminal Agent 🤖           ║');
console.log(`║  Server : ${displayUrl(SERVER_URL).slice(0, 32).padEnd(32)}║`);
console.log('║  Mode   : 交互式终端 (node-pty)           ║');
console.log(`║  Root   : ${ROOT.slice(0, 32).padEnd(32)}║`);
console.log(`║  会话上限: ${String(MAX_SESSIONS).padEnd(29)}║`);
if (proxyUrl) console.log(`║  代理   : ${String(proxyUrl.protocol + '//' + proxyUrl.host).slice(0, 32).padEnd(32)}║`);
console.log('╚══════════════════════════════════════════╝');
console.log('');

connect();

// ─── 优雅关闭 ───────────────────────────────────────────────────
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  authenticated = false;
  console.log('\n🛑 正在关闭 Agent...');
  clearInterval(heartbeatTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  for (const [, buffer] of outBuffers) if (buffer.timer) clearTimeout(buffer.timer);
  outBuffers.clear();
  offlineOutput.clear();
  sessionManager.destroyAllSessions();
  for (const [, state] of terminalStates) state.dispose();
  terminalStates.clear();
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    try { ws.close(1000, 'Agent shutting down'); } catch { /* ignore */ }
  }
  setTimeout(() => {
    try { ws?.terminate(); } catch { /* ignore */ }
    process.exit(0);
  }, 4000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
