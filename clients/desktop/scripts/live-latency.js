'use strict';

const { app, BrowserWindow } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..', '..', '..');
const WebSocket = require(path.join(projectRoot, 'tests', 'ws-client'));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-terminal-ui-latency-'));
const configPath = path.join(tempRoot, 'server.json');
const userDataPath = path.join(tempRoot, 'electron');
const browserToken = crypto.randomBytes(32).toString('base64url');
const agentToken = crypto.randomBytes(32).toString('base64url');
const sessionId = 'ui-latency';
let relay = null;
let fakeAgent = null;

app.setPath('userData', userDataPath);
app.commandLine.appendSwitch('disable-gpu');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForHealth(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.setTimeout(500, () => req.destroy());
      req.on('error', retry);
    };
    const retry = () => {
      if (Date.now() >= deadline) reject(new Error('Relay health timeout'));
      else setTimeout(poll, 50);
    };
    poll();
  });
}

function reportFakeSession() {
  fakeAgent.send(JSON.stringify({
    type: 'sessions',
    sessions: [{
      id: sessionId,
      title: 'UI latency',
      cwd: '/fake',
      pid: 1,
      status: 'running',
      createdAt: Date.now(),
    }],
  }));
}

function startFakeAgent(target) {
  return new Promise((resolve, reject) => {
    let authenticated = false;
    fakeAgent = new WebSocket(target, { perMessageDeflate: false });
    fakeAgent.once('error', reject);
    fakeAgent.on('open', () => fakeAgent.send(JSON.stringify({
      type: 'auth', role: 'agent', token: agentToken,
    })));
    fakeAgent.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'auth_ok' && !authenticated) {
        authenticated = true;
        reportFakeSession();
        fakeAgent.send(JSON.stringify({
          type: 'terminal_state', sessionId, data: '', cols: 120, rows: 30,
        }));
        resolve();
        return;
      }
      if (message.type === 'terminal_list') {
        reportFakeSession();
        return;
      }
      if (message.type !== 'terminal_input' || message.sessionId !== sessionId) return;
      if (message.data === '__BURST__') {
        for (let index = 0; index < 250; index++) {
          const line = `burst-${String(index).padStart(3, '0')} ${'x'.repeat(100)}\r\n`;
          fakeAgent.send(JSON.stringify({ type: 'terminal_output', sessionId, data: line }));
        }
        fakeAgent.send(JSON.stringify({
          type: 'terminal_output', sessionId, data: '__BURST_DONE__\r\n',
        }));
      } else {
        fakeAgent.send(JSON.stringify({ type: 'terminal_output', sessionId, data: message.data }));
      }
    });
  });
}

function rendererBenchmark(prefix, samples) {
  return `
    (async () => {
      const sessionId = ${JSON.stringify(sessionId)};
      const entry = terminals.get(sessionId);
      const terminalText = () => {
        const buffer = entry.term.buffer.active;
        let text = '';
        for (let row = Math.max(0, buffer.length - 400); row < buffer.length; row++) {
          text += buffer.getLine(row)?.translateToString(true) || '';
        }
        return text;
      };
      const waitForText = async (marker, started, timeoutMs = 3000) => {
        while (performance.now() - started < timeoutMs) {
          if (terminalText().includes(marker)) return performance.now() - started;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        throw new Error('renderer timeout: ' + marker);
      };
      const values = [];
      for (let index = 0; index < ${samples + 5}; index++) {
        const marker = ${JSON.stringify(prefix)} + String(index).padStart(3, '0');
        const started = performance.now();
        if (!sendTerminalInput(sessionId, marker)) throw new Error('terminal input rejected');
        const elapsed = await waitForText(marker, started);
        if (index >= 5) values.push(elapsed);
      }
      values.sort((a, b) => a - b);
      const pick = (ratio) => values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)];
      const proposed = entry.fit.proposeDimensions();
      const container = entry.container.getBoundingClientRect();
      return {
        samples: values.length,
        medianMs: Number(pick(.5).toFixed(2)),
        p95Ms: Number(pick(.95).toFixed(2)),
        maxMs: Number(values[values.length - 1].toFixed(2)),
        cols: entry.term.cols,
        rows: entry.term.rows,
        proposedCols: proposed && proposed.cols,
        proposedRows: proposed && proposed.rows,
        visible: getComputedStyle(entry.container).display !== 'none' && container.width > 0 && container.height > 0,
        mobileView,
        desktopView: mainScreen.dataset.desktopView,
        containerWidth: container.width,
        containerHeight: container.height
      };
    })()
  `;
}

async function waitForRendererReady(win, target) {
  return win.webContents.executeJavaScript(`
    (() => {
      const id = 'local-latency-device';
      deviceRegistry.add({ id, name: 'Local fake Agent', relayUrl: ${JSON.stringify(target)}, createdAt: Date.now() });
      writeDeviceToken(id, ${JSON.stringify(browserToken)});
      activateDevice(id);
      return new Promise((resolve, reject) => {
        const deadline = performance.now() + 8000;
        const check = () => {
          const entry = terminals.get(${JSON.stringify(sessionId)});
          const proposed = entry?.fit.proposeDimensions();
          if (STATE.authenticated && STATE.agentOnline && entry?.subscribed && entry.stream.accepting &&
              proposed && entry.term.cols === proposed.cols && entry.term.rows === proposed.rows) {
            resolve(true);
          } else if (performance.now() >= deadline) {
            reject(new Error('renderer connection timeout'));
          } else {
            setTimeout(check, 25);
          }
        };
        check();
      });
    })()
  `);
}

async function waitForTerminalFit(win, timeoutMs = 3000) {
  return win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = performance.now() + ${timeoutMs};
      let matchingSince = 0;
      const check = () => {
        const entry = terminals.get(${JSON.stringify(sessionId)});
        const proposed = entry?.fit.proposeDimensions();
        if (entry && proposed && entry.term.cols === proposed.cols && entry.term.rows === proposed.rows) {
          if (!matchingSince) matchingSince = performance.now();
          // 不接受转屏和重新订阅期间的瞬时匹配；快照可能随后恢复远端旧尺寸。
          if (performance.now() - matchingSince >= 150) return resolve(true);
        } else if (performance.now() >= deadline) {
          return reject(new Error('terminal fit timeout'));
        } else {
          matchingSince = 0;
        }
        setTimeout(check, 20);
      };
      check();
    })
  `);
}

async function benchmarkBurst(win) {
  return win.webContents.executeJavaScript(`
    (async () => {
      const entry = terminals.get(${JSON.stringify(sessionId)});
      const hasMarker = () => {
        const buffer = entry.term.buffer.active;
        for (let row = Math.max(0, buffer.length - 400); row < buffer.length; row++) {
          if ((buffer.getLine(row)?.translateToString(true) || '').includes('__BURST_DONE__')) return true;
        }
        return false;
      };
      const gaps = [];
      let lastTick = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        gaps.push(now - lastTick);
        lastTick = now;
      }, 8);
      const started = performance.now();
      sendTerminalInput(${JSON.stringify(sessionId)}, '__BURST__');
      while (!hasMarker() && performance.now() - started < 5000) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      clearInterval(timer);
      if (!hasMarker()) throw new Error('burst renderer timeout');
      return {
        totalMs: Number((performance.now() - started).toFixed(2)),
        maxEventLoopGapMs: Number(Math.max(0, ...gaps).toFixed(2)),
        lines: entry.term.buffer.active.length
      };
    })()
  `);
}

async function cleanup() {
  try { fakeAgent?.close(); } catch { /* ignore */ }
  if (relay?.exitCode === null) relay.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

app.whenReady().then(async () => {
  let win;
  try {
    const port = await reservePort();
    const target = `ws://127.0.0.1:${port}`;
    fs.writeFileSync(configPath, JSON.stringify({
      port,
      bindHost: '127.0.0.1',
      useTLS: false,
      devices: {
        ui: { name: 'UI fake Agent', browserToken, agentToken },
      },
    }, null, 2), { mode: 0o600 });
    relay = spawn(process.execPath, [path.join(projectRoot, 'server/index.js')], {
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: 'production', CW_CONFIG_PATH: configPath },
      stdio: process.env.DEBUG_LATENCY ? 'inherit' : 'ignore',
    });
    await waitForHealth(port);
    await startFakeAgent(target);

    win = new BrowserWindow({
      width: 1280,
      height: 820,
      show: false,
      backgroundColor: '#0d1117',
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    await win.loadFile(path.join(__dirname, '..', 'ui', 'www', 'index.html'));
    await waitForRendererReady(win, target);
    const desktop = await win.webContents.executeJavaScript(rendererBenchmark('D', 40));
    const burst = await benchmarkBurst(win);

    win.setContentSize(390, 560);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await win.webContents.executeJavaScript(`selectSession(${JSON.stringify(sessionId)}); true;`);
    await waitForTerminalFit(win);
    const mobile = await win.webContents.executeJavaScript(rendererBenchmark('M', 40));
    const result = { desktop, mobile, burst };
    console.log(JSON.stringify(result, null, 2));
    if (!desktop.visible || desktop.cols !== desktop.proposedCols || desktop.rows !== desktop.proposedRows ||
        !mobile.visible || mobile.cols !== mobile.proposedCols || mobile.rows !== mobile.proposedRows ||
        desktop.p95Ms > 35 || mobile.p95Ms > 35 ||
        burst.totalMs > 1200 || burst.maxEventLoopGapMs > 120) {
      throw new Error(`UI latency regression: ${JSON.stringify(result)}`);
    }
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error.message);
    app.exit(1);
  } finally {
    try { win?.destroy(); } catch { /* ignore */ }
    await cleanup();
  }
});
