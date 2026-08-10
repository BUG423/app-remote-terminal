'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('./ws-client');

const projectRoot = path.join(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-terminal-latency-'));
const workspace = path.join(tempRoot, 'workspace');
const serverConfigPath = path.join(tempRoot, 'server.json');
const agentConfigPath = path.join(tempRoot, 'agent.json');
const browserTokenFake = crypto.randomBytes(32).toString('base64url');
const agentTokenFake = crypto.randomBytes(32).toString('base64url');
const browserTokenReal = crypto.randomBytes(32).toString('base64url');
const agentTokenReal = crypto.randomBytes(32).toString('base64url');
const fakeSessionId = 'fake-latency';
const realSessionId = 'real-latency';
const sockets = new Set();
const processes = new Set();

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function stats(values) {
  return {
    samples: values.length,
    minMs: Number(Math.min(...values).toFixed(2)),
    medianMs: Number(percentile(values, 0.5).toFixed(2)),
    p95Ms: Number(percentile(values, 0.95).toFixed(2)),
    maxMs: Number(Math.max(...values).toFixed(2)),
  };
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

class ProtocolClient {
  constructor(target) {
    this.target = target;
    this.ws = null;
    this.messages = [];
    this.waiters = [];
    this.listeners = new Set();
  }

  async connect(role, token) {
    this.ws = new WebSocket(this.target, { perMessageDeflate: false });
    sockets.add(this.ws);
    this.ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      this.messages.push(message);
      for (const listener of this.listeners) listener(message);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${role} open timeout`)), 5000);
      this.ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once('error', reject);
    });
    const auth = this.waitFor((message) => message.type === 'auth_ok', 5000);
    this.send({ type: 'auth', role, token, ...(role === 'browser' ? { protocolVersion: 2 } : {}) });
    return auth;
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitFor(predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error('protocol message timeout'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

function waitForTerminalText(client, sessionId, expected, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const started = performance.now();
    const stop = client.onMessage((message) => {
      if (message.type !== 'terminal_output' || message.sessionId !== sessionId) return;
      output = (output + message.data).slice(-8192);
      if (!output.includes(expected)) return;
      stop();
      clearTimeout(timer);
      resolve(performance.now() - started);
    });
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`terminal output timeout: ${expected}`));
    }, timeoutMs);
  });
}

async function attach(client, sessionId) {
  const attached = client.waitFor(
    (message) => message.type === 'terminal_attached' && message.sessionId === sessionId,
    5000
  );
  client.send({ type: 'terminal_attach', sessionId });
  await attached;
}

async function benchmarkFake(target) {
  const agent = new ProtocolClient(target);
  agent.onMessage((message) => {
    if (message.type === 'terminal_list') {
      agent.send({
        type: 'sessions',
        sessions: [{
          id: fakeSessionId,
          title: 'Fake latency',
          cwd: '/fake',
          pid: 1,
          status: 'running',
          createdAt: Date.now(),
        }],
      });
    } else if (message.type === 'terminal_input' && message.sessionId === fakeSessionId) {
      agent.send({ type: 'terminal_output', sessionId: fakeSessionId, data: message.data });
    }
  });
  await agent.connect('agent', agentTokenFake);
  agent.send({
    type: 'sessions',
    sessions: [{
      id: fakeSessionId,
      title: 'Fake latency',
      cwd: '/fake',
      pid: 1,
      status: 'running',
      createdAt: Date.now(),
    }],
  });
  agent.send({ type: 'terminal_state', sessionId: fakeSessionId, data: '', cols: 120, rows: 30 });

  const browser = new ProtocolClient(target);
  await browser.connect('browser', browserTokenFake);
  await attach(browser, fakeSessionId);

  const samples = [];
  for (let index = 0; index < 60; index++) {
    const marker = `F${String(index).padStart(3, '0')}`;
    const echoed = waitForTerminalText(browser, fakeSessionId, marker);
    browser.send({ type: 'terminal_input', sessionId: fakeSessionId, data: marker });
    const elapsed = await echoed;
    if (index >= 10) samples.push(elapsed);
  }
  browser.close();
  agent.close();
  return stats(samples);
}

async function waitForAgentBrowser(target) {
  const browser = new ProtocolClient(target);
  const auth = await browser.connect('browser', browserTokenReal);
  if (!auth.agentOnline) {
    await browser.waitFor((message) => message.type === 'agent_status' && message.online === true, 8000);
  }
  return browser;
}

async function benchmarkReal(target) {
  const browser = await waitForAgentBrowser(target);
  const created = browser.waitFor(
    (message) => message.type === 'terminal_created' && message.sessionId === realSessionId,
    5000
  );
  browser.send({ type: 'terminal_create', sessionId: realSessionId, title: 'Real latency' });
  await created;
  await attach(browser, realSessionId);
  await wait(350);

  const echoSamples = [];
  for (let index = 0; index < 30; index++) {
    const marker = `KEY${String(index).padStart(3, '0')}`;
    const echoed = waitForTerminalText(browser, realSessionId, marker);
    browser.send({ type: 'terminal_input', sessionId: realSessionId, data: marker });
    const elapsed = await echoed;
    browser.send({ type: 'terminal_input', sessionId: realSessionId, data: '\x15' });
    if (index >= 5) echoSamples.push(elapsed);
    await wait(5);
  }

  browser.send({ type: 'terminal_input', sessionId: realSessionId, data: 'stty -echo\r' });
  await wait(200);
  const commandSamples = [];
  for (let index = 0; index < 25; index++) {
    const marker = `OUT${String(index).padStart(3, '0')}`;
    const output = waitForTerminalText(browser, realSessionId, marker);
    browser.send({
      type: 'terminal_input',
      sessionId: realSessionId,
      data: `printf '${marker}'\r`,
    });
    const elapsed = await output;
    if (index >= 5) commandSamples.push(elapsed);
  }

  const floodMarker = '__LATENCY_FLOOD_DONE__';
  let floodBytes = 0;
  let floodMessages = 0;
  const stopFloodCounter = browser.onMessage((message) => {
    if (message.type !== 'terminal_output' || message.sessionId !== realSessionId) return;
    floodBytes += Buffer.byteLength(message.data);
    floodMessages++;
  });
  const floodOutput = waitForTerminalText(browser, realSessionId, floodMarker, 8000);
  const floodStarted = performance.now();
  browser.send({
    type: 'terminal_input',
    sessionId: realSessionId,
    data: `yes x | head -c 524288; printf '\\n${floodMarker}\\n'\r`,
  });
  const floodElapsed = await floodOutput;
  stopFloodCounter();

  browser.send({ type: 'terminal_input', sessionId: realSessionId, data: 'stty echo\r' });
  browser.send({ type: 'terminal_delete', sessionId: realSessionId });
  browser.close();
  return {
    echo: stats(echoSamples),
    command: stats(commandSamples),
    flood: {
      bytes: floodBytes,
      messages: floodMessages,
      elapsedMs: Number(floodElapsed.toFixed(2)),
      mibPerSecond: Number((floodBytes / 1024 / 1024 / ((performance.now() - floodStarted) / 1000)).toFixed(2)),
    },
  };
}

async function cleanup() {
  for (const socket of sockets) {
    try { socket.close(); } catch { /* ignore */ }
  }
  for (const child of processes) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  await wait(200);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

(async () => {
  const port = await reservePort();
  const target = `ws://127.0.0.1:${port}`;
  const currentUser = os.userInfo();
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.writeFileSync(serverConfigPath, JSON.stringify({
    port,
    bindHost: '127.0.0.1',
    useTLS: false,
    devices: {
      fake: { name: 'Fake Agent', browserToken: browserTokenFake, agentToken: agentTokenFake },
      real: { name: 'Real Agent', browserToken: browserTokenReal, agentToken: agentTokenReal },
    },
  }, null, 2), { mode: 0o600 });
  fs.writeFileSync(agentConfigPath, JSON.stringify({
    serverUrl: target,
    agentToken: agentTokenReal,
    requiredUser: currentUser.username,
    requiredUid: typeof process.getuid === 'function' ? process.getuid() : currentUser.uid,
    requiredHome: currentUser.homedir,
    requiredWorkingDirectory: workspace,
    outputFlushMs: 4,
    maxSessions: 2,
  }, null, 2), { mode: 0o600 });

  const relay = spawn(process.execPath, [path.join(projectRoot, 'server/index.js')], {
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: 'production', CW_CONFIG_PATH: serverConfigPath },
    stdio: process.env.DEBUG_LATENCY ? 'inherit' : 'ignore',
  });
  processes.add(relay);
  await waitForHealth(port);

  const realAgent = spawn(process.execPath, [path.join(projectRoot, 'agent/index.js')], {
    cwd: workspace,
    env: { ...process.env, NODE_ENV: 'production', CW_CONFIG_PATH: agentConfigPath },
    stdio: process.env.DEBUG_LATENCY ? 'inherit' : 'ignore',
  });
  processes.add(realAgent);

  const fake = await benchmarkFake(target);
  const real = await benchmarkReal(target);
  const result = {
    fakeRelayRoundTrip: fake,
    realPtyEcho: real.echo,
    realCommandOutput: real.command,
    realOutputFlood: real.flood,
  };
  console.log(JSON.stringify(result, null, 2));

  if (fake.p95Ms > 30 || real.echo.p95Ms > 30 || real.command.p95Ms > 40 ||
      real.flood.bytes < 512 * 1024 || real.flood.elapsedMs > 5000 || real.flood.messages > 80) {
    throw new Error(`local latency regression: ${JSON.stringify(result)}`);
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(cleanup);
