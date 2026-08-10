'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const outputDir = process.env.REMOTE_TERMINAL_VISUAL_DIR || '/tmp';
const visualUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-terminal-mobile-visual-'));
app.setPath('userData', visualUserData);

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
      deviceRegistry.add({
        id: 'mobile-device', name: '阿里云工作站',
        relayUrl: 'wss://relay.example.com', createdAt: Date.now()
      });
      deviceRegistry.select('mobile-device');
      handleMessage({
        type: 'auth_ok',
        role: 'browser',
        protocolVersion: 2,
        clientId: 'mobile-visual',
        agentOnline: true,
        agentName: '阿里云工作站',
        sessions: [
          { id: 'mobile-1', title: '生产服务器', cwd: '/srv/remote-terminal', status: 'running', createdAt: Date.now() },
          { id: 'mobile-2', title: '日志监控', cwd: '/var/log/services', status: 'running', createdAt: Date.now() - 3600000 },
          { id: 'mobile-3', title: '数据备份', cwd: '/data/backups', status: 'exited', createdAt: Date.now() - 86400000 }
        ]
      });
      setMobileView('sessions');
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
        view: document.getElementById('main-screen').dataset.mobileView,
        sidebar: getComputedStyle(document.getElementById('sidebar')).display,
        workspace: getComputedStyle(document.getElementById('workspace')).display,
        tabbar: getComputedStyle(document.getElementById('mobile-tabbar')).display,
        desktopRail: getComputedStyle(document.getElementById('desktop-device-rail')).display,
        sessionRows: document.querySelectorAll('.session-item').length,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      }))));
    `);
    if (listMetrics.view !== 'sessions' || listMetrics.sidebar !== 'flex' ||
        listMetrics.workspace !== 'none' || listMetrics.tabbar !== 'flex' ||
        listMetrics.desktopRail !== 'none' || listMetrics.sessionRows !== 3 ||
        listMetrics.horizontalOverflow) {
      throw new Error(`mobile session layout regression: ${JSON.stringify(listMetrics)}`);
    }

    const reconnectViewMetrics = await win.webContents.executeJavaScript(`
      const reconnectAuth = () => handleMessage({
        type: 'auth_ok', role: 'browser', protocolVersion: 2,
        clientId: 'mobile-visual-reconnect', agentOnline: true,
        agentName: '阿里云工作站', sessions: STATE.sessions
      });
      setMobileView('profile');
      reconnectAuth();
      const profileAfterReconnect = document.getElementById('main-screen').dataset.mobileView;
      setMobileView('device');
      reconnectAuth();
      const deviceAfterReconnect = document.getElementById('main-screen').dataset.mobileView;
      setMobileView('sessions');
      ({ profileAfterReconnect, deviceAfterReconnect });
    `);
    if (reconnectViewMetrics.profileAfterReconnect !== 'profile' ||
        reconnectViewMetrics.deviceAfterReconnect !== 'device') {
      throw new Error(`mobile reconnect navigation regression: ${JSON.stringify(reconnectViewMetrics)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.writeFileSync(path.join(outputDir, 'remote-terminal-mobile-sessions.png'), (await win.capturePage()).toPNG());

    win.setContentSize(390, 560);
    const terminalMetrics = await win.webContents.executeJavaScript(`
      selectSession('mobile-1');
      handleMessage({
        type: 'auth_ok', role: 'browser', protocolVersion: 2,
        clientId: 'mobile-visual-terminal-reconnect', agentOnline: true,
        agentName: '阿里云工作站', sessions: STATE.sessions
      });
      document.getElementById('mobile-command-input').value = 'echo "hello"';
      document.getElementById('mobile-command-input').focus();
      window.RemoteTerminalApp.onViewportChanged(true);
      new Promise((resolve) => setTimeout(() => {
        const entry = terminals.get('mobile-1');
        const host = document.getElementById('terminals').getBoundingClientRect();
        const container = entry.container.getBoundingClientRect();
        const screen = entry.container.querySelector('.xterm-screen').getBoundingClientRect();
        const proposed = entry.fit.proposeDimensions();
        resolve({
          view: document.getElementById('main-screen').dataset.mobileView,
          sidebar: getComputedStyle(document.getElementById('sidebar')).display,
          workspace: getComputedStyle(document.getElementById('workspace')).display,
          tabbar: getComputedStyle(document.getElementById('mobile-tabbar')).display,
          keybar: getComputedStyle(document.getElementById('mobile-keybar')).display,
          composer: getComputedStyle(document.getElementById('mobile-command-form')).display,
          inputValue: document.getElementById('mobile-command-input').value,
          inputVisible: document.getElementById('mobile-command-input').getBoundingClientRect().bottom <= window.innerHeight,
          desktopRail: getComputedStyle(document.getElementById('desktop-device-rail')).display,
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          terminalCols: entry.term.cols,
          terminalRows: entry.term.rows,
          proposedCols: proposed && proposed.cols,
          proposedRows: proposed && proposed.rows,
          terminalWithinHost: container.left >= host.left - 1 && container.right <= host.right + 1 &&
            container.top >= host.top - 1 && container.bottom <= host.bottom + 1 &&
            screen.right <= container.right + 1 && screen.bottom <= container.bottom + 1
        });
      }, 250));
    `);
    if (terminalMetrics.view !== 'terminal' || terminalMetrics.sidebar !== 'none' ||
        terminalMetrics.workspace !== 'flex' || terminalMetrics.tabbar !== 'none' ||
        terminalMetrics.keybar !== 'none' || terminalMetrics.composer !== 'flex' ||
        terminalMetrics.inputValue !== 'echo "hello"' || !terminalMetrics.inputVisible ||
        terminalMetrics.desktopRail !== 'none' || terminalMetrics.horizontalOverflow ||
        terminalMetrics.terminalCols !== terminalMetrics.proposedCols ||
        terminalMetrics.terminalRows !== terminalMetrics.proposedRows ||
        !terminalMetrics.terminalWithinHost) {
      throw new Error(`mobile terminal layout regression: ${JSON.stringify(terminalMetrics)}`);
    }
    fs.writeFileSync(path.join(outputDir, 'remote-terminal-mobile-terminal.png'), (await win.capturePage()).toPNG());
    console.log(JSON.stringify({ listMetrics, reconnectViewMetrics, terminalMetrics }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    fs.rmSync(visualUserData, { recursive: true, force: true });
  }
});
