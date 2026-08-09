const { app, BrowserWindow, ipcMain, safeStorage, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
let mainWindow = null;

function credentialPath() {
  return path.join(app.getPath('userData'), 'credential.bin');
}

function secureStorageAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function readCredential() {
  if (!secureStorageAvailable()) return '';
  try { return safeStorage.decryptString(fs.readFileSync(credentialPath())); } catch { return ''; }
}

function writeCredential(token) {
  if (!secureStorageAvailable() || typeof token !== 'string' || token.length > 4096) return;
  const target = credentialPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, safeStorage.encryptString(token), { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch {}
}

function clearCredential() {
  try { fs.unlinkSync(credentialPath()); } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Unable to clear credential:', error.message);
  }
}

function registerCredentialIpc() {
  ipcMain.on('remote-terminal:credential-supported', (event) => { event.returnValue = secureStorageAvailable(); });
  ipcMain.on('remote-terminal:credential-read', (event) => { event.returnValue = readCredential(); });
  ipcMain.on('remote-terminal:credential-write', (_event, token) => writeCredential(token));
  ipcMain.on('remote-terminal:credential-clear', () => clearCredential());
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 760, minHeight: 520, show: false,
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
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  if (process.env.REMOTE_TERMINAL_SMOKE === '1') {
    win.webContents.once('did-finish-load', async () => {
      try {
        const ready = await win.webContents.executeJavaScript(
          "document.readyState === 'complete' && !!document.getElementById('login-screen') && typeof ClientSettings?.ClientSettingsStore === 'function'",
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
