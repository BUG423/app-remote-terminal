const { app, BrowserWindow, ipcMain, safeStorage, session } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
let mainWindow = null;

const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024;
const MAX_CREDENTIALS = 100;
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);

if (process.env.REMOTE_TERMINAL_SMOKE === '1' && process.env.REMOTE_TERMINAL_SMOKE_USER_DATA) {
  app.setPath('userData', process.env.REMOTE_TERMINAL_SMOKE_USER_DATA);
}

function credentialPath() {
  return path.join(app.getPath('userData'), 'credential.bin');
}

function secureStorageAvailable() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
  } catch { return false; }
}

function validCredentialId(value) {
  return typeof value === 'string' && !RESERVED_IDS.has(value) &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function validToken(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 512 &&
    Buffer.byteLength(value, 'utf8') <= 1024 &&
    !/change-me|deprecated|your-token|shared-secret/i.test(value);
}

function sanitizeCredentialMap(value) {
  const result = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [id, token] of Object.entries(value).slice(0, MAX_CREDENTIALS)) {
    if (validCredentialId(id) && validToken(token)) result[id] = token;
  }
  return result;
}

function readCredentialMap() {
  if (!secureStorageAvailable()) return {};
  try {
    const stat = fs.lstatSync(credentialPath());
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > MAX_CREDENTIAL_FILE_BYTES) return {};
    const plaintext = safeStorage.decryptString(fs.readFileSync(credentialPath()));
    try {
      const parsed = JSON.parse(plaintext);
      if (parsed?.version === 2) {
        return sanitizeCredentialMap(parsed.credentials);
      }
    } catch {
      // Fall through to the legacy single-token migration below.
    }
    // 0.2.x stored one encrypted token. It may itself happen to be valid JSON.
    return validToken(plaintext) ? { legacy: plaintext } : {};
  } catch { return {}; }
}

function writeCredentialMap(credentials) {
  if (!secureStorageAvailable()) return false;
  const target = credentialPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(target), 0o700); } catch {}
  const normalized = sanitizeCredentialMap(credentials);
  const payload = JSON.stringify({ version: 2, credentials: normalized });
  const encrypted = safeStorage.encryptString(payload);
  if (encrypted.byteLength > MAX_CREDENTIAL_FILE_BYTES) return false;
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, encrypted);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, target);
    try { fs.chmodSync(target, 0o600); } catch {}
    return true;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    console.warn('Unable to persist credentials:', error.message);
    return false;
  }
}

function readCredential() {
  return readCredentialMap().legacy || '';
}

function readDeviceCredential(deviceId) {
  if (!validCredentialId(deviceId)) return '';
  return readCredentialMap()[deviceId] || '';
}

function writeDeviceCredential(deviceId, token) {
  if (!validCredentialId(deviceId) || !validToken(token)) return false;
  const credentials = readCredentialMap();
  credentials[deviceId] = token;
  delete credentials.legacy;
  return writeCredentialMap(credentials);
}

function clearDeviceCredential(deviceId) {
  if (!validCredentialId(deviceId)) return false;
  const credentials = readCredentialMap();
  delete credentials[deviceId];
  if (Object.keys(credentials).length === 0) return clearCredential();
  return writeCredentialMap(credentials);
}

function clearCredential() {
  try {
    fs.unlinkSync(credentialPath());
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Unable to clear credential:', error.message);
    return error.code === 'ENOENT';
  }
}

function uiEntryPath() {
  return path.join(__dirname, 'ui', 'www', 'index.html');
}

function trustedIpcEvent(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents ||
      !event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    return url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === path.resolve(uiEntryPath());
  } catch {
    return false;
  }
}

function reply(event, fallback, action) {
  if (!trustedIpcEvent(event)) {
    event.returnValue = fallback;
    return;
  }
  try { event.returnValue = action(); } catch { event.returnValue = fallback; }
}

function registerCredentialIpc() {
  ipcMain.on('remote-terminal:credential-supported', (event) => reply(event, false, secureStorageAvailable));
  ipcMain.on('remote-terminal:credential-read', (event) => reply(event, '', readCredential));
  ipcMain.on('remote-terminal:device-credential-read', (event, deviceId) => {
    reply(event, '', () => readDeviceCredential(deviceId));
  });
  ipcMain.on('remote-terminal:device-credential-write', (event, deviceId, token) => {
    reply(event, false, () => writeDeviceCredential(deviceId, token));
  });
  ipcMain.on('remote-terminal:device-credential-clear', (event, deviceId) => {
    reply(event, false, () => clearDeviceCredential(deviceId));
  });
  ipcMain.on('remote-terminal:app-version', (event) => reply(event, '', () => app.getVersion()));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 760, minHeight: 520, show: false,
    title: 'Remote Terminal', autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      navigateOnDragDrop: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
    }
  });
  mainWindow = win;
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-redirect', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  if (process.env.REMOTE_TERMINAL_SMOKE === '1') {
    win.webContents.once('did-finish-load', async () => {
      try {
        const ready = await win.webContents.executeJavaScript(
          `(function () {
            const main = document.getElementById('main-screen');
            const add = document.getElementById('add-device-btn');
            const modal = document.getElementById('device-modal');
            const cancel = document.getElementById('device-modal-cancel');
            const ready = document.readyState === 'complete' && !!main &&
              !main.classList.contains('hidden') && main.dataset.desktopView === 'devices' &&
              !document.getElementById('login-screen') &&
              typeof ClientSettings?.ClientSettingsStore === 'function' &&
              typeof DeviceStore?.DeviceRegistry === 'function';
            if (!ready) return false;
            add.click();
            const opened = !modal.classList.contains('hidden') &&
              document.getElementById('device-relay-input').value.startsWith('wss://');
            const pairing = document.getElementById('device-pairing-input');
            pairing.value = JSON.stringify({
              type: 'remote-terminal-app', version: 1, name: '配对测试电脑',
              relayUrl: 'wss://relay.example.cn', browserToken: 'smoke-browser-' + 'x'.repeat(32)
            });
            document.getElementById('device-pairing-import').click();
            const paired = document.getElementById('device-name-input').value === '配对测试电脑' &&
              document.getElementById('device-relay-input').value === 'wss://relay.example.cn/' &&
              document.getElementById('device-token-input').value.startsWith('smoke-browser-') && pairing.value === '';
            pairing.value = JSON.stringify({
              type: 'remote-terminal-agent', version: 1,
              serverUrl: 'wss://relay.example.cn', agentToken: 'smoke-agent-' + 'y'.repeat(32)
            });
            document.getElementById('device-pairing-import').click();
            const rejectedAgentProfile = !document.getElementById('device-form-error').classList.contains('hidden') &&
              document.getElementById('device-token-input').value.startsWith('smoke-browser-');
            document.getElementById('device-name-input').value = 'Security smoke';
            document.getElementById('device-relay-input').value = 'ws://public.example.cn';
            document.getElementById('device-token-input').value = 'must-not-persist';
            document.getElementById('device-form').requestSubmit();
            const rejectedInsecureEndpoint = !document.getElementById('device-form-error').classList.contains('hidden') &&
              !(localStorage.getItem('remote-terminal-devices-v1') || '').includes('must-not-persist');
            cancel.click();
            return opened && paired && rejectedAgentProfile && rejectedInsecureEndpoint &&
              modal.classList.contains('hidden') && pairing.value === '';
          })()`,
        );
        console.log(ready ? 'DESKTOP_SMOKE_OK' : 'DESKTOP_SMOKE_FAILED');
        app.exit(ready ? 0 : 1);
      } catch (error) {
        console.error('DESKTOP_SMOKE_FAILED', error.message);
        app.exit(1);
      }
    });
  }
  win.loadFile(uiEntryPath());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    app.setName('Remote Terminal');
    registerCredentialIpc();
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', (event) => event.preventDefault());
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    );
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
