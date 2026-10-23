/* ═══════════════════════════════════════════════════════════════
   Remote Terminal — 通用客户端 UI
   连接中转、管理多会话，把每个会话渲染成一个 xterm 终端。
   ═══════════════════════════════════════════════════════════════ */

// ── 状态 ───────────────────────────────────────────────────────
const STATE = {
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
const sessionListEl = $('session-list');
const newSessionBtn = $('new-session-btn');
const agentStatus = $('agent-status');
const agentLabel = $('agent-label');
const terminalsEl = $('terminals');
const emptyHint = $('empty-hint');
const activeTitle = $('active-title');
const activeCwd = $('active-cwd');
const activeStatus = $('active-status');
const renameSessionBtn = $('rename-session-btn');
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
const devicePage = $('device-page');
const mobileProfilePage = $('mobile-profile-page');
const mainScreen = $('main-screen');
const settingsBtn = $('settings-btn');
const settingsModal = $('settings-modal');
const sessionSearchInput = $('session-search');
const toast = $('toast');
const pasteModal = $('paste-modal');
const pasteModalText = $('paste-modal-text');
const sessionActionsModal = $('session-actions-modal');
const deviceListEl = $('device-list');
const desktopDeviceListEl = $('desktop-device-list');
const desktopActiveDeviceName = $('desktop-active-device-name');
const deviceEmpty = $('device-empty');
const deviceSearchInput = $('device-search-input');
const deviceModal = $('device-modal');
const deviceForm = $('device-form');
const deviceDeleteModal = $('device-delete-modal');
const sessionRenameModal = $('session-rename-modal');
const sessionRenameInput = $('session-rename-input');
const historyBottomBtn = $('history-bottom-btn');
const packagedConfig = window.remoteTerminalConfig || {};
const mobileModifiers = { ctrl: false, alt: false };
const clientSettingsStore = new ClientSettings.ClientSettingsStore(localStorage);
const deviceRegistry = new DeviceStore.DeviceRegistry(localStorage);
const TOKEN_STORAGE_KEY = 'remote-terminal-token';
const LEGACY_ACTIVE_SESSION_KEY = 'remote-terminal-active-session';
const PRODUCT_DEFAULT_RELAY_URL = 'wss://webclaude.xmu-zss.cn';
const CLIENT_UI_VERSION = '0.3.3';
const MAX_TOKEN_LENGTH = 512;
const MAX_TERMINAL_INPUT_BYTES = 48 * 1024;
const MAX_TERMINAL_INPUT_TOTAL_BYTES = 512 * 1024;
const VALID_SESSION_STATUSES = new Set(['running', 'exited', 'disconnected']);
let clientSettings = clientSettingsStore.get();
let sessionSearchQuery = '';
let deviceSearchQuery = '';
let toastTimer = null;
let pendingPaste = null;
let mobileView = 'sessions';
let mobileLayoutActive = isMobileLayout();
let mobileViewportBaseline = window.visualViewport?.height || window.innerHeight;
let activeDeviceToken = '';
let pendingDeleteDeviceId = '';
let historyButtonFrame = 0;
const transientDeviceTokens = new Map();

function browserTokenIsValid(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= MAX_TOKEN_LENGTH &&
    new TextEncoder().encode(value).byteLength <= 1024 &&
    !/change-me|deprecated|your-token|shared-secret/i.test(value);
}

function requireValidBrowserToken(value) {
  if (!browserTokenIsValid(value)) {
    throw new Error('APP 访问 Token（browserToken）必须为 32-512 个字符，且不能使用示例值');
  }
  return value;
}

function cleanClientText(value, fallback = '', maxLength = 120) {
  const text = typeof value === 'string'
    ? value.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  return (text || fallback).slice(0, maxLength);
}

function validSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function normalizeSession(value) {
  if (!value || typeof value !== 'object' || !validSessionId(value.id) ||
      !VALID_SESSION_STATUSES.has(value.status)) return null;
  return {
    id: value.id,
    title: cleanClientText(value.title, '新会话', 120),
    cwd: cleanClientText(value.cwd, '', 4096),
    pid: Number.isInteger(value.pid) && value.pid >= 0 ? value.pid : null,
    status: value.status,
    createdAt: Number.isFinite(value.createdAt) && value.createdAt >= 0 ? value.createdAt : Date.now(),
  };
}

function normalizeSessionList(value) {
  const result = [];
  const seen = new Set();
  for (const candidate of Array.isArray(value) ? value.slice(0, 100) : []) {
    const session = normalizeSession(candidate);
    if (!session || seen.has(session.id)) continue;
    seen.add(session.id);
    result.push(session);
  }
  return result;
}

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

function readLegacySecureToken() {
  try {
    if (typeof packagedConfig.readCredential === 'function') return packagedConfig.readCredential() || '';
    return window.RemoteTerminalNative?.readCredential?.() || '';
  } catch {
    return '';
  }
}

function readDeviceToken(deviceId) {
  if (!deviceId) return '';
  if (transientDeviceTokens.has(deviceId)) {
    const token = transientDeviceTokens.get(deviceId) || '';
    return browserTokenIsValid(token) ? token : '';
  }
  let token = '';
  try {
    if (typeof packagedConfig.readDeviceCredential === 'function') {
      token = packagedConfig.readDeviceCredential(deviceId) || '';
    } else {
      token = window.RemoteTerminalNative?.readDeviceCredential?.(deviceId) || '';
    }
  } catch { /* invalid or unavailable secure storage */ }
  return browserTokenIsValid(token) ? token : '';
}

function writeDeviceToken(deviceId, token) {
  requireValidBrowserToken(token);
  transientDeviceTokens.set(deviceId, token);
  if (!supportsSecureCredentials()) {
    showToast('系统安全存储不可用，Token 仅保留到本次关闭软件');
    return;
  }
  try {
    let saved;
    if (typeof packagedConfig.writeDeviceCredential === 'function') {
      saved = packagedConfig.writeDeviceCredential(deviceId, token);
    } else {
      saved = window.RemoteTerminalNative?.writeDeviceCredential?.(deviceId, token);
    }
    if (saved === false) throw new Error('Secure credential storage rejected the write');
  } catch {
    showToast('系统安全存储写入失败，Token 仅保留到本次关闭软件');
  }
}

function clearDeviceToken(deviceId) {
  transientDeviceTokens.delete(deviceId);
  try {
    if (typeof packagedConfig.clearDeviceCredential === 'function') {
      packagedConfig.clearDeviceCredential(deviceId);
    } else {
      window.RemoteTerminalNative?.clearDeviceCredential?.(deviceId);
    }
  } catch { /* secure store cleanup is best-effort during device deletion */ }
}

function nativeDefaultRelayUrl() {
  try {
    return packagedConfig.defaultRelayUrl ||
      window.RemoteTerminalNative?.getDefaultRelayUrl?.() ||
      PRODUCT_DEFAULT_RELAY_URL;
  } catch {
    return PRODUCT_DEFAULT_RELAY_URL;
  }
}

function normalizeRelayUrl(value) {
  const input = String(value || '').trim();
  if (!input) throw new Error('请填写中转域名或地址');
  const url = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input) ? input : `wss://${input}`);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (!['wss:', 'ws:'].includes(url.protocol)) throw new Error('中转地址必须使用 HTTPS 或 WSS');
  if (url.username || url.password) throw new Error('中转地址不能包含用户名或密码，请把 Token 单独填写');
  if (url.search || url.hash) throw new Error('中转地址不能包含查询参数或片段');
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'ws:' && !isLocal) throw new Error('远程中转必须使用 HTTPS/WSS 加密连接');
  return url.toString();
}

function getRelayUrl() {
  const activeDevice = deviceRegistry.getActive();
  if (activeDevice) return normalizeRelayUrl(activeDevice.relayUrl);
  throw new Error('请先在“设备”页面添加并选择设备');
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
  const value = applyMobileModifiers(String(data || ''));
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_TERMINAL_INPUT_TOTAL_BYTES) {
    showToast('单次输入不能超过 512 KiB，请拆分后重试');
    return false;
  }
  if (bytes.byteLength <= MAX_TERMINAL_INPUT_BYTES) {
    return sendWS({ type: 'terminal_input', sessionId, data: value });
  }
  const decoder = new TextDecoder();
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + MAX_TERMINAL_INPUT_BYTES, bytes.length);
    while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
    if (end === start) end = Math.min(start + MAX_TERMINAL_INPUT_BYTES, bytes.length);
    const chunk = decoder.decode(bytes.subarray(start, end));
    if (!sendWS({ type: 'terminal_input', sessionId, data: chunk })) return false;
    start = end;
  }
  return true;
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

function activeDeviceId() {
  return deviceRegistry.getActive()?.id || '';
}

function activeSessionStorageKey() {
  return activeDeviceId() ? `${LEGACY_ACTIVE_SESSION_KEY}:${activeDeviceId()}` : LEGACY_ACTIVE_SESSION_KEY;
}

function displaySessionTitle(session) {
  if (!session) return '未命名会话';
  return deviceRegistry.getSessionAlias(activeDeviceId(), session.id) || session.title || '未命名会话';
}

function pinnedSessionKey(sessionId) {
  return `${activeDeviceId()}:${sessionId}`;
}

function isSessionPinned(sessionId) {
  const scoped = pinnedSessionKey(sessionId);
  return clientSettings.pinnedSessionIds.includes(scoped) ||
    (!activeDeviceId() && clientSettings.pinnedSessionIds.includes(sessionId));
}

function formatLastConnected(value) {
  if (!value) return '尚未连接';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '尚未连接';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function deriveDeviceName(relayUrl) {
  try {
    return new URL(normalizeRelayUrl(relayUrl)).hostname || '我的设备';
  } catch {
    return '我的设备';
  }
}

function buildDeviceCard(device) {
  const selected = device.id === activeDeviceId();
  const relayConnected = selected && STATE.authenticated;
  const online = selected && STATE.authenticated && STATE.agentOnline;
  const card = document.createElement('article');
  card.className = `managed-device-card${selected ? ' active' : ''}`;
  card.dataset.deviceId = device.id;

  const head = document.createElement('div');
  head.className = 'device-card-head';
  const icon = document.createElement('div');
  icon.className = 'managed-device-icon';
  icon.innerHTML = `<span>&gt;_</span><i class="${online ? 'online' : ''}"></i>`;
  const title = document.createElement('div');
  title.className = 'device-card-title';
  const name = document.createElement('h2');
  name.textContent = device.name;
  const status = document.createElement('p');
  status.textContent = online
    ? '在线，可以操作终端'
    : (relayConnected ? '中转已连接，受控端离线' : (selected ? '当前设备，等待连接' : '已安全保存'));
  title.append(name, status);
  head.append(icon, title);
  if (selected) {
    const badge = document.createElement('span');
    badge.className = 'device-selected-badge';
    badge.textContent = '当前设备';
    head.appendChild(badge);
  }

  const endpoint = document.createElement('div');
  endpoint.className = 'device-endpoint';
  endpoint.textContent = device.relayUrl;

  const meta = document.createElement('div');
  meta.className = 'device-card-meta';
  const sessions = selected ? `${STATE.sessions.length} 个会话` : '会话按设备隔离';
  meta.append(
    Object.assign(document.createElement('span'), { textContent: sessions }),
    Object.assign(document.createElement('span'), { textContent: `最近：${formatLastConnected(device.lastConnectedAt)}` }),
  );

  const actions = document.createElement('div');
  actions.className = 'device-card-actions';
  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'device-select-button';
  select.textContent = selected && STATE.authenticated ? '正在使用' : (selected ? '连接设备' : '选择并连接');
  select.disabled = selected && STATE.authenticated;
  select.addEventListener('click', () => activateDevice(device.id));
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'device-edit-button';
  edit.textContent = '编辑';
  edit.addEventListener('click', () => openDeviceModal(device.id));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'device-delete-button';
  remove.textContent = '删除';
  remove.addEventListener('click', () => openDeviceDelete(device.id));
  actions.append(select, edit, remove);

  card.append(head, endpoint, meta, actions);
  return card;
}

function renderDesktopDeviceRail(devices = deviceRegistry.list()) {
  if (!desktopDeviceListEl) return;
  const activeId = activeDeviceId();
  const activeDevice = devices.find((device) => device.id === activeId);
  desktopActiveDeviceName.textContent = activeDevice?.name || '未选择设备';
  desktopDeviceListEl.innerHTML = '';

  if (devices.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'device-rail-empty';
    empty.textContent = '暂无设备';
    desktopDeviceListEl.appendChild(empty);
    return;
  }

  for (const device of devices) {
    const selected = device.id === activeId;
    const relayConnected = selected && STATE.authenticated;
    const online = relayConnected && STATE.agentOnline;
    const statusText = online ? 'Agent 在线' : (relayConnected ? 'Agent 离线' : (selected ? '等待连接' : '已保存'));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `device-rail-item${selected ? ' active' : ''}`;
    button.dataset.deviceId = device.id;
    button.setAttribute('role', 'listitem');
    button.setAttribute('aria-current', selected ? 'true' : 'false');
    button.setAttribute('aria-label', `${device.name}，${statusText}`);
    button.title = `${device.name}\n${statusText}\n${device.relayUrl}`;

    const avatar = document.createElement('span');
    avatar.className = 'device-rail-avatar';
    avatar.textContent = Array.from(device.name.trim())[0]?.toLocaleUpperCase() || '>';
    const dot = document.createElement('i');
    dot.className = `device-rail-status${online ? ' online' : (relayConnected ? ' relay' : '')}`;
    avatar.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'device-rail-name';
    name.textContent = device.name;
    button.append(avatar, name);

    button.addEventListener('click', () => {
      if (!selected) {
        activateDevice(device.id);
        return;
      }
      openTerminalPage();
      if (!activeDeviceToken) activeDeviceToken = readDeviceToken(device.id);
      if (!activeDeviceToken) {
        showToast('该设备缺少 Token，请编辑设备后连接');
        openDeviceModal(device.id);
      } else if (!STATE.authenticated) {
        wsClient.enableReconnect();
        wsClient.resetBackoff();
        connect();
      }
    });
    desktopDeviceListEl.appendChild(button);
  }
}

function renderDeviceList() {
  const devices = deviceRegistry.list(deviceSearchQuery);
  const allDevices = deviceRegistry.list();
  renderDesktopDeviceRail(allDevices);
  deviceListEl.innerHTML = '';
  for (const device of devices) deviceListEl.appendChild(buildDeviceCard(device));
  $('device-count-label').textContent = deviceSearchQuery
    ? `${devices.length} / ${allDevices.length} 台设备`
    : `${allDevices.length} 台设备`;
  deviceEmpty.classList.toggle('hidden', allDevices.length > 0 || !!deviceSearchQuery);
  deviceListEl.classList.toggle('hidden', allDevices.length === 0 && !deviceSearchQuery);
  if (allDevices.length > 0 && devices.length === 0) {
    const noMatch = document.createElement('div');
    noMatch.className = 'device-empty';
    noMatch.innerHTML = '<h2>没有找到设备</h2><p>试试设备名称或中转地址中的其他关键词。</p>';
    deviceListEl.appendChild(noMatch);
  }
}

function openDevicePage() {
  renderDeviceList();
  if (isMobileLayout()) setMobileView('device');
  else {
    mainScreen.dataset.desktopView = 'devices';
    requestAnimationFrame(() => deviceSearchInput?.focus());
  }
}

function openTerminalPage() {
  if (isMobileLayout()) {
    setMobileView(STATE.activeId ? 'terminal' : 'sessions');
    return;
  }
  mainScreen.dataset.desktopView = 'terminal';
  if (STATE.activeId) selectSession(STATE.activeId);
}

function closeDeviceModal() {
  deviceModal.classList.add('hidden');
  $('device-form-error').classList.add('hidden');
  $('device-pairing-input').value = '';
}

function openDeviceModal(deviceId = '') {
  const device = deviceId ? deviceRegistry.get(deviceId) : null;
  $('device-edit-id').value = device?.id || '';
  $('device-modal-title').textContent = device ? '编辑设备' : '添加设备';
  $('device-name-input').value = device?.name || '';
  $('device-relay-input').value = device?.relayUrl || nativeDefaultRelayUrl();
  $('device-token-input').value = '';
  $('device-token-input').required = !device;
  $('device-pairing-input').value = '';
  $('device-pairing-details').open = false;
  $('device-token-hint').textContent = device
    ? '留空继续使用已保存的 browserToken；输入新值会替换本机凭据。agentToken 用于远程电脑。'
    : '从阿里云获取同一台电脑的 browserToken；agentToken 填在远程电脑上。凭据使用系统安全存储。';
  $('device-save-btn').textContent = device ? '保存并重新连接' : '保存并连接';
  $('device-form-error').classList.add('hidden');
  deviceModal.classList.remove('hidden');
  requestAnimationFrame(() => $('device-name-input').focus());
}

$('device-pairing-import').addEventListener('click', () => {
  try {
    const profile = PairingProfile.parseProfile($('device-pairing-input').value, 'app');
    $('device-name-input').value = profile.name;
    $('device-relay-input').value = profile.relayUrl;
    $('device-token-input').value = profile.browserToken;
    $('device-pairing-input').value = '';
    $('device-pairing-details').open = false;
    $('device-form-error').classList.add('hidden');
    showToast('配对信息已填入，点击保存并连接');
  } catch (error) {
    $('device-form-error').textContent = error.message;
    $('device-form-error').classList.remove('hidden');
  }
});

function openDeviceDelete(deviceId) {
  const device = deviceRegistry.get(deviceId);
  if (!device) return;
  pendingDeleteDeviceId = deviceId;
  $('device-delete-text').textContent = `确认删除“${device.name}”？本机保存的 Token 和会话别名会一起清除，但不会删除远端会话。`;
  deviceDeleteModal.classList.remove('hidden');
}

function resetCurrentDeviceState() {
  cancelAgentOfflineTimers();
  for (const [id] of [...terminals]) disposeTerminal(id);
  STATE.clientId = null;
  STATE.authenticated = false;
  STATE.agentOnline = false;
  STATE.agentName = '';
  STATE.sessions = [];
  STATE.activeId = null;
  STATE.splitMode = false;
  sessionSearchQuery = '';
  sessionSearchInput.value = '';
  renderSessionList();
  updateActiveHeader();
  updateAgentStatus();
  historyBottomBtn.classList.add('hidden');
}

function activateDevice(deviceId, options = {}) {
  const device = deviceRegistry.get(deviceId);
  if (!device) return;
  wsClient.disconnect(1000, 'Switching device');
  resetCurrentDeviceState();
  deviceRegistry.select(deviceId);
  activeDeviceToken = readDeviceToken(deviceId);
  wsClient.enableReconnect();
  wsClient.resetBackoff();
  renderDeviceList();
  updateMobileOverview();
  if (isMobileLayout()) setMobileView(options.keepDevicePage ? 'device' : 'sessions');
  else mainScreen.dataset.desktopView = options.keepDevicePage ? 'devices' : 'terminal';
  if (!activeDeviceToken) {
    showToast('该设备缺少 Token，请编辑设备后连接');
    openDeviceModal(deviceId);
    return;
  }
  connect();
}

function migrateLegacyDevice() {
  if (deviceRegistry.list().length > 0) return;
  const legacyRelay = localStorage.getItem('remote-terminal-relay-url') || '';
  const legacyToken = sessionStorage.getItem(TOKEN_STORAGE_KEY) ||
    sessionStorage.getItem('claude-web-token') || readLegacySecureToken();
  if (!legacyRelay && !legacyToken) return;
  const id = uuid();
  let relayUrl;
  try {
    relayUrl = normalizeRelayUrl(legacyRelay || nativeDefaultRelayUrl());
  } catch {
    relayUrl = normalizeRelayUrl(nativeDefaultRelayUrl());
  }
  deviceRegistry.add({ id, name: deriveDeviceName(relayUrl), relayUrl, createdAt: Date.now() });
  if (browserTokenIsValid(legacyToken)) writeDeviceToken(id, legacyToken);
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  sessionStorage.removeItem('claude-web-token');
  localStorage.removeItem('remote-terminal-relay-url');
}

function updateMobileOverview() {
  const sessionCount = STATE.sessions.length;
  const runningCount = STATE.sessions.filter((session) => session.status === 'running').length;
  const device = deviceRegistry.getActive();
  const displayName = device?.name || '尚未添加设备';

  $('mobile-session-count').textContent = `${sessionCount} 个会话`;
  $('mobile-agent-title').textContent = STATE.agentOnline ? `${displayName} 已连接` : displayName;
  $('mobile-agent-subtitle').textContent = !device
    ? '点此添加并选择设备'
    : STATE.agentOnline
    ? `${runningCount} 个会话正在运行`
    : STATE.authenticated
    ? '阿里云中转已连接，等待远程电脑启动 Agent'
    : '尚未连接阿里云中转，点此检查地址和 APP Token';
  $('mobile-agent-dot').className = `status-dot ${STATE.agentOnline ? 'online' : 'offline'}`;
  mobileAgentBanner.classList.toggle('online', STATE.agentOnline);

  const active = STATE.sessions.find((session) => session.id === STATE.activeId);
  mobileCommandSend.disabled = !STATE.authenticated || !active || active.status === 'exited';
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
    // Android WebView、后台 Electron 窗口和快速视图切换时，rAF 可能暂停；
    // 统一走带定时器兜底的适配队列，避免终端长期沿用上一个页面的网格尺寸。
    scheduleFitTerminal(STATE.activeId, options.focusTerminal);
  } else {
    document.activeElement?.blur?.();
    syncVisibleSubscriptions();
  }

  updateMobileOverview();
  setNativeSystemBarStyle(next === 'terminal' ? 'dark' : 'light');
}

function handleMobileBack() {
  if (!isMobileLayout() || mainScreen.classList.contains('hidden')) return false;
  for (const modal of [deviceModal, deviceDeleteModal, sessionRenameModal, pasteModal,
    sessionActionsModal, settingsModal, deleteModal]) {
    if (!modal.classList.contains('hidden')) {
      modal.classList.add('hidden');
      if (modal === deviceDeleteModal) pendingDeleteDeviceId = '';
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
  scheduleFitTerminal(STATE.activeId);
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
  $('setting-font-size').value = String(clientSettings.fontSize);
  $('setting-scrollback').value = String(clientSettings.scrollback);
  $('setting-cursor-blink').checked = clientSettings.cursorBlink;
  $('setting-mobile-keybar').checked = clientSettings.showMobileKeybar;
  $('setting-paste-confirm').checked = clientSettings.confirmLargePaste;
  $('settings-security-hint').textContent = supportsSecureCredentials()
    ? '每台设备的 Token 均由系统安全凭据存储独立保护。设备地址和显示设置保存在本机。'
    : '当前系统未提供可靠的安全凭据存储；Token 只保留到本次关闭软件。';
  settingsModal.classList.remove('hidden');
}

function saveSettings() {
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
  showToast('设置已保存');
}

function togglePinnedSession(sessionId) {
  const pinned = new Set(clientSettings.pinnedSessionIds);
  const key = pinnedSessionKey(sessionId);
  if (pinned.has(key)) pinned.delete(key);
  else pinned.add(key);
  clientSettings = clientSettingsStore.update({ pinnedSessionIds: [...pinned] });
  renderSessionList();
}

function openSessionActions() {
  if (!STATE.activeId) return;
  const pinned = isSessionPinned(STATE.activeId);
  $('action-pin-session').textContent = pinned ? '取消置顶' : '置顶会话';
  sessionActionsModal.classList.remove('hidden');
}

function openSessionRename() {
  const session = STATE.sessions.find((item) => item.id === STATE.activeId);
  if (!session) return;
  sessionRenameInput.value = displaySessionTitle(session);
  sessionActionsModal.classList.add('hidden');
  sessionRenameModal.classList.remove('hidden');
  requestAnimationFrame(() => {
    sessionRenameInput.focus();
    sessionRenameInput.select();
  });
}

mobileBackBtn?.addEventListener('click', () => setMobileView('sessions'));
mobileSessionMoreBtn?.addEventListener('click', openSessionActions);
mobileAgentBanner?.addEventListener('click', openDevicePage);
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
  if (sendTerminalInput(STATE.activeId, `${command}\r`)) {
    mobileCommandInput.value = '';
  } else {
    showToast('连接尚未就绪，命令已保留');
  }
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
  const device = deviceRegistry.getActive();
  if (device) activateDevice(device.id, { keepDevicePage: true });
  showToast('正在重新连接…');
});
$('mobile-connection-settings-btn')?.addEventListener('click', openSettings);
$('mobile-open-settings')?.addEventListener('click', openSettings);
$('mobile-open-connection')?.addEventListener('click', openDevicePage);
$('mobile-logout-btn')?.addEventListener('click', logoutClient);
$('desktop-devices-btn')?.addEventListener('click', () => {
  if (mainScreen.dataset.desktopView === 'devices') openTerminalPage();
  else openDevicePage();
});
$('desktop-device-back')?.addEventListener('click', openTerminalPage);
$('desktop-rail-add-device')?.addEventListener('click', () => openDeviceModal());
$('add-device-btn')?.addEventListener('click', () => openDeviceModal());
$('device-empty-add')?.addEventListener('click', () => openDeviceModal());
deviceSearchInput?.addEventListener('input', () => {
  deviceSearchQuery = deviceSearchInput.value;
  renderDeviceList();
});
$('device-modal-close')?.addEventListener('click', closeDeviceModal);
$('device-modal-cancel')?.addEventListener('click', closeDeviceModal);
deviceForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const editingId = $('device-edit-id').value;
  const token = $('device-token-input').value.trim();
  let relayUrl;
  try {
    relayUrl = normalizeRelayUrl($('device-relay-input').value);
    const name = $('device-name-input').value.trim() || deriveDeviceName(relayUrl);
    if (token) requireValidBrowserToken(token);
    if (editingId) {
      if (!token && !readDeviceToken(editingId)) throw new Error('请填写该设备的访问 Token');
      deviceRegistry.update(editingId, { name, relayUrl });
      if (token) writeDeviceToken(editingId, token);
      closeDeviceModal();
      activateDevice(editingId);
    } else {
      if (!token) throw new Error('请填写该设备的访问 Token');
      const deviceId = uuid();
      deviceRegistry.add({ id: deviceId, name, relayUrl, createdAt: Date.now() });
      writeDeviceToken(deviceId, token);
      closeDeviceModal();
      activateDevice(deviceId);
    }
  } catch (error) {
    $('device-form-error').textContent = error.message || '设备信息保存失败';
    $('device-form-error').classList.remove('hidden');
  }
});
$('device-delete-cancel')?.addEventListener('click', () => {
  pendingDeleteDeviceId = '';
  deviceDeleteModal.classList.add('hidden');
});
$('device-delete-confirm')?.addEventListener('click', () => {
  const deletingId = pendingDeleteDeviceId;
  pendingDeleteDeviceId = '';
  deviceDeleteModal.classList.add('hidden');
  if (!deletingId) return;
  const wasActive = deletingId === activeDeviceId();
  if (wasActive) wsClient.disconnect(1000, 'Device removed');
  clearDeviceToken(deletingId);
  localStorage.removeItem(`${LEGACY_ACTIVE_SESSION_KEY}:${deletingId}`);
  const pinPrefix = `${deletingId}:`;
  if (clientSettings.pinnedSessionIds.some((item) => item.startsWith(pinPrefix))) {
    clientSettings = clientSettingsStore.update({
      pinnedSessionIds: clientSettings.pinnedSessionIds.filter((item) => !item.startsWith(pinPrefix)),
    });
  }
  deviceRegistry.remove(deletingId);
  if (wasActive) {
    resetCurrentDeviceState();
    const next = deviceRegistry.getActive();
    if (next) activateDevice(next.id, { keepDevicePage: true });
    else {
      activeDeviceToken = '';
      openDevicePage();
    }
  }
  renderDeviceList();
  updateMobileOverview();
  showToast('设备已删除');
});
$('action-rename-session')?.addEventListener('click', openSessionRename);
renameSessionBtn?.addEventListener('click', openSessionRename);
$('session-rename-cancel')?.addEventListener('click', () => sessionRenameModal.classList.add('hidden'));
$('session-rename-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!STATE.activeId || !activeDeviceId()) return;
  try {
    deviceRegistry.setSessionAlias(activeDeviceId(), STATE.activeId, sessionRenameInput.value);
    sessionRenameModal.classList.add('hidden');
    renderSessionList();
    updateActiveHeader();
    showToast('会话名称已保存到本机');
  } catch (error) {
    showToast(error.message || '会话重命名失败');
  }
});
historyBottomBtn?.addEventListener('click', () => {
  const entry = STATE.activeId && terminals.get(STATE.activeId);
  entry?.term?.scrollToBottom();
  historyBottomBtn.classList.add('hidden');
});
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
const getToken = () => activeDeviceToken;

const wsClient = new StrictWebSocket.StrictWebSocketClient({
  createSocket: (url) => new WebSocket(url),
  getUrl: () => {
    return getRelayUrl();
  },
  getToken,
  onMessage: handleMessage,
  onDisconnect: () => {
    STATE.authenticated = false;
    STATE.agentOnline = false;
    markAllTerminalsUnsubscribed();
    updateAgentStatus();
    renderDeviceList();
  },
  onNoToken: () => updateMobileOverview(),
  onError: () => {
    if (activeDeviceId() && !STATE.authenticated) showToast('设备连接失败，正在自动重试');
  },
  handshakeTimeoutMs: 15000,
});

function sendWS(obj) {
  return wsClient.send(obj);
}

// ── WebSocket ──────────────────────────────────────────────────
function connect() {
  if (!activeDeviceId() || !getToken()) return false;
  return wsClient.connect();
}

// ── 消息分发 ───────────────────────────────────────────────────
function handleMessage(data) {
  switch (data.type) {
    case 'auth_ok':
      if (data.role !== 'browser') return;
      wsClient.markAuthenticated();
      STATE.authenticated = true;
      STATE.clientId = cleanClientText(data.clientId, '', 128);
      STATE.agentOnline = data.agentOnline === true;
      STATE.agentName = cleanClientText(data.agentName, '', 120);
      STATE.sessions = normalizeSessionList(data.sessions);
      {
        const device = deviceRegistry.getActive();
        try {
          if (device) deviceRegistry.update(device.id, { lastConnectedAt: Date.now() });
        } catch { /* a storage quota error must not break an authenticated session */ }
      }
      if (STATE.agentOnline) cancelAgentOfflineTimers();
      showMain();
      reconcileTerminals();
      renderSessionList();
      updateAgentStatus();
      restoreActive();
      syncVisibleSubscriptions();
      renderDeviceList();
      break;

    case 'error':
      if (!STATE.authenticated) {
        wsClient.disableReconnect();
        const serverMessage = cleanClientText(data.message, '设备认证失败，请检查 APP 访问 Token', 1000);
        const tokenRejected = /invalid token/i.test(serverMessage);
        const message = tokenRejected
          ? 'APP 访问 Token 无效。请填写这台电脑的 browserToken，并确认阿里云配置已生效。'
          : serverMessage;
        if (tokenRejected) {
          clearDeviceToken(activeDeviceId());
          activeDeviceToken = '';
        }
        showToast(message);
        renderDeviceList();
        const device = deviceRegistry.getActive();
        if (device && tokenRejected) openDeviceModal(device.id);
      } else showToast(cleanClientText(data.message, 'Agent 错误', 1000));
      break;

    case 'pong':
      break;

    case 'agent_status':
      if (data.online !== true) {
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
        if (data.agentName) STATE.agentName = cleanClientText(data.agentName, STATE.agentName, 120);
        updateAgentStatus();
      }
      break;

    case 'sessions':
      STATE.sessions = normalizeSessionList(data.sessions);
      reconcileTerminals();
      if (!STATE.activeId && STATE.sessions.length > 0) restoreActive();
      renderSessionList();
      updateActiveHeader();
      if (STATE.splitMode) refreshTileView();
      syncVisibleSubscriptions();
      break;

    case 'terminal_created': {
      const session = normalizeSession({
        id: data.sessionId,
        title: data.title,
        cwd: data.cwd,
        pid: data.pid,
        status: data.status,
        createdAt: data.createdAt,
      });
      if (!session) break;
      upsertSession(session);
      renderSessionList();
      selectSession(data.sessionId);
      if (STATE.splitMode) refreshTileView();
      break;
    }

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
      if (!validSessionId(data.sessionId)) break;
      markStatus(data.sessionId, 'exited');
      writeLocalOutput(data.sessionId, `\r\n\x1b[33m[进程退出 code=${Number.isInteger(data.exitCode) ? data.exitCode : 'unknown'}]\x1b[0m\r\n`);
      break;

    case 'terminal_closed':
      if (!validSessionId(data.sessionId)) break;
      removeSession(data.sessionId);
      if (STATE.splitMode) refreshTileView();
      break;

    case 'terminal_error': {
      const message = cleanClientText(data.message, '操作失败', 1000);
      if (validSessionId(data.sessionId) && terminals.has(data.sessionId)) {
        writeLocalOutput(data.sessionId, `\r\n\x1b[31m[错误] ${message}\x1b[0m\r\n`);
      } else {
        showToast(message);
      }
      break;
    }
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
  if (activeDeviceId()) {
    try { deviceRegistry.setSessionAlias(activeDeviceId(), id, ''); } catch {}
  }
  const pinKey = pinnedSessionKey(id);
  if (clientSettings.pinnedSessionIds.includes(pinKey)) {
    clientSettings = clientSettingsStore.update({
      pinnedSessionIds: clientSettings.pinnedSessionIds.filter((item) => item !== pinKey),
    });
  }
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
        localStorage.setItem(activeSessionStorageKey(), next.id);
      } else {
        localStorage.removeItem(activeSessionStorageKey());
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
  if (t.fitFrame) cancelAnimationFrame(t.fitFrame);
  if (t.fitTimer) clearTimeout(t.fitTimer);
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
    localStorage.removeItem(activeSessionStorageKey());
    localStorage.removeItem('claude-web-active');
    const next = STATE.sessions.find(s => s.status === 'running');
    if (isMobileLayout()) {
      if (next) {
        STATE.activeId = next.id;
        localStorage.setItem(activeSessionStorageKey(), next.id);
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
    localStorage.removeItem(activeSessionStorageKey());
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
    scrollSensitivity: 1,
    fastScrollSensitivity: 5,
    scrollOnUserInput: false,
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
  term.onScroll(() => scheduleHistoryButtonUpdate(sessionId));

  // Ctrl+V / Cmd+V: 拦截浏览器默认粘贴，改为读取纯文本
  term.attachCustomKeyEventHandler((e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'v' && e.type === 'keydown') {
      if (e.shiftKey) return true;
      pasteFromClipboard(sessionId);
      return false;
    }
    return true;
  });

  // ResizeObserver：容器尺寸变化时自动 fit，解决窗口缩放与分屏切换后不铺满的问题。
  const observer = new ResizeObserver(() => {
    const t = terminals.get(sessionId);
    if (!t || t.container.style.display === 'none') return;
    scheduleFitTerminal(sessionId);
  });
  observer.observe(container);

  const stream = new TerminalStream.TerminalStreamController(term, {
    maxPendingBytes: 512 * 1024,
    onResync: () => requestTerminalResync(sessionId),
    onSnapshotApplied: () => {
      const current = terminals.get(sessionId);
      if (!current || current.container.style.display === 'none') return;
      // 快照带有远端 PTY 尺寸，应用时会暂时 resize xterm；随后必须按当前
      // 窗口重新 fit。后台窗口的 rAF 可能暂停，因此仍使用带定时器兜底的队列。
      scheduleFitTerminal(sessionId);
      scheduleHistoryButtonUpdate(sessionId);
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
    fitFrame: 0,
    fitTimer: 0,
    fitFocus: false,
    lastSentCols: 0,
    lastSentRows: 0,
    lastActivity: 0,
    historyWarningShown: false,
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
  if (data.historyTruncated && !t.historyWarningShown) {
    t.historyWarningShown = true;
    showToast('该会话内容较多，当前已加载服务器保留的最近历史');
  }
  t.stream.applySnapshot(data);
  scheduleHistoryButtonUpdate(data.sessionId);
}

function updateHistoryButton(sessionId = STATE.activeId) {
  const entry = sessionId && terminals.get(sessionId);
  if (!entry || sessionId !== STATE.activeId || entry.container.style.display === 'none') {
    historyBottomBtn.classList.add('hidden');
    return;
  }
  const buffer = entry.term.buffer.active;
  historyBottomBtn.classList.toggle('hidden', buffer.viewportY >= buffer.baseY);
}

function scheduleHistoryButtonUpdate(sessionId = STATE.activeId) {
  if (sessionId !== STATE.activeId) return;
  if (historyButtonFrame) cancelAnimationFrame(historyButtonFrame);
  historyButtonFrame = requestAnimationFrame(() => {
    historyButtonFrame = 0;
    updateHistoryButton(sessionId);
  });
}

function requestTerminalResync(sessionId) {
  const t = terminals.get(sessionId);
  if (!t || !t.subscribed || !STATE.authenticated) return;
  sendWS({ type: 'terminal_resync', sessionId });
}

function markAllTerminalsUnsubscribed() {
  for (const [id, t] of terminals) {
    t.subscribed = false;
    t.lastSentCols = 0;
    t.lastSentRows = 0;
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

/** 执行终端 fit，并且仅在网格尺寸变化时通知 Agent。 */
function fitTerminal(sessionId) {
  const t = terminals.get(sessionId);
  if (!t || t.container.style.display === 'none' || t.container.clientWidth <= 0 || t.container.clientHeight <= 0) return false;
  try {
    const proposed = t.fit.proposeDimensions();
    if (!proposed || !Number.isInteger(proposed.cols) || !Number.isInteger(proposed.rows)) return false;
    if (t.term.cols !== proposed.cols || t.term.rows !== proposed.rows) t.fit.fit();
    if (t.subscribed && (t.lastSentCols !== t.term.cols || t.lastSentRows !== t.term.rows) &&
        sendWS({ type: 'terminal_resize', sessionId, cols: t.term.cols, rows: t.term.rows })) {
      t.lastSentCols = t.term.cols;
      t.lastSentRows = t.term.rows;
    }
    return true;
  } catch { return false; }
}

/** 合并同一帧内的多次布局变化，并在浏览器完成两轮布局后再 fit。 */
function scheduleFitTerminal(sessionId, focus = false) {
  const t = terminals.get(sessionId);
  if (!t) return;
  t.fitFocus = t.fitFocus || focus;
  // 已有任务时直接合并；执行时读取最新容器尺寸，避免 ResizeObserver
  // 高频触发不断取消前一任务，造成终端永远无法完成 fit。
  if (t.fitFrame || t.fitTimer) return;
  const run = () => {
    if (t.fitFrame) cancelAnimationFrame(t.fitFrame);
    if (t.fitTimer) clearTimeout(t.fitTimer);
    t.fitFrame = 0;
    t.fitTimer = 0;
    const shouldFocus = t.fitFocus;
    t.fitFocus = false;
    if (fitTerminal(sessionId) && shouldFocus) t.term.focus();
  };
  // 可见窗口优先在两轮布局后执行；后台恢复或 WebView 暂停 rAF 时，
  // 50ms 定时器保证任务不会永久卡住。
  t.fitTimer = setTimeout(run, 50);
  t.fitFrame = requestAnimationFrame(() => {
    if (!t.fitTimer) return;
    t.fitFrame = requestAnimationFrame(run);
  });
}

// ── 选择 / 切换会话 ────────────────────────────────────────────
function selectSession(sessionId) {
  if (!STATE.sessions.find((s) => s.id === sessionId)) return;
  STATE.activeId = sessionId;
  localStorage.setItem(activeSessionStorageKey(), sessionId);
  localStorage.removeItem('claude-web-active');

  if (isMobileLayout()) {
    STATE.splitMode = false;
    setMobileView('terminal');
  } else if (STATE.splitMode) {
    mainScreen.dataset.desktopView = 'terminal';
    refreshTileView();
    const entry = terminals.get(sessionId);
    if (entry) entry.term.focus();
  } else {
    mainScreen.dataset.desktopView = 'terminal';
    // 单屏模式：只显示当前终端
    emptyHint.style.display = 'none';
    for (const [id, t] of terminals) {
      t.container.style.display = id === sessionId ? 'block' : 'none';
    }
    const entry = ensureTerminal(sessionId);
    entry.container.style.display = 'block';
    syncVisibleSubscriptions();
    scheduleFitTerminal(sessionId, true);
  }

  renderSessionList();
  updateActiveHeader();
  scheduleHistoryButtonUpdate(sessionId);
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
    terminalsEl.style.gridTemplateColumns = '';
    for (const [, t] of terminals) {
      t.container.style.display = 'none';
      t.container.classList.remove('active-tile');
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
  else if (visibleSessions.length >= 2) cols = 2;
  terminalsEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

  for (const s of visibleSessions) {
    ensureTerminal(s.id);
  }

  for (const [id, t] of terminals) {
    if (visibleSessions.some((s) => s.id === id)) {
      t.container.style.display = 'block';
      t.container.classList.toggle('active-tile', id === STATE.activeId);
    } else {
      t.container.style.display = 'none';
      t.container.classList.remove('active-tile');
    }
  }

  syncVisibleSubscriptions();

  for (const s of visibleSessions) scheduleFitTerminal(s.id);
}

function restoreActive() {
  const saved = localStorage.getItem(activeSessionStorageKey()) ||
    localStorage.getItem(LEGACY_ACTIVE_SESSION_KEY) || localStorage.getItem('claude-web-active');
  const target = STATE.sessions.find((s) => s.id === saved) || STATE.sessions[0];
  if (target && isMobileLayout()) {
    STATE.activeId = target.id;
    localStorage.setItem(activeSessionStorageKey(), target.id);
    localStorage.removeItem(LEGACY_ACTIVE_SESSION_KEY);
    updateActiveHeader();
    renderSessionList();
    // 后台重连和重新鉴权只恢复会话数据，不得覆盖用户当前所在页面。
    // 首次启动时 mobileView 默认为 sessions；主动选择设备时
    // activateDevice() 已经设置了期望页面，因此这里保留现状即可。
    setMobileView(mobileView);
  } else if (target) {
    selectSession(target.id);
  } else {
    STATE.activeId = null;
    localStorage.removeItem(activeSessionStorageKey());
    localStorage.removeItem('claude-web-active');
    updateActiveHeader();
    if (isMobileLayout()) setMobileView(mobileView);
  }
}

// ── 新建 / 删除 ────────────────────────────────────────────────
function newSession() {
  if (!STATE.agentOnline) return showToast('Agent 离线，无法创建会话');
  const now = new Date();
  const title = '终端 ' + String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  const id = uuid();
  if (!sendWS({ type: 'terminal_create', sessionId: id, title })) {
    showToast('连接尚未就绪，暂时无法创建会话');
  }
}

function openDeleteModal() {
  if (!STATE.activeId) return;
  const s = STATE.sessions.find((x) => x.id === STATE.activeId);
  deleteModalText.textContent = `确认删除会话「${displaySessionTitle(s)}」？终端进程将被终止。`;
  deleteModal.classList.remove('hidden');
}
function confirmDelete() {
  const id = STATE.activeId;
  if (!id) return;
  if (sendWS({ type: 'terminal_delete', sessionId: id })) {
    deleteModal.classList.add('hidden');
  } else {
    showToast('连接尚未就绪，会话尚未删除');
  }
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
  return STATE.sessions
    .map((session, index) => ({ session, index }))
    .filter(({ session }) => !query || `${displaySessionTitle(session)}\n${session.title || ''}\n${session.cwd || ''}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(isSessionPinned(b.session.id)) - Number(isSessionPinned(a.session.id)) ||
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

  li.setAttribute('aria-label', `${displaySessionTitle(s)}，${statusText(s.status)}`);

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
  titleEl.textContent = displaySessionTitle(s);
  meta.appendChild(titleEl);
  const cwdEl = document.createElement('span');
  cwdEl.className = 's-cwd';
  cwdEl.textContent = [statusText(s.status), shortPath(s.cwd)].filter(Boolean).join(' · ');
  meta.appendChild(cwdEl);
  li.appendChild(meta);

  const pin = document.createElement('button');
  const isPinned = isSessionPinned(s.id);
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
    localStorage.setItem(activeSessionStorageKey(), s.id);
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
    renameSessionBtn.disabled = true;
    mobileSessionMoreBtn.disabled = true;
    if (terminals.size === 0) emptyHint.style.display = '';
    updateMobileOverview();
    return;
  }
  activeTitle.textContent = displaySessionTitle(s);
  activeCwd.textContent = s.cwd || '';
  activeStatus.textContent = statusText(s.status);
  activeStatus.className = 'badge ' + (s.status === 'running' ? 'ok' : 'warn');
  deleteBtn.disabled = false;
  renameSessionBtn.disabled = false;
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
  renderDesktopDeviceRail();
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
// ── 屏幕切换 ───────────────────────────────────────────────────
function showMain() {
  mainScreen.classList.remove('hidden');
  if (isMobileLayout()) setMobileView(mobileView);
  // 启动 activity 刷新定时器
  ensureActivityTimer();
}

function logoutClient() {
  wsClient.disableReconnect();
  wsClient.disconnect(1000, 'Device disconnected');
  activeDeviceToken = '';
  resetCurrentDeviceState();
  settingsModal.classList.add('hidden');
  showMain();
  renderDeviceList();
  openDevicePage();
  showToast('已断开当前设备；本机保存的设备信息仍然保留');
}

// ── 事件 ───────────────────────────────────────────────────────
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
  clientSettings = clientSettingsStore.reset();
  applyClientSettings();
  openSettings();
  showToast('显示和交互设置已恢复默认；设备与 Token 未改变');
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

for (const modal of [settingsModal, pasteModal, sessionActionsModal, deleteModal,
  deviceModal, deviceDeleteModal, sessionRenameModal]) {
  modal.addEventListener('click', (event) => {
    if (event.target !== modal) return;
    modal.classList.add('hidden');
    if (modal === deviceModal) $('device-form-error').classList.add('hidden');
    if (modal === deviceDeleteModal) pendingDeleteDeviceId = '';
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
    deviceModal.classList.add('hidden');
    deviceDeleteModal.classList.add('hidden');
    sessionRenameModal.classList.add('hidden');
    pendingDeleteDeviceId = '';
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
      if (t.container.style.display !== 'none') scheduleFitTerminal(id);
    }
  } else {
    if (STATE.activeId) scheduleFitTerminal(STATE.activeId);
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
  if (document.visibilityState === 'visible' && activeDeviceId() && getToken()) connect();
});

// 心跳
setInterval(() => {
  if (STATE.authenticated) sendWS({ type: 'ping' });
}, 30000);

// ── 启动 ───────────────────────────────────────────────────────
window.RemoteTerminalApp = Object.freeze({
  handleBack: handleMobileBack,
  onViewportChanged: handleMobileViewportChanged,
  onResume: () => {
    handleMobileViewportChanged();
    if (activeDeviceId() && getToken()) {
      wsClient.enableReconnect();
      connect();
    }
  },
  showSessions: () => setMobileView('sessions'),
});

function getClientVersion() {
  try {
    return packagedConfig.appVersion || window.RemoteTerminalNative?.getClientVersion?.() || CLIENT_UI_VERSION;
  } catch {
    return CLIENT_UI_VERSION;
  }
}

try {
  migrateLegacyDevice();
} catch (error) {
  console.warn('Legacy device migration skipped:', error);
}

applyClientSettings();
showMain();
$('mobile-client-version').textContent = getClientVersion();
renderDeviceList();
updateMobileOverview();
const startupDevice = deviceRegistry.getActive();
if (startupDevice) {
  activeDeviceToken = readDeviceToken(startupDevice.id);
  if (activeDeviceToken) connect();
  else openDevicePage();
} else {
  openDevicePage();
}
