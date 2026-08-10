const { clipboard, contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('remoteTerminalConfig', Object.freeze({
  appVersion: ipcRenderer.sendSync('remote-terminal:app-version') || '',
  defaultRelayUrl: process.env.REMOTE_TERMINAL_URL || 'wss://webclaude.xmu-zss.cn',
  readClipboardText: () => clipboard.readText(),
  supportsSecureCredentials: ipcRenderer.sendSync('remote-terminal:credential-supported') === true,
  readCredential: () => ipcRenderer.sendSync('remote-terminal:credential-read') || '',
  readDeviceCredential: (deviceId) => ipcRenderer.sendSync('remote-terminal:device-credential-read', deviceId) || '',
  writeDeviceCredential: (deviceId, token) => ipcRenderer.sendSync('remote-terminal:device-credential-write', deviceId, token) === true,
  clearDeviceCredential: (deviceId) => ipcRenderer.sendSync('remote-terminal:device-credential-clear', deviceId) === true,
}));
