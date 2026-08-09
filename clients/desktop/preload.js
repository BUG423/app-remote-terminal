const { clipboard, contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('remoteTerminalConfig', Object.freeze({
  isPackagedClient: true,
  defaultRelayUrl: process.env.REMOTE_TERMINAL_URL || '',
  readClipboardText: () => clipboard.readText(),
  supportsSecureCredentials: ipcRenderer.sendSync('remote-terminal:credential-supported') === true,
  readCredential: () => ipcRenderer.sendSync('remote-terminal:credential-read') || '',
  writeCredential: (token) => ipcRenderer.send('remote-terminal:credential-write', token),
  clearCredential: () => ipcRenderer.send('remote-terminal:credential-clear'),
}));
