const { app, BrowserWindow, ipcMain, safeStorage, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
let mainWindow = null;

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
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function readCredentialMap() {
  if (!secureStorageAvailable()) return {};
  try {
    const plaintext = safeStorage.decryptString(fs.readFileSync(credentialPath()));
    try {
      const parsed = JSON.parse(plaintext);
      if (parsed?.version === 2 && parsed.credentials && typeof parsed.credentials === 'object') {
        return Object.fromEntries(Object.entries(parsed.credentials).filter(
          ([id, token]) => validCredentialId(id) && typeof token === 'string' && token.length <= 4096,
        ));
      }
    } catch {
      // Fall through to the legacy single-token migration below.
    }
    // 0.2.x stored one encrypted token. It may itself happen to be valid JSON.
    return plaintext.length <= 4096 ? { legacy: plaintext } : {};
  } catch { return {}; }
}

function writeCredentialMap(credentials) {
  if (!secureStorageAvailable()) return false;
  const target = credentialPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({ version: 2, credentials });
  fs.writeFileSync(target, safeStorage.encryptString(payload), { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch {}
  return true;
}

function readCredential() {
  return readCredentialMap().legacy || '';
}

function readDeviceCredential(deviceId) {
  if (!validCredentialId(deviceId)) return '';
  return readCredentialMap()[deviceId] || '';
}

function writeDeviceCredential(deviceId, token) {
  if (!validCredentialId(deviceId) || typeof token !== 'string' || token.length > 4096) return false;
  const credentials = readCredentialMap();
  credentials[deviceId] = token;
  delete credentials.legacy;
  return writeCredentialMap(credentials);
}

function clearDeviceCredential(deviceId) {
  if (!validCredentialId(deviceId)) return;
  const credentials = readCredentialMap();
  delete credentials[deviceId];
  if (Object.keys(credentials).length === 0) clearCredential();
  else writeCredentialMap(credentials);
}

function clearCredential() {
  try { fs.unlinkSync(credentialPath()); } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Unable to clear credential:', error.message);
  }
}

function registerCredentialIpc() {
  ipcMain.on('remote-terminal:credential-supported', (event) => { event.returnValue = secureStorageAvailable(); });
  ipcMain.on('remote-terminal:credential-read', (event) => { event.returnValue = readCredential(); });
  ipcMain.on('remote-terminal:device-credential-read', (event, deviceId) => {
    event.returnValue = readDeviceCredential(deviceId);
  });
  ipcMain.on('remote-terminal:device-credential-write', (event, deviceId, token) => {
    event.returnValue = writeDeviceCredential(deviceId, token);
  });
  ipcMain.on('remote-terminal:device-credential-clear', (event, deviceId) => {
    clearDeviceCredential(deviceId);
    event.returnValue = true;
  });
  ipcMain.on('remote-terminal:app-version', (event) => { event.returnValue = app.getVersion(); });
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
    }
  });
  mainWindow = win;
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
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
            document.getElementById('device-name-input').value = 'Security smoke';
            document.getElementById('device-relay-input').value = 'ws://public.example.cn';
            document.getElementById('device-token-input').value = 'must-not-persist';
            document.getElementById('device-form').requestSubmit();
            const rejectedInsecureEndpoint = !document.getElementById('device-form-error').classList.contains('hidden') &&
              !(localStorage.getItem('remote-terminal-devices-v1') || '').includes('must-not-persist');
            cancel.click();
            return opened && rejectedInsecureEndpoint && modal.classList.contains('hidden');
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
  win.loadFile(path.join(__dirname, 'ui', 'www', 'index.html'));
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
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    );
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
