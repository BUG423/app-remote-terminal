'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const outputDir = process.env.REMOTE_TERMINAL_VISUAL_DIR || '/tmp';

app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 390,
    height: 844,
    show: false,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  try {
    await win.loadFile(path.join(__dirname, '..', 'ui', 'www', 'index.html'));
    const listMetrics = await win.webContents.executeJavaScript(`
      handleMessage({
        type: 'auth_ok',
        clientId: 'mobile-visual',
        agentOnline: true,
        agentName: '阿里云工作站',
        sessions: [
          { id: 'mobile-1', title: '生产服务器', cwd: '/srv/remote-terminal', status: 'running', createdAt: Date.now() },
          { id: 'mobile-2', title: '日志监控', cwd: '/var/log/services', status: 'running', createdAt: Date.now() - 3600000 },
          { id: 'mobile-3', title: '数据备份', cwd: '/data/backups', status: 'exited', createdAt: Date.now() - 86400000 }
        ]
      });
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
        view: document.getElementById('main-screen').dataset.mobileView,
        sidebar: getComputedStyle(document.getElementById('sidebar')).display,
        workspace: getComputedStyle(document.getElementById('workspace')).display,
        tabbar: getComputedStyle(document.getElementById('mobile-tabbar')).display,
        sessionRows: document.querySelectorAll('.session-item').length,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      }))));
    `);
    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.writeFileSync(path.join(outputDir, 'remote-terminal-mobile-sessions.png'), (await win.capturePage()).toPNG());

    win.setContentSize(390, 560);
    const terminalMetrics = await win.webContents.executeJavaScript(`
      selectSession('mobile-1');
      document.getElementById('mobile-command-input').value = 'echo "hello"';
      document.getElementById('mobile-command-input').focus();
      window.RemoteTerminalApp.onViewportChanged(true);
      new Promise((resolve) => setTimeout(() => resolve({
        view: document.getElementById('main-screen').dataset.mobileView,
        sidebar: getComputedStyle(document.getElementById('sidebar')).display,
        workspace: getComputedStyle(document.getElementById('workspace')).display,
        tabbar: getComputedStyle(document.getElementById('mobile-tabbar')).display,
        keybar: getComputedStyle(document.getElementById('mobile-keybar')).display,
        composer: getComputedStyle(document.getElementById('mobile-command-form')).display,
        inputValue: document.getElementById('mobile-command-input').value,
        inputVisible: document.getElementById('mobile-command-input').getBoundingClientRect().bottom <= window.innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      }), 250));
    `);
    fs.writeFileSync(path.join(outputDir, 'remote-terminal-mobile-terminal.png'), (await win.capturePage()).toPNG());
    console.log(JSON.stringify({ listMetrics, terminalMetrics }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
