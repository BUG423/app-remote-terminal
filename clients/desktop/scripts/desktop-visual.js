'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const outputDir = process.env.REMOTE_TERMINAL_VISUAL_DIR || os.tmpdir();
const visualUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-terminal-desktop-visual-'));
app.setPath('userData', visualUserData);
app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  try {
    await win.loadFile(path.join(__dirname, '..', 'ui', 'www', 'index.html'));
    const metrics = await win.webContents.executeJavaScript(`
      for (const device of [
        { id: 'desktop-prod', name: '生产环境', relayUrl: 'wss://relay.example.com', createdAt: 1 },
        { id: 'desktop-dev', name: '开发主机', relayUrl: 'wss://dev.example.com', createdAt: 2 },
        { id: 'desktop-lab', name: '实验设备', relayUrl: 'wss://lab.example.com', createdAt: 3 }
      ]) deviceRegistry.add(device);
      deviceRegistry.select('desktop-prod');
      handleMessage({
        type: 'auth_ok',
        role: 'browser',
        protocolVersion: 2,
        clientId: 'desktop-visual',
        agentOnline: true,
        agentName: '生产工作站',
        sessions: [
          { id: 'deploy-main', title: '生产部署', cwd: '/srv/remote-terminal', status: 'running', createdAt: Date.now() },
          { id: 'service-logs', title: '服务日志', cwd: '/var/log/services', status: 'running', createdAt: Date.now() - 3600000 },
          { id: 'backup-data', title: '数据备份', cwd: '/data/backups', status: 'exited', createdAt: Date.now() - 86400000 }
        ]
      });
      openTerminalPage();
      selectSession('deploy-main');
      const visualTerminal = terminals.get('deploy-main');
      visualTerminal.subscribed = true;
      visualTerminal.stream.applySnapshot({
        seq: 0,
        cols: 80,
        rows: 24,
        data: '\\x1b[36mRemote Terminal\\x1b[0m\\r\\n$ systemctl status remote-terminal-agent\\r\\n\\x1b[32m● active (running)\\x1b[0m\\r\\n'
      });
      new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        const rail = document.getElementById('desktop-device-rail').getBoundingClientRect();
        const sessions = document.getElementById('sidebar').getBoundingClientRect();
        const workspace = document.getElementById('workspace').getBoundingClientRect();
        const settings = document.getElementById('settings-btn').getBoundingClientRect();
        const terminalHost = document.getElementById('terminals').getBoundingClientRect();
        const terminalGeometry = (sessionId) => {
          const entry = terminals.get(sessionId);
          const container = entry.container.getBoundingClientRect();
          const xterm = entry.container.querySelector('.xterm').getBoundingClientRect();
          const screen = entry.container.querySelector('.xterm-screen').getBoundingClientRect();
          const proposed = entry.fit.proposeDimensions();
          return {
            sessionId,
            cols: entry.term.cols,
            rows: entry.term.rows,
            proposedCols: proposed && proposed.cols,
            proposedRows: proposed && proposed.rows,
            container: { left: container.left, top: container.top, right: container.right, bottom: container.bottom, width: container.width, height: container.height },
            xterm: { left: xterm.left, top: xterm.top, right: xterm.right, bottom: xterm.bottom, width: xterm.width, height: xterm.height },
            screen: { left: screen.left, top: screen.top, right: screen.right, bottom: screen.bottom, width: screen.width, height: screen.height }
          };
        };
        const single = terminalGeometry('deploy-main');

        toggleSplitView();
        writeLocalOutput('service-logs', '\\x1b[33mService logs\\x1b[0m\\r\\n$ journalctl -f\\r\\n');
        setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => {
          const splitHost = document.getElementById('terminals').getBoundingClientRect();
          const split = ['deploy-main', 'service-logs'].map(terminalGeometry);
          const splitSideBySide = split[0].container.right <= split[1].container.left ||
            split[1].container.right <= split[0].container.left;
          toggleSplitView();

          setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => {
            resolve({
              railDisplay: getComputedStyle(document.getElementById('desktop-device-rail')).display,
              sessionsDisplay: getComputedStyle(document.getElementById('sidebar')).display,
              workspaceDisplay: getComputedStyle(document.getElementById('workspace')).display,
              columnsOrdered: rail.right <= sessions.left && sessions.right <= workspace.left,
              settingsAtBottom: settings.bottom > rail.height * 0.8,
              deviceRows: document.querySelectorAll('.device-rail-item').length,
              sessionRows: document.querySelectorAll('.session-item').length,
              horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
              terminalHost: { left: terminalHost.left, top: terminalHost.top, right: terminalHost.right, bottom: terminalHost.bottom, width: terminalHost.width, height: terminalHost.height },
              single,
              splitHost: { left: splitHost.left, top: splitHost.top, right: splitHost.right, bottom: splitHost.bottom, width: splitHost.width, height: splitHost.height },
              split,
              splitSideBySide,
              restored: terminalGeometry('deploy-main'),
              hiddenAfterRestore: getComputedStyle(terminals.get('service-logs').container).display === 'none'
            });
          })), 100);
        })), 100);
      })), 100));
    `);

    const terminalFits = (geometry, host) => geometry.cols === geometry.proposedCols &&
      geometry.rows === geometry.proposedRows && geometry.container.left >= host.left - 1 &&
      geometry.container.right <= host.right + 1 && geometry.container.top >= host.top - 1 &&
      geometry.container.bottom <= host.bottom + 1 && geometry.screen.right <= geometry.container.right + 1 &&
      geometry.screen.bottom <= geometry.container.bottom + 1;
    if (metrics.railDisplay !== 'flex' || metrics.sessionsDisplay !== 'flex' ||
        metrics.workspaceDisplay !== 'flex' || !metrics.columnsOrdered || !metrics.settingsAtBottom ||
        metrics.deviceRows !== 3 || metrics.sessionRows !== 3 || metrics.horizontalOverflow ||
        !terminalFits(metrics.single, metrics.terminalHost) || !metrics.splitSideBySide ||
        metrics.split.some((geometry) => !terminalFits(geometry, metrics.splitHost)) ||
        !terminalFits(metrics.restored, metrics.terminalHost) || !metrics.hiddenAfterRestore) {
      throw new Error(`desktop layout regression: ${JSON.stringify(metrics)}`);
    }

    win.setContentSize(1024, 700);
    const compactMetrics = await win.webContents.executeJavaScript(`
      new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        const host = document.getElementById('terminals').getBoundingClientRect();
        const entry = terminals.get('deploy-main');
        const container = entry.container.getBoundingClientRect();
        const screen = entry.container.querySelector('.xterm-screen').getBoundingClientRect();
        const proposed = entry.fit.proposeDimensions();
        resolve({
          cols: entry.term.cols,
          rows: entry.term.rows,
          proposedCols: proposed && proposed.cols,
          proposedRows: proposed && proposed.rows,
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          fillsHost: container.left >= host.left - 1 && container.right <= host.right + 1 &&
            container.top >= host.top - 1 && container.bottom <= host.bottom + 1 &&
            screen.right <= container.right + 1 && screen.bottom <= container.bottom + 1
        });
      })), 150));
    `);
    if (compactMetrics.cols !== compactMetrics.proposedCols ||
        compactMetrics.rows !== compactMetrics.proposedRows || compactMetrics.horizontalOverflow ||
        !compactMetrics.fillsHost) {
      throw new Error(`compact desktop layout regression: ${JSON.stringify(compactMetrics)}`);
    }

    win.setContentSize(1440, 900);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const outputPath = path.join(outputDir, 'remote-terminal-desktop.png');
    fs.writeFileSync(outputPath, (await win.capturePage()).toPNG());
    console.log(JSON.stringify({ outputPath, metrics, compactMetrics }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    fs.rmSync(visualUserData, { recursive: true, force: true });
  }
});
