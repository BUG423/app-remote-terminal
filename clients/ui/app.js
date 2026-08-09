/* ═══════════════════════════════════════════════════════════════
   Remote Terminal — 通用客户端 UI
   连接中转、管理多会话，把每个会话渲染成一个 xterm 终端。
   ═══════════════════════════════════════════════════════════════ */

// ── 状态 ───────────────────────────────────────────────────────
const STATE = {
  ws: null,
  clientId: null,
  authenticated: false,
  agentOnline: false,
  agentName: '',          // 当前连接的 Agent 名称
  sessions: [],           // [{ id, title, cwd, pid, status, createdAt }]
  activeId: null,
  splitMode: false,       // 分屏模式：同时显示多个终端
};

// sessionId -> { term, fit, stream, container, subscribed, observer, lastActivity }
const terminals = new Map();

// 会话活动计时器：用于定期刷新侧栏活动指示器
let activityTimer = null;
// 活动阈值：3 秒内有输出视为"忙碌"，3~10 秒无输出视为"刚完成"
const ACTIVITY_BUSY_MS = 3000;
const ACTIVITY_DONE_MS = 10000;
// Agent 离线后延迟清理会话的定时器（给 Agent 重连留时间）
let agentOfflineTimer = null;
const AGENT_OFFLINE_CLEANUP_MS = 30000;
// Agent 离线防抖：短暂断连不更新 UI，避免闪烁
let agentOfflineDebounce = null;
const AGENT_OFFLINE_DEBOUNCE_MS = 3000;

function cancelAgentOfflineTimers() {
  if (agentOfflineDebounce) {
    clearTimeout(agentOfflineDebounce);
    agentOfflineDebounce = null;
  }
  if (agentOfflineTimer) {
    clearTimeout(agentOfflineTimer);
    agentOfflineTimer = null;
  }
}

// ── DOM ────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const loginScreen = $('login-screen');
const loginForm = $('login-form');
const tokenInput = $('token-input');
const loginBtn = $('login-btn');
const loginError = $('login-error');
const sessionListEl = $('session-list');
const newSessionBtn = $('new-session-btn');
const agentStatus = $('agent-status');
const agentLabel = $('agent-label');
const terminalsEl = $('terminals');
const emptyHint = $('empty-hint');
const activeTitle = $('active-title');
const activeCwd = $('active-cwd');
const activeStatus = $('active-status');
const deleteBtn = $('delete-session-btn');
const deleteModal = $('delete-modal');
const deleteModalText = $('delete-modal-text');
const tileViewBtn = $('tile-view-btn');
const mobileBackBtn = $('mobile-back-btn');
const mobileSessionMoreBtn = $('mobile-session-more');
const mobileKeybar = $('mobile-keybar');
const mobileCommandForm = $('mobile-command-form');
const mobileCommandInput = $('mobile-command-input');
const mobileCommandSend = $('mobile-command-send');
const mobileDirectInput = $('mobile-direct-input');
const mobileTabbar = $('mobile-tabbar');
const mobileAgentBanner = $('mobile-agent-banner');
const mobileDevicePage = $('mobile-device-page');
const mobileProfilePage = $('mobile-profile-page');
const mainScreen = $('main-screen');
const relayUrlField = $('relay-url-field');
const relayUrlInput = $('relay-url-input');
const settingsBtn = $('settings-btn');
const settingsModal = $('settings-modal');
const sessionSearchInput = $('session-search');
const toast = $('toast');
const pasteModal = $('paste-modal');
const pasteModalText = $('paste-modal-text');
const rememberTokenRow = $('remember-token-row');
const rememberTokenInput = $('remember-token');
const sessionActionsModal = $('session-actions-modal');
const packagedConfig = window.remoteTerminalConfig || {};
const isPackagedClient = location.protocol === 'file:' || packagedConfig.isPackagedClient === true;
const mobileModifiers = { ctrl: false, alt: false };
const clientSettingsStore = new ClientSettings.ClientSettingsStore(localStorage);
const TOKEN_STORAGE_KEY = 'remote-terminal-token';
const ACTIVE_SESSION_KEY = 'remote-terminal-active-session';
let clientSettings = clientSettingsStore.get();
let sessionSearchQuery = '';
let toastTimer = null;
let pendingPaste = null;
let mobileView = 'sessions';
let mobileLayoutActive = isMobileLayout();
let mobileViewportBaseline = window.visualViewport?.height || window.innerHeight;

function isMobileLayout() {
  return matchMedia('(max-width: 760px)').matches;
}

function supportsSecureCredentials() {
  try {
    if (packagedConfig.supportsSecureCredentials === true) return true;
    return window.RemoteTerminalNative?.supportsSecureCredentials?.() === true;
  } catch {
    return false;
  }
}

function readSecureToken() {
  try {
    if (typeof packagedConfig.readCredential === 'function') return packagedConfig.readCredential() || '';
    return window.RemoteTerminalNative?.readCredential?.() || '';
  } catch {
    return '';
  }
}

function writeSecureToken(token) {
  try {
    if (typeof packagedConfig.writeCredential === 'function') packagedConfig.writeCredential(token);
    else window.RemoteTerminalNative?.writeCredential?.(token);
  } catch {
    showToast('系统安全存储不可用，Token 未持久化');
  }
}

function clearSecureToken() {
  try {
    if (typeof packagedConfig.clearCredential === 'function') packagedConfig.clearCredential();
    else window.RemoteTerminalNative?.clearCredential?.();
  } catch { /* secure store is best-effort during logout */ }
}

function normalizeRelayUrl(value) {
  const url = new URL(value);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (!['wss:', 'ws:'].includes(url.protocol)) throw new Error('中转地址必须使用 HTTPS 或 WSS');
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'ws:' && !isLocal) throw new Error('远程中转必须使用 HTTPS/WSS 加密连接');
  url.hash = '';
  return url.toString();
}

function getRelayUrl() {
  if (!isPackagedClient) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}`;
  }
  const configured = localStorage.getItem('remote-terminal-relay-url') || packagedConfig.defaultRelayUrl || '';
  if (!configured) throw new Error('请先填写阿里云中转地址');
  return normalizeRelayUrl(configured);
}

function renderMobileModifiers() {
  for (const button of mobileKeybar?.querySelectorAll('[data-key="CTRL"], [data-key="ALT"]') || []) {
    button.classList.toggle('active', mobileModifiers[button.dataset.key.toLowerCase()]);
  }
}

function applyMobileModifiers(data) {
  let result = data;
  if (mobileModifiers.ctrl && result.length === 1) {
    const code = result.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) result = String.fromCharCode(code - 64);
  }
  if (mobileModifiers.alt) result = `\x1b${result}`;
  if (mobileModifiers.ctrl || mobileModifiers.alt) {
    mobileModifiers.ctrl = false;
    mobileModifiers.alt = false;
    renderMobileModifiers();
  }
  return result;
}

function sendTerminalInput(sessionId, data) {
  return sendWS({ type: 'terminal_input', sessionId, data: applyMobileModifiers(data) });
}

function showToast(message) {
  if (!message) return;
  toast.textContent = message;
  toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2800);
}

function setNativeSystemBarStyle(style) {
  try {
    window.RemoteTerminalNative?.setSystemBarStyle?.(style);
  } catch { /* 浏览器和桌面客户端没有该桥接时无需处理 */ }
}

function updateMobileOverview() {
  const sessionCount = STATE.sessions.length;
  const runningCount = STATE.sessions.filter((session) => session.status === 'running').length;
  const agentName = STATE.agentName || '本地 Agent';
  const relay = localStorage.getItem('remote-terminal-relay-url') || packagedConfig.defaultRelayUrl || location.host || '未配置';

  $('mobile-session-count').textContent = `${sessionCount} 个会话`;
  $('mobile-agent-title').textContent = STATE.agentOnline ? `${agentName} 已连接` : `${agentName} 未连接`;
  $('mobile-agent-subtitle').textContent = STATE.agentOnline
    ? `${runningCount} 个会话正在运行`
    : '点此查看连接状态与重连';
  $('mobile-agent-dot').className = `status-dot ${STATE.agentOnline ? 'online' : 'offline'}`;
  mobileAgentBanner.classList.toggle('online', STATE.agentOnline);

  $('mobile-device-name').textContent = agentName;
  $('mobile-device-state').textContent = STATE.agentOnline ? '在线，可以创建和操作会话' : '当前离线，正在等待重连';
  $('mobile-device-status-dot').className = STATE.agentOnline ? 'online' : 'offline';
  $('mobile-connection-state').textContent = STATE.agentOnline ? '已连接' : '未连接';
  $('mobile-connection-state').className = STATE.agentOnline ? 'connection-online' : '';
  $('mobile-relay-address').textContent = relay;
  $('mobile-running-count').textContent = String(runningCount);

  const active = STATE.sessions.find((session) => session.id === STATE.activeId);
  mobileCommandSend.disabled = !active || active.status === 'exited';
}

function setMobileView(view, options = {}) {
  if (!isMobileLayout()) return;
  const allowed = new Set(['sessions', 'terminal', 'device', 'profile']);
  let next = allowed.has(view) ? view : 'sessions';
  if (next === 'terminal' && !STATE.activeId) next = 'sessions';
  mobileView = next;
  mainScreen.dataset.mobileView = next;

  for (const button of mobileTabbar.querySelectorAll('[data-mobile-tab]')) {
    const active = button.dataset.mobileTab === next;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }

  if (next === 'terminal' && STATE.activeId) {
    const entry = ensureTerminal(STATE.activeId);
    for (const [id, terminal] of terminals) terminal.container.style.display = id === STATE.activeId ? 'block' : 'none';
    entry.container.style.display = 'block';
    emptyHint.style.display = 'none';
    syncVisibleSubscriptions();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fitTerminal(STATE.activeId);
      if (options.focusTerminal) entry.term.focus();
    }));
  } else {
    document.activeElement?.blur?.();
    syncVisibleSubscriptions();
  }

  updateMobileOverview();
  setNativeSystemBarStyle(next === 'terminal' ? 'dark' : 'light');
}

function handleMobileBack() {
  if (!isMobileLayout() || mainScreen.classList.contains('hidden')) return false;
  for (const modal of [pasteModal, sessionActionsModal, settingsModal, deleteModal]) {
    if (!modal.classList.contains('hidden')) {
      modal.classList.add('hidden');
      return true;
    }
  }
  if (mobileView !== 'sessions') {
    setMobileView('sessions');
    return true;
  }
  return false;
}

function handleMobileViewportChanged(forcedKeyboardState) {
  if (!isMobileLayout()) return;
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const commandFocused = document.activeElement === mobileCommandInput;
  if (!commandFocused || viewportHeight > mobileViewportBaseline) {
    mobileViewportBaseline = Math.max(mobileViewportBaseline, viewportHeight);
  }
  const inferredKeyboardOpen = commandFocused && viewportHeight < mobileViewportBaseline - 80;
  const keyboardOpen = typeof forcedKeyboardState === 'boolean'
    ? forcedKeyboardState
    : inferredKeyboardOpen;
  mainScreen.classList.toggle('keyboard-open', keyboardOpen);

  if (mobileView !== 'terminal' || !STATE.activeId) return;
  requestAnimationFrame(() => requestAnimationFrame(() => fitTerminal(STATE.activeId)));
  if (keyboardOpen && commandFocused) {
    setTimeout(() => mobileCommandInput.scrollIntoView({ block: 'nearest' }), 40);
  }
}

function readClipboardText() {
  if (typeof packagedConfig.readClipboardText === 'function') {
    return Promise.resolve(packagedConfig.readClipboardText());
  }
  if (window.RemoteTerminalNative?.readClipboardText) {
    return Promise.resolve(window.RemoteTerminalNative.readClipboardText());
  }
  if (navigator.clipboard?.readText) return navigator.clipboard.readText();
  return Promise.reject(new Error('当前系统不允许读取剪贴板'));
}

function requestPaste(sessionId, text) {
  if (!text) return;
  if (!clientSettings.confirmLargePaste || text.length < 500) {
    sendTerminalInput(sessionId, text);
    return;
  }
  pendingPaste = { sessionId, text };
  const lines = text.split(/\r?\n/).length;
  pasteModalText.textContent = `即将向终端粘贴 ${text.length} 个字符、约 ${lines} 行内容。请确认其中不包含误操作命令。`;
  pasteModal.classList.remove('hidden');
}

function pasteFromClipboard(sessionId) {
  readClipboardText()
    .then((text) => requestPaste(sessionId, text))
    .catch((error) => showToast(error.message || '读取剪贴板失败'));
}

function applyClientSettings() {
  for (const [, entry] of terminals) {
    entry.term.options.fontSize = clientSettings.fontSize;
    entry.term.options.scrollback = clientSettings.scrollback;
    entry.term.options.cursorBlink = clientSettings.cursorBlink;
  }
  mobileKeybar.classList.toggle('setting-hidden', !clientSettings.showMobileKeybar);
  requestAnimationFrame(() => {
    for (const [id, entry] of terminals) {
      if (entry.container.style.display !== 'none') fitTerminal(id);
    }
  });
}

function openSettings() {
  $('setting-relay-row').classList.toggle('hidden', !isPackagedClient);
  $('setting-relay-url').value = localStorage.getItem('remote-terminal-relay-url') || packagedConfig.defaultRelayUrl || '';
  $('setting-font-size').value = String(clientSettings.fontSize);
  $('setting-scrollback').value = String(clientSettings.scrollback);
  $('setting-cursor-blink').checked = clientSettings.cursorBlink;
  $('setting-mobile-keybar').checked = clientSettings.showMobileKeybar;
  $('setting-paste-confirm').checked = clientSettings.confirmLargePaste;
  $('settings-security-hint').textContent = clientSettings.rememberToken
    ? '访问 Token 已由当前系统的安全凭据存储保护。退出登录会删除该凭据。'
    : '中转地址保存在本机；访问 Token 默认只保存在当前运行会话。';
  settingsModal.classList.remove('hidden');
}

function saveSettings() {
  let reconnectForRelayChange = false;
  if (isPackagedClient) {
    try {
      const nextRelay = normalizeRelayUrl($('setting-relay-url').value.trim());
      const previousRelay = localStorage.getItem('remote-terminal-relay-url') || packagedConfig.defaultRelayUrl || '';
      reconnectForRelayChange = nextRelay !== previousRelay;
      localStorage.setItem('remote-terminal-relay-url', nextRelay);
      relayUrlInput.value = nextRelay;
    } catch (error) {
      showToast(error.message || '中转地址格式不正确');
      $('setting-relay-url').focus();
      return;
    }
  }
  clientSettings = clientSettingsStore.update({
    fontSize: $('setting-font-size').value,
    scrollback: $('setting-scrollback').value,
    cursorBlink: $('setting-cursor-blink').checked,
    showMobileKeybar: $('setting-mobile-keybar').checked,
    confirmLargePaste: $('setting-paste-confirm').checked,
  });
  settingsModal.classList.add('hidden');
  applyClientSettings();
  updateMobileOverview();
  if (reconnectForRelayChange && getToken()) {
    try { STATE.ws?.close(1000, 'Relay changed'); } catch {}
    wsClient.resetBackoff();
    setTimeout(connect, 100);
  }
  showToast('设置已保存');
}

function togglePinnedSession(sessionId) {
  const pinned = new Set(clientSettings.pinnedSessionIds);
  if (pinned.has(sessionId)) pinned.delete(sessionId);
  else pinned.add(sessionId);
  clientSettings = clientSettingsStore.update({ pinnedSessionIds: [...pinned] });
  renderSessionList();
}

function openSessionActions() {
  if (!STATE.activeId) return;
  const pinned = clientSettings.pinnedSessionIds.includes(STATE.activeId);
  $('action-pin-session').textContent = pinned ? '取消置顶' : '置顶会话';
  sessionActionsModal.classList.remove('hidden');
}

mobileBackBtn?.addEventListener('click', () => setMobileView('sessions'));
mobileSessionMoreBtn?.addEventListener('click', openSessionActions);
mobileAgentBanner?.addEventListener('click', () => setMobileView('device'));
mobileTabbar?.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-mobile-tab]')?.dataset.mobileTab;
  if (tab) setMobileView(tab);
});
mobileKeybar?.addEventListener('click', (event) => {
  const key = event.target.closest('button')?.dataset.key;
  const active = STATE.activeId && terminals.get(STATE.activeId);
  if (!key || !active?.term) return;
  if (key === 'CTRL' || key === 'ALT') {
    const modifier = key.toLowerCase();
    mobileModifiers[modifier] = !mobileModifiers[modifier];
    renderMobileModifiers();
    return;
  }
  if (key === 'PASTE') {
    pasteFromClipboard(STATE.activeId);
    return;
  }
  const sequences = {
    TAB: '\t', ESC: '\x1b', ENTER: '\r', ARROWLEFT: '\x1b[D', ARROWUP: '\x1b[A',
    ARROWDOWN: '\x1b[B', ARROWRIGHT: '\x1b[C',
  };
  if (sequences[key]) sendTerminalInput(STATE.activeId, sequences[key]);
});
mobileCommandForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!STATE.activeId) return;
  const command = mobileCommandInput.value;
  sendTerminalInput(STATE.activeId, `${command}\r`);
  mobileCommandInput.value = '';
});
mobileCommandInput?.addEventListener('focus', () => {
  handleMobileViewportChanged(true);
  setTimeout(() => handleMobileViewportChanged(), 180);
});
mobileCommandInput?.addEventListener('blur', () => handleMobileViewportChanged(false));
window.visualViewport?.addEventListener('resize', () => handleMobileViewportChanged());
window.visualViewport?.addEventListener('scroll', () => handleMobileViewportChanged());
mobileDirectInput?.addEventListener('click', () => {
  const active = STATE.activeId && terminals.get(STATE.activeId);
  active?.term?.focus();
  showToast('已切换为直接终端输入');
});
$('mobile-reconnect-btn')?.addEventListener('click', () => {
  wsClient.enableReconnect();
  wsClient.resetBackoff();
  connect();
  showToast('正在重新连接…');
});
$('mobile-connection-settings-btn')?.addEventListener('click', openSettings);
$('mobile-open-settings')?.addEventListener('click', openSettings);
$('mobile-open-connection')?.addEventListener('click', openSettings);
$('mobile-logout-btn')?.addEventListener('click', logoutClient);
$('action-pin-session')?.addEventListener('click', () => {
  if (STATE.activeId) togglePinnedSession(STATE.activeId);
  sessionActionsModal.classList.add('hidden');
  showToast('会话置顶状态已更新');
});
$('action-new-session')?.addEventListener('click', () => {
  sessionActionsModal.classList.add('hidden');
  newSession();
});
$('action-delete-session')?.addEventListener('click', () => {
  sessionActionsModal.classList.add('hidden');
  openDeleteModal();
});
$('action-sheet-cancel')?.addEventListener('click', () => sessionActionsModal.classList.add('hidden'));

// ── 工具 ───────────────────────────────────────────────────────
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
}
const getToken = () => sessionStorage.getItem(TOKEN_STORAGE_KEY) || sessionStorage.getItem('claude-web-token') ||
  (clientSettings.rememberToken && supportsSecureCredentials() ? readSecureToken() : '');
function saveToken(token) {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  sessionStorage.removeItem('claude-web-token');
  if (clientSettings.rememberToken && supportsSecureCredentials()) writeSecureToken(token);
  else clearSecureToken();
}
function clearToken() {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  sessionStorage.removeItem('claude-web-token');
  clearSecureToken();
}

const wsClient = new StrictWebSocket.StrictWebSocketClient({
  createSocket: (url) => new WebSocket(url),
  getUrl: () => {
    return getRelayUrl();
  },
  getToken,
  onMessage: handleMessage,
  onSocket: (socket) => { STATE.ws = socket; },
  onDisconnect: () => {
    STATE.authenticated = false;
    STATE.agentOnline = false;
    markAllTerminalsUnsubscribed();
    updateAgentStatus();
  },
  onNoToken: showLogin,
  onError: () => {},
});

function sendWS(obj) {
  return wsClient.send(obj);
}

// ── WebSocket ──────────────────────────────────────────────────
function connect() {
  wsClient.connect();
}

// ── 消息分发 ───────────────────────────────────────────────────
function handleMessage(data) {
  switch (data.type) {
    case 'auth_ok':
      wsClient.markAuthenticated();
      STATE.authenticated = true;
      STATE.clientId = data.clientId;
      STATE.agentOnline = data.agentOnline;
      STATE.agentName = data.agentName || '';
      STATE.sessions = data.sessions || [];
      if (STATE.agentOnline) cancelAgentOfflineTimers();
      showMain();
      reconcileTerminals();
      renderSessionList();
      updateAgentStatus();
      restoreActive();
      syncVisibleSubscriptions();
      break;

    case 'error':
      if (!STATE.authenticated) {
        wsClient.disableReconnect();
        clearToken();
        showLoginError(data.message || '认证失败');
      }
      break;

    case 'agent_status':
      if (!data.online) {
        // Agent 离线：先等 3 秒，确认不是短暂断连再更新 UI
        if (!agentOfflineDebounce) {
          agentOfflineDebounce = setTimeout(() => {
            agentOfflineDebounce = null;
            STATE.agentOnline = false;
            updateAgentStatus();
            for (const s of STATE.sessions) s.status = 'disconnected';
            renderSessionList();
            // 启动延迟清理
            if (!agentOfflineTimer) {
              agentOfflineTimer = setTimeout(() => {
                agentOfflineTimer = null;
                if (!STATE.agentOnline) cleanDisconnectedSessions();
              }, AGENT_OFFLINE_CLEANUP_MS);
            }
          }, AGENT_OFFLINE_DEBOUNCE_MS);
        }
      } else {
        // Agent 上线：取消离线防抖和清理定时器
        cancelAgentOfflineTimers();
        STATE.agentOnline = true;
        if (data.agentName) STATE.agentName = data.agentName;
        updateAgentStatus();
      }
      break;

    case 'sessions':
      STATE.sessions = data.sessions || [];
      reconcileTerminals();
      if (!STATE.activeId && STATE.sessions.length > 0) restoreActive();
      renderSessionList();
      updateActiveHeader();
      if (STATE.splitMode) refreshTileView();
      syncVisibleSubscriptions();
      break;

    case 'terminal_created':
      upsertSession({ id: data.sessionId, title: data.title, cwd: data.cwd, pid: data.pid, status: data.status, createdAt: data.createdAt || Date.now() });
      renderSessionList();
      selectSession(data.sessionId);
      if (STATE.splitMode) refreshTileView();
      break;

    case 'terminal_output':
      writeOutput(data.sessionId, data.data, data.seq);
      break;

    case 'terminal_snapshot':
      applyTerminalSnapshot(data);
      break;

    case 'terminal_attached': {
      const t = terminals.get(data.sessionId);
      if (t && Number.isSafeInteger(data.seq) && t.stream.lastSequence !== null &&
          data.seq > t.stream.lastSequence) {
        requestTerminalResync(data.sessionId);
      }
      break;
    }

    case 'terminal_exit':
      markStatus(data.sessionId, 'exited');
      writeLocalOutput(data.sessionId, `\r\n\x1b[33m[进程退出 code=${data.exitCode}]\x1b[0m\r\n`);
      break;

    case 'terminal_closed':
      removeSession(data.sessionId);
      if (STATE.splitMode) refreshTileView();
      break;

    case 'terminal_error':
      if (data.sessionId && terminals.has(data.sessionId)) {
        writeLocalOutput(data.sessionId, `\r\n\x1b[31m[错误] ${data.message}\x1b[0m\r\n`);
      } else {
        showToast(data.message || '操作失败');
      }
      break;
  }
}

// ── 会话数据 ───────────────────────────────────────────────────
function upsertSession(s) {
  const i = STATE.sessions.findIndex((x) => x.id === s.id);
  if (i >= 0) STATE.sessions[i] = { ...STATE.sessions[i], ...s };
  else STATE.sessions.push(s);
}
function markStatus(id, status) {
  const s = STATE.sessions.find((x) => x.id === id);
  if (s) s.status = status;
  renderSessionList();
  if (id === STATE.activeId) updateActiveHeader();
  updateMobileOverview();
}
function removeSession(id) {
  STATE.sessions = STATE.sessions.filter((x) => x.id !== id);
  const t = terminals.get(id);
  if (t) { disposeTerminal(id); }
  renderSessionList();
  if (STATE.activeId === id) {
    STATE.activeId = null;
    const next = STATE.sessions[0];
    if (isMobileLayout()) {
      if (next) {
        STATE.activeId = next.id;
        localStorage.setItem(ACTIVE_SESSION_KEY, next.id);
      } else {
        localStorage.removeItem(ACTIVE_SESSION_KEY);
      }
      updateActiveHeader();
      setMobileView('sessions');
    } else if (next) selectSession(next.id);
    else updateActiveHeader();
  }
  updateMobileOverview();
}

/** 销毁终端实例（含 ResizeObserver 清理） */
function disposeTerminal(sessionId) {
  const t = terminals.get(sessionId);
  if (!t) return;
  if (t.subscribed) sendWS({ type: 'terminal_detach', sessionId });
  t.subscribed = false;
  if (t.observer) { t.observer.disconnect(); t.observer = null; }
  t.stream.dispose();
  try { t.term.dispose(); } catch {}
  try { t.container.remove(); } catch {}
  terminals.delete(sessionId);
}

/** 清理所有 disconnected / recovered 等异常状态的会话 */
const STALE_STATUSES = new Set(['disconnected', 'recovered']);

function cleanDisconnectedSessions() {
  const staleIds = new Set(
    STATE.sessions.filter(s => STALE_STATUSES.has(s.status)).map(s => s.id)
  );
  if (staleIds.size === 0) return;
  for (const id of staleIds) {
    disposeTerminal(id);
  }
  STATE.sessions = STATE.sessions.filter(s => !staleIds.has(s.id));
  if (STATE.activeId && staleIds.has(STATE.activeId)) {
    STATE.activeId = null;
    localStorage.removeItem(ACTIVE_SESSION_KEY);
    localStorage.removeItem('claude-web-active');
    const next = STATE.sessions.find(s => s.status === 'running');
    if (isMobileLayout()) {
      if (next) {
        STATE.activeId = next.id;
        localStorage.setItem(ACTIVE_SESSION_KEY, next.id);
      }
      updateActiveHeader();
      setMobileView('sessions');
    } else if (next) selectSession(next.id);
    else updateActiveHeader();
  }
  renderSessionList();
}

// 服务器会话列表变化时，丢弃本地已不存在的终端
function reconcileTerminals() {
  const ids = new Set(STATE.sessions.map((s) => s.id));
  for (const [id] of terminals) {
    if (!ids.has(id)) disposeTerminal(id);
  }
  if (STATE.activeId && !ids.has(STATE.activeId)) {
    STATE.activeId = null;
    localStorage.removeItem(ACTIVE_SESSION_KEY);
    localStorage.removeItem('claude-web-active');
    if (isMobileLayout()) setMobileView('sessions');
  }
}

// ── 终端实例 ───────────────────────────────────────────────────
function ensureTerminal(sessionId) {
  if (terminals.has(sessionId)) return terminals.get(sessionId);

  const container = document.createElement('div');
  container.className = 'term-container';
  // 先不隐藏，让 xterm 在可见容器中初始化以获得正确尺寸
  container.style.display = 'none';
  terminalsEl.appendChild(container);

  const term = new Terminal({
    cursorBlink: clientSettings.cursorBlink,
    fontSize: clientSettings.fontSize,
    fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", monospace',
    theme: { background: '#0d1117', foreground: '#e6edf3' },
    scrollback: clientSettings.scrollback,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const unicode11 = new Unicode11Addon.Unicode11Addon();
  term.loadAddon(unicode11);
  term.unicode.activeVersion = '11';
  term.open(container);

  // 键入 → 发送到 Agent
  term.onData((d) => sendTerminalInput(sessionId, d));

  // Ctrl+V / Cmd+V: 拦截浏览器默认粘贴，改为读取纯文本
  term.attachCustomKeyEventHandler((e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'v' && e.type === 'keydown') {
      if (e.shiftKey) return true;
      pasteFromClipboard(sessionId);
      return false;
    }
    return true;
  });

  // ResizeObserver：容器尺寸变化时自动 fit，解决终端不铺满问题
  const observer = new ResizeObserver(() => {
    const t = terminals.get(sessionId);
    if (!t || t.container.style.display === 'none') return;
    try {
      // 延迟一帧确保布局完成
      requestAnimationFrame(() => {
        try {
          t.fit.fit();
          sendWS({ type: 'terminal_resize', sessionId, cols: t.term.cols, rows: t.term.rows });
        } catch {}
      });
    } catch {}
  });
  observer.observe(container);

  const stream = new TerminalStream.TerminalStreamController(term, {
    maxPendingBytes: 512 * 1024,
    onResync: () => requestTerminalResync(sessionId),
    onSnapshotApplied: () => {
      const current = terminals.get(sessionId);
      if (!current || current.container.style.display === 'none') return;
      requestAnimationFrame(() => fitTerminal(sessionId));
    },
  });
  const entry = {
    term,
    fit,
    stream,
    unicode11,
    container,
    subscribed: false,
    observer,
    lastActivity: 0,
  };
  terminals.set(sessionId, entry);
  return entry;
}

function writeOutput(sessionId, data, sequence) {
  const t = terminals.get(sessionId);
  if (!t || !t.subscribed) return;
  t.lastActivity = Date.now();
  t.stream.acceptOutput(data, sequence);
}

function writeLocalOutput(sessionId, data) {
  const t = terminals.get(sessionId);
  if (t) t.stream.writeLocal(data);
}

function applyTerminalSnapshot(data) {
  const t = terminals.get(data.sessionId);
  if (!t || !t.subscribed) {
    sendWS({ type: 'terminal_detach', sessionId: data.sessionId });
    return;
  }
  t.stream.applySnapshot(data);
}

function requestTerminalResync(sessionId) {
  const t = terminals.get(sessionId);
  if (!t || !t.subscribed || !STATE.authenticated) return;
  sendWS({ type: 'terminal_resync', sessionId });
}

function markAllTerminalsUnsubscribed() {
  for (const [id, t] of terminals) {
    t.subscribed = false;
    t.stream.beginSync();
  }
}

function visibleSessionIds() {
  if (isMobileLayout() && mobileView !== 'terminal') return new Set();
  if (STATE.splitMode) {
    return new Set(STATE.sessions.filter((s) => s.status !== 'exited').map((s) => s.id));
  }
  return new Set(STATE.activeId ? [STATE.activeId] : []);
}

/** 保证服务器只推送当前可见终端，隐藏会话不再消耗浏览器渲染队列。 */
function syncVisibleSubscriptions() {
  if (!STATE.authenticated) return;
  const desired = visibleSessionIds();
  for (const sessionId of desired) ensureTerminal(sessionId);

  for (const [sessionId, t] of terminals) {
    const shouldSubscribe = desired.has(sessionId);
    if (!shouldSubscribe && t.subscribed) {
      sendWS({ type: 'terminal_detach', sessionId });
      t.subscribed = false;
      t.stream.pause();
    } else if (shouldSubscribe && !t.subscribed) {
      t.stream.beginSync();
      t.subscribed = sendWS({ type: 'terminal_attach', sessionId });
    }
  }
}

/** 执行终端 fit + resize 通知 */
function fitTerminal(sessionId) {
  const t = terminals.get(sessionId);
  if (!t || t.container.style.display === 'none') return;
  try {
    t.fit.fit();
    sendWS({ type: 'terminal_resize', sessionId, cols: t.term.cols, rows: t.term.rows });
  } catch {}
}

// ── 选择 / 切换会话 ────────────────────────────────────────────
function selectSession(sessionId) {
  if (!STATE.sessions.find((s) => s.id === sessionId)) return;
  STATE.activeId = sessionId;
  localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
  localStorage.removeItem('claude-web-active');

  if (isMobileLayout()) {
    STATE.splitMode = false;
    setMobileView('terminal');
  } else if (STATE.splitMode) {
    refreshTileView();
    const entry = terminals.get(sessionId);
    if (entry) entry.term.focus();
  } else {
    // 单屏模式：只显示当前终端
    emptyHint.style.display = 'none';
    for (const [id, t] of terminals) {
      t.container.style.display = id === sessionId ? 'block' : 'none';
    }
    const entry = ensureTerminal(sessionId);
    entry.container.style.display = 'block';
    syncVisibleSubscriptions();
    // 双重 rAF 确保 DOM 布局完成后再 fit
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitTerminal(sessionId);
        entry.term.focus();
      });
    });
  }

  renderSessionList();
  updateActiveHeader();
}

// ── 分屏模式 ────────────────────────────────────────────────────
function toggleSplitView() {
  STATE.splitMode = !STATE.splitMode;

  if (STATE.splitMode) {
    tileViewBtn.classList.add('active');
    tileViewBtn.textContent = '📐 单屏';
    for (const s of STATE.sessions) {
      if (s.status !== 'exited') {
        ensureTerminal(s.id);
      }
    }
    refreshTileView();
  } else {
    tileViewBtn.classList.remove('active');
    tileViewBtn.textContent = '📐 分屏';
    terminalsEl.classList.remove('tiled');
    for (const [, t] of terminals) {
      t.container.style.display = 'none';
      t.container.style.border = '';
    }
    emptyHint.style.display = 'none';
    if (STATE.activeId) {
      selectSession(STATE.activeId);
    }
  }
}

function refreshTileView() {
  if (!STATE.splitMode) return;

  const visibleSessions = STATE.sessions.filter(
    (s) => s.status !== 'exited'
  );

  if (visibleSessions.length === 0) {
    terminalsEl.classList.remove('tiled');
    emptyHint.style.display = '';
    syncVisibleSubscriptions();
    return;
  }

  terminalsEl.classList.add('tiled');
  emptyHint.style.display = 'none';

  let cols = 1;
  if (visibleSessions.length >= 5) cols = 3;
  else if (visibleSessions.length >= 3) cols = 2;
  terminalsEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  for (const s of visibleSessions) {
    ensureTerminal(s.id);
  }

  for (const [id, t] of terminals) {
    if (visibleSessions.some((s) => s.id === id)) {
      t.container.style.display = 'block';
      t.container.style.border = id === STATE.activeId
        ? '1px solid var(--accent)'
        : '1px solid var(--border)';
    } else {
      t.container.style.display = 'none';
      t.container.style.border = '';
    }
  }

  syncVisibleSubscriptions();

  // 延迟 fit 确保 grid 布局完成
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const s of visibleSessions) {
        fitTerminal(s.id);
      }
    });
  });
}

function restoreActive() {
  const saved = localStorage.getItem(ACTIVE_SESSION_KEY) || localStorage.getItem('claude-web-active');
  const target = STATE.sessions.find((s) => s.id === saved) || STATE.sessions[0];
  if (target && isMobileLayout()) {
    STATE.activeId = target.id;
    localStorage.setItem(ACTIVE_SESSION_KEY, target.id);
    updateActiveHeader();
    renderSessionList();
    setMobileView('sessions');
  } else if (target) {
    selectSession(target.id);
  } else {
    STATE.activeId = null;
    localStorage.removeItem(ACTIVE_SESSION_KEY);
    localStorage.removeItem('claude-web-active');
    updateActiveHeader();
    if (isMobileLayout()) setMobileView('sessions');
  }
}

// ── 新建 / 删除 ────────────────────────────────────────────────
function newSession() {
  if (!STATE.agentOnline) return showToast('Agent 离线，无法创建会话');
  const now = new Date();
  const title = '终端 ' + String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  const id = uuid();
  sendWS({ type: 'terminal_create', sessionId: id, title });
}

function openDeleteModal() {
  if (!STATE.activeId) return;
  const s = STATE.sessions.find((x) => x.id === STATE.activeId);
  deleteModalText.textContent = `确认删除会话「${s ? s.title : ''}」？终端进程将被终止。`;
  deleteModal.classList.remove('hidden');
}
function confirmDelete() {
  const id = STATE.activeId;
  if (!id) return;
  sendWS({ type: 'terminal_delete', sessionId: id });
  deleteModal.classList.add('hidden');
}

// ── 会话活动状态 ───────────────────────────────────────────────
/** 计算会话的 activity 状态 */
function getActivityState(sessionId) {
  const t = terminals.get(sessionId);
  if (!t || !t.lastActivity) return 'idle';
  const elapsed = Date.now() - t.lastActivity;
  if (elapsed < ACTIVITY_BUSY_MS) return 'busy';
  if (elapsed < ACTIVITY_DONE_MS) return 'done';
  return 'idle';
}

/** 启动 activity 定时刷新（仅更新指示器，不重建 DOM） */
function ensureActivityTimer() {
  if (activityTimer) return;
  activityTimer = setInterval(() => {
    // 只更新活动指示器，不重建整个列表
    for (const s of STATE.sessions) {
      const li = sessionListEl.querySelector(`[data-sid="${CSS.escape(s.id)}"]`);
      if (li) updateSessionItemState(li, s);
    }
  }, 2000);
}

// ── 渲染 ───────────────────────────────────────────────────────
function renderSessionList() {
  const scrollTop = sessionListEl.scrollTop;
  sessionListEl.innerHTML = '';
  const fragment = document.createDocumentFragment();
  const sessions = getVisibleSessions();
  for (const s of sessions) {
    fragment.appendChild(buildSessionItem(s));
  }
  if (sessions.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'session-empty';
    if (sessionSearchQuery) {
      empty.textContent = '没有找到匹配的会话';
    } else {
      const icon = document.createElement('div');
      icon.className = 'session-empty-icon';
      icon.textContent = '>_';
      const message = document.createElement('p');
      message.textContent = STATE.agentOnline ? '还没有终端会话' : '设备上线后即可创建终端会话';
      empty.append(icon, message);
      if (STATE.agentOnline) {
        const create = document.createElement('button');
        create.type = 'button';
        create.textContent = '新建终端';
        create.addEventListener('click', newSession);
        empty.appendChild(create);
      }
    }
    fragment.appendChild(empty);
  }
  sessionListEl.appendChild(fragment);
  sessionListEl.scrollTop = scrollTop;
  updateMobileOverview();
}

function getVisibleSessions() {
  const query = sessionSearchQuery.trim().toLocaleLowerCase();
  const pinned = new Set(clientSettings.pinnedSessionIds);
  return STATE.sessions
    .map((session, index) => ({ session, index }))
    .filter(({ session }) => !query || `${session.title || ''}\n${session.cwd || ''}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(pinned.has(b.session.id)) - Number(pinned.has(a.session.id)) ||
      sessionRecency(b.session) - sessionRecency(a.session) || b.index - a.index)
    .map(({ session }) => session);
}

function sessionRecency(session) {
  const activity = terminals.get(session.id)?.lastActivity || 0;
  const created = session.createdAt ? new Date(session.createdAt).getTime() : 0;
  return Math.max(activity, Number.isFinite(created) ? created : 0);
}

/** 构建单个会话列表项 DOM */
function buildSessionItem(s) {
  const li = document.createElement('li');
  li.className = 'session-item' + (s.id === STATE.activeId ? ' active' : '');
  li.setAttribute('data-sid', s.id);
  li.tabIndex = 0;

  li.setAttribute('aria-label', `${s.title || '未命名会话'}，${statusText(s.status)}`);

  const avatar = document.createElement('div');
  avatar.className = 'session-avatar';
  const avatarText = document.createElement('span');
  avatarText.textContent = '>_';
  const dot = document.createElement('i');
  dot.className = 's-dot off';
  avatar.append(avatarText, dot);
  li.appendChild(avatar);

  const meta = document.createElement('div');
  meta.className = 's-meta';
  const titleEl = document.createElement('span');
  titleEl.className = 's-title';
  titleEl.textContent = s.title || '';
  meta.appendChild(titleEl);
  const cwdEl = document.createElement('span');
  cwdEl.className = 's-cwd';
  cwdEl.textContent = [statusText(s.status), shortPath(s.cwd)].filter(Boolean).join(' · ');
  meta.appendChild(cwdEl);
  li.appendChild(meta);

  const pin = document.createElement('button');
  const isPinned = clientSettings.pinnedSessionIds.includes(s.id);
  pin.className = 'session-pin' + (isPinned ? ' pinned' : '');
  pin.type = 'button';
  pin.textContent = isPinned ? '★' : '☆';
  pin.title = isPinned ? '取消置顶' : '置顶会话';
  pin.setAttribute('aria-label', pin.title);
  pin.onclick = (event) => {
    event.stopPropagation();
    togglePinnedSession(s.id);
  };
  li.appendChild(pin);

  const side = document.createElement('div');
  side.className = 's-side';
  const time = document.createElement('span');
  time.className = 's-time';
  time.textContent = formatSessionTime(s.createdAt);
  const indicator = document.createElement('span');
  indicator.className = 's-indicator';
  indicator.style.display = 'none';
  side.append(time, indicator);
  li.appendChild(side);

  // 设置初始状态
  updateSessionItemState(li, s);

  li.onclick = () => selectSession(s.id);
  li.oncontextmenu = (event) => {
    event.preventDefault();
    STATE.activeId = s.id;
    localStorage.setItem(ACTIVE_SESSION_KEY, s.id);
    renderSessionList();
    updateActiveHeader();
    openSessionActions();
  };
  li.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectSession(s.id);
    }
  };
  return li;
}

function formatSessionTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** 更新单个会话项的圆点和指示器状态（不重建 DOM） */
function updateSessionItemState(li, s) {
  const dot = li.querySelector('.s-dot');
  const indicator = li.querySelector('.s-indicator');
  if (!dot || !indicator) return;

  if (s.status === 'running') {
    const act = getActivityState(s.id);
    if (act === 'busy') {
      dot.className = 's-dot busy';
      indicator.style.display = '';
      indicator.className = 's-indicator busy-icon';
      indicator.textContent = '●';
    } else if (act === 'done') {
      dot.className = 's-dot ok';
      indicator.style.display = '';
      indicator.className = 's-indicator done';
      indicator.textContent = '⏺';
    } else {
      dot.className = 's-dot ok';
      indicator.style.display = 'none';
    }
  } else if (s.status === 'exited') {
    dot.className = 's-dot warn';
    indicator.style.display = 'none';
  } else {
    dot.className = 's-dot off';
    indicator.style.display = 'none';
  }
}

function updateActiveHeader() {
  const s = STATE.sessions.find((x) => x.id === STATE.activeId);
  const hasSessions = STATE.sessions.length > 0;
  tileViewBtn.disabled = !hasSessions;
  if (!s) {
    activeTitle.textContent = '未选择会话';
    activeCwd.textContent = '';
    activeStatus.textContent = '';
    activeStatus.className = 'badge';
    deleteBtn.disabled = true;
    mobileSessionMoreBtn.disabled = true;
    if (terminals.size === 0) emptyHint.style.display = '';
    updateMobileOverview();
    return;
  }
  activeTitle.textContent = s.title;
  activeCwd.textContent = s.cwd || '';
  activeStatus.textContent = statusText(s.status);
  activeStatus.className = 'badge ' + (s.status === 'running' ? 'ok' : 'warn');
  deleteBtn.disabled = false;
  mobileSessionMoreBtn.disabled = false;
  updateMobileOverview();
}

function updateAgentStatus() {
  const name = STATE.agentName || 'Agent';
  if (STATE.agentOnline) {
    agentStatus.className = 'status-dot online';
    agentLabel.textContent = name + ' 在线';
  } else {
    agentStatus.className = 'status-dot offline';
    agentLabel.textContent = name + ' 离线';
  }
  newSessionBtn.disabled = !STATE.agentOnline;
  updateMobileOverview();
}

function statusText(s) {
  return { running: '运行中', exited: '已退出', disconnected: '断开', recovered: '残留' }[s] || s || '';
}
function shortPath(p) {
  if (!p) return '';
  const parts = p.split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
}
function escapeHtml(t) {
  const d = document.createElement('div');
  d.textContent = t == null ? '' : t;
  return d.innerHTML;
}

// ── 屏幕切换 ───────────────────────────────────────────────────
function showLogin() {
  loginScreen.classList.remove('hidden');
  mainScreen.classList.add('hidden');
  setNativeSystemBarStyle('light');
}
function showMain() {
  loginScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  if (isMobileLayout()) setMobileView(mobileView);
  // 启动 activity 刷新定时器
  ensureActivityTimer();
}
function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
  loginBtn.disabled = false;
}

function logoutClient() {
  wsClient.disableReconnect();
  clearToken();
  clientSettings = clientSettingsStore.update({ rememberToken: false });
  rememberTokenInput.checked = false;
  try { STATE.ws?.close(1000, 'User logged out'); } catch {}
  for (const [id] of [...terminals]) disposeTerminal(id);
  STATE.sessions = [];
  STATE.activeId = null;
  STATE.authenticated = false;
  STATE.agentOnline = false;
  localStorage.removeItem(ACTIVE_SESSION_KEY);
  localStorage.removeItem('claude-web-active');
  settingsModal.classList.add('hidden');
  renderSessionList();
  mobileView = 'sessions';
  mainScreen.dataset.mobileView = 'sessions';
  showLogin();
}

// ── 事件 ───────────────────────────────────────────────────────
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = tokenInput.value.trim();
  if (!t) return;
  loginBtn.disabled = true;
  loginError.classList.add('hidden');
  if (isPackagedClient) {
    try {
      const relayUrl = normalizeRelayUrl(relayUrlInput.value.trim());
      localStorage.setItem('remote-terminal-relay-url', relayUrl);
    } catch (error) {
      showLoginError(error.message);
      return;
    }
  }
  clientSettings = clientSettingsStore.update({
    rememberToken: supportsSecureCredentials() && rememberTokenInput.checked,
  });
  wsClient.enableReconnect();
  wsClient.resetBackoff();
  saveToken(t);
  connect();
});
newSessionBtn.addEventListener('click', newSession);
settingsBtn.addEventListener('click', openSettings);
sessionSearchInput.addEventListener('input', () => {
  sessionSearchQuery = sessionSearchInput.value;
  renderSessionList();
});
tileViewBtn.addEventListener('click', toggleSplitView);
deleteBtn.addEventListener('click', openDeleteModal);
$('delete-cancel').addEventListener('click', () => deleteModal.classList.add('hidden'));
$('delete-confirm').addEventListener('click', confirmDelete);
$('settings-cancel').addEventListener('click', () => settingsModal.classList.add('hidden'));
$('settings-close').addEventListener('click', () => settingsModal.classList.add('hidden'));
$('settings-save').addEventListener('click', saveSettings);
$('settings-reset').addEventListener('click', () => {
  clearSecureToken();
  clientSettings = clientSettingsStore.reset();
  rememberTokenInput.checked = false;
  applyClientSettings();
  openSettings();
  showToast('已恢复默认设置');
});
$('settings-logout').addEventListener('click', logoutClient);
$('paste-cancel').addEventListener('click', () => {
  pendingPaste = null;
  pasteModal.classList.add('hidden');
});
$('paste-confirm').addEventListener('click', () => {
  const paste = pendingPaste;
  pendingPaste = null;
  pasteModal.classList.add('hidden');
  if (paste) sendTerminalInput(paste.sessionId, paste.text);
});

for (const modal of [settingsModal, pasteModal, sessionActionsModal]) {
  modal.addEventListener('click', (event) => {
    if (event.target === modal) modal.classList.add('hidden');
  });
}

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLocaleLowerCase() === 'k') {
    event.preventDefault();
    if (isMobileLayout()) setMobileView('sessions');
    requestAnimationFrame(() => {
      sessionSearchInput.focus();
      sessionSearchInput.select();
    });
    return;
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-9]$/.test(event.key)) {
    const session = getVisibleSessions()[Number(event.key) - 1];
    if (session) {
      event.preventDefault();
      selectSession(session.id);
    }
    return;
  }
  if (event.key === 'Escape') {
    if (handleMobileBack()) return;
    settingsModal.classList.add('hidden');
    pasteModal.classList.add('hidden');
    sessionActionsModal.classList.add('hidden');
    deleteModal.classList.add('hidden');
  }
});

// 窗口缩放时重新 fit 可见终端（ResizeObserver 已覆盖此场景，此作为兜底）
window.addEventListener('resize', () => {
  handleMobileViewportChanged();
  const nowMobile = isMobileLayout();
  if (nowMobile !== mobileLayoutActive) {
    mobileLayoutActive = nowMobile;
    if (nowMobile) setMobileView('sessions');
    else if (STATE.activeId) selectSession(STATE.activeId);
  }
  if (STATE.splitMode) {
    for (const [id, t] of terminals) {
      if (t.container.style.display !== 'none') fitTerminal(id);
    }
  } else {
    if (STATE.activeId) fitTerminal(STATE.activeId);
  }
});
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    mobileViewportBaseline = window.visualViewport?.height || window.innerHeight;
    handleMobileViewportChanged();
  }, 300);
});

window.addEventListener('online', () => {
  wsClient.resetBackoff();
  connect();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && getToken()) connect();
});

// 心跳
setInterval(() => {
  if (STATE.authenticated) sendWS({ type: 'ping' });
}, 30000);

// ── 启动 ───────────────────────────────────────────────────────
window.RemoteTerminalApp = Object.freeze({
  handleBack: handleMobileBack,
  onViewportChanged: handleMobileViewportChanged,
  showSessions: () => setMobileView('sessions'),
});

if (isPackagedClient) {
  relayUrlField.classList.remove('hidden');
  relayUrlInput.value = localStorage.getItem('remote-terminal-relay-url') || packagedConfig.defaultRelayUrl || '';
}
if (isPackagedClient && supportsSecureCredentials()) {
  rememberTokenRow.classList.remove('hidden');
  rememberTokenInput.checked = clientSettings.rememberToken;
}
applyClientSettings();
updateMobileOverview();
if (getToken()) connect();
else showLogin();
