#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { spawnSync } = require('child_process');
const { configuredTokenIsValid } = require('../server/auth');
const { loadConfig } = require('../lib/load-config');

const PROJECT_ROOT = path.join(__dirname, '..');

function positiveNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function envFlag(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, timeout = 10000) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    env: {
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C',
    },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error ? result.error.message : '',
  };
}

function systemctl(...args) {
  return run('systemctl', args);
}

function serviceState(unit) {
  const result = systemctl('is-active', unit);
  return result.stdout || 'unknown';
}

function requestStatus(client, options, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = client.request(options, (res) => {
      res.resume();
      finish({ ok: res.statusCode >= 200 && res.statusCode < 400, statusCode: res.statusCode });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
    req.on('error', (err) => finish({ ok: false, error: err.message }));
    req.end();
  });
}

function pinnedLocalTlsOptions(config) {
  const certPath = config.tlsCertPath;
  if (typeof certPath !== 'string' || !path.isAbsolute(certPath)) {
    throw new Error('TLS monitoring requires an absolute tlsCertPath');
  }
  const stat = fs.lstatSync(certPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 2 * 1024 * 1024) {
    throw new Error('TLS monitoring certificate must be a regular file no larger than 2 MiB');
  }

  const certificate = fs.readFileSync(certPath);
  const expectedRaw = new crypto.X509Certificate(certificate).raw;
  const expectedFingerprint = crypto.createHash('sha256').update(expectedRaw).digest();
  return {
    // A public fullchain omits its root; keep public roots before checking the pin.
    ca: [...tls.rootCertificates, certificate],
    rejectUnauthorized: true,
    checkServerIdentity: (_hostname, peerCertificate) => {
      if (!Buffer.isBuffer(peerCertificate?.raw)) return new Error('local TLS peer certificate is missing');
      const actualFingerprint = crypto.createHash('sha256').update(peerCertificate.raw).digest();
      if (actualFingerprint.length !== expectedFingerprint.length ||
          !crypto.timingSafeEqual(actualFingerprint, expectedFingerprint)) {
        return new Error('local TLS certificate fingerprint mismatch');
      }
      return undefined;
    },
  };
}

async function checkInternalHealth(config, host, port) {
  const useTls = config.useTLS === true;
  const client = useTls ? https : http;
  const options = {
    hostname: host,
    port,
    path: '/health',
    method: 'GET',
    ...(useTls ? pinnedLocalTlsOptions(config) : {}),
  };
  const first = await requestStatus(client, options);
  if (first.ok) return first;
  await sleep(750);
  return requestStatus(client, options);
}

function checkLocalTls(host, port) {
  if (!host) return Promise.resolve({ ok: true, skipped: true });
  return requestStatus(https, {
    hostname: '127.0.0.1',
    port,
    path: '/health',
    method: 'GET',
    servername: host,
    headers: { Host: host },
    rejectUnauthorized: true,
    checkServerIdentity: (_hostname, cert) => tls.checkServerIdentity(host, cert),
  });
}

function selectDevice(config, requestedId) {
  const devices = config.devices && typeof config.devices === 'object' && !Array.isArray(config.devices)
    ? config.devices
    : {};
  if (requestedId) {
    if (!Object.prototype.hasOwnProperty.call(devices, requestedId)) {
      throw new Error(`monitor device not found: ${requestedId}`);
    }
    return { id: requestedId, ...devices[requestedId] };
  }
  const entries = Object.entries(devices);
  if (entries.length !== 1) {
    throw new Error('RT_MONITOR_DEVICE_ID is required when Server has zero or multiple devices');
  }
  return { id: entries[0][0], ...entries[0][1] };
}

function checkRemoteAgent(config, device, timeoutMs = 5000) {
  const WebSocket = require(path.join(PROJECT_ROOT, 'server', 'node_modules', 'ws'));
  const bindHost = ['0.0.0.0', '::'].includes(config.bindHost) ? '127.0.0.1' : (config.bindHost || '127.0.0.1');
  const port = Number(config.port) || 3002;
  const useTls = config.useTLS === true;
  const target = `${useTls ? 'wss' : 'ws'}://${bindHost.includes(':') ? `[${bindHost}]` : bindHost}:${port}`;

  return new Promise((resolve) => {
    // 鉴权探针走本机地址，但仍固定到 Relay 配置中的证书，防止服务停机后
    // 其他本机进程抢占端口并骗取监控用 browserToken。
    const ws = new WebSocket(target, {
      ...(useTls ? pinnedLocalTlsOptions(config) : {}),
      handshakeTimeout: timeoutMs,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(1000, 'monitor complete'); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, online: false, error: 'authentication timeout' }), timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'auth',
        role: 'browser',
        token: device.browserToken,
        protocolVersion: 2,
      }));
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        finish({ ok: false, online: false, error: 'binary Server response' });
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        finish({ ok: false, online: false, error: 'invalid Server response' });
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        finish({ ok: false, online: false, error: 'invalid Server response' });
      } else if (message.type === 'auth_ok' && message.role === 'browser') {
        finish({
          ok: message.agentOnline === true,
          online: message.agentOnline === true,
          agentName: String(message.agentName || device.name || device.id)
            .replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').slice(0, 120),
          sessions: Array.isArray(message.sessions) ? Math.min(message.sessions.length, 100) : 0,
        });
      } else if (message.type === 'error') {
        finish({ ok: false, online: false, error: message.message || 'authentication rejected' });
      }
    });
    ws.on('error', (err) => finish({ ok: false, online: false, error: err.message }));
    ws.on('close', (code) => {
      if (!settled) finish({ ok: false, online: false, error: `connection closed before authentication (${code})` });
    });
  });
}

function collectMetrics(rootPath = '/') {
  const memory = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
  const stat = fs.statfsSync(rootPath);
  const totalBlocks = Number(stat.blocks);
  const availableBlocks = Number(stat.bavail);
  const diskUsedPercent = totalBlocks > 0 ? Number(((1 - availableBlocks / totalBlocks) * 100).toFixed(1)) : null;
  return {
    load1: Number(os.loadavg()[0].toFixed(2)),
    cpuCount: os.cpus().length,
    memoryAvailableMb: memory ? Math.round(Number(memory[1]) / 1024) : null,
    diskUsedPercent,
  };
}

function collectResourceWarnings(metrics, thresholds) {
  const warnings = [];
  if (metrics.load1 > metrics.cpuCount * thresholds.loadPerCpu) {
    warnings.push(`load1 ${metrics.load1} exceeds ${metrics.cpuCount * thresholds.loadPerCpu}`);
  }
  if (metrics.memoryAvailableMb != null && metrics.memoryAvailableMb < thresholds.memoryAvailableMb) {
    warnings.push(`available memory ${metrics.memoryAvailableMb}MB below ${thresholds.memoryAvailableMb}MB`);
  }
  if (metrics.diskUsedPercent != null && metrics.diskUsedPercent >= thresholds.diskUsedPercent) {
    warnings.push(`disk usage ${metrics.diskUsedPercent}% reached ${thresholds.diskUsedPercent}%`);
  }
  return warnings;
}

function writeStatus(filePath, status) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(status, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw err;
  }
}

async function main() {
  const startedAt = Date.now();
  const configPath = process.env.RT_MONITOR_CONFIG || '/etc/remote-terminal/server.json';
  const statePath = process.env.RT_MONITOR_STATE || '/var/lib/remote-terminal-monitor/status.json';
  const config = loadConfig(configPath, { label: 'monitor Relay configuration' });

  const device = selectDevice(config, process.env.RT_MONITOR_DEVICE_ID || '');
  if (!configuredTokenIsValid(device.browserToken)) {
    throw new Error(`device ${device.id} has no valid browserToken`);
  }

  const autoHeal = envFlag(process.env.RT_MONITOR_AUTO_HEAL, false);
  const tlsHost = process.env.RT_MONITOR_TLS_HOST || '';
  const tlsPort = positiveNumber(process.env.RT_MONITOR_TLS_PORT, 443, 1, 65535);
  const bindHost = ['0.0.0.0', '::'].includes(config.bindHost) ? '127.0.0.1' : (config.bindHost || '127.0.0.1');
  const port = positiveNumber(config.port, 3002, 1, 65535);
  const actions = [];
  const errors = [];

  let serverState = serviceState('remote-terminal-server.service');
  if (serverState !== 'active' && autoHeal) {
    const restarted = systemctl('restart', 'remote-terminal-server.service');
    if (restarted.ok) actions.push('restarted remote-terminal-server.service');
    else errors.push(`failed to restart Server: ${restarted.stderr || restarted.error || restarted.status}`);
    await sleep(1500);
    serverState = serviceState('remote-terminal-server.service');
  }

  let internalHealth = await checkInternalHealth(config, bindHost, port);
  if (!internalHealth.ok && serverState === 'active' && autoHeal) {
    const restarted = systemctl('restart', 'remote-terminal-server.service');
    if (restarted.ok) actions.push('restarted unhealthy remote-terminal-server.service');
    else errors.push(`failed to restart unhealthy Server: ${restarted.stderr || restarted.error || restarted.status}`);
    await sleep(1500);
    serverState = serviceState('remote-terminal-server.service');
    internalHealth = await checkInternalHealth(config, bindHost, port);
  }

  const localTls = await checkLocalTls(tlsHost, tlsPort);
  const remoteAgent = internalHealth.ok
    ? await checkRemoteAgent(config, device)
    : { ok: false, online: false, error: 'skipped because Server health check failed' };

  if (serverState !== 'active') errors.push(`Server service is ${serverState}`);
  if (!internalHealth.ok) errors.push(`internal health check failed: ${internalHealth.error || internalHealth.statusCode || 'unknown'}`);
  if (!localTls.ok) errors.push(`local TLS check failed: ${localTls.error || localTls.statusCode || 'unknown'}`);
  if (!remoteAgent.online) errors.push(`remote Agent ${device.id} is offline: ${remoteAgent.error || 'not connected'}`);

  const metrics = collectMetrics('/');
  const thresholds = {
    loadPerCpu: positiveNumber(process.env.RT_MONITOR_LOAD_PER_CPU, 2, 0.5, 20),
    memoryAvailableMb: positiveNumber(process.env.RT_MONITOR_MIN_MEMORY_MB, 256, 64, 1048576),
    diskUsedPercent: positiveNumber(process.env.RT_MONITOR_MAX_DISK_PERCENT, 85, 50, 99.9),
  };
  const warnings = collectResourceWarnings(metrics, thresholds);
  const status = {
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    ok: errors.length === 0,
    level: errors.length > 0 ? 'critical' : (warnings.length > 0 ? 'warning' : 'ok'),
    device: { id: device.id, name: device.name || device.id },
    checks: {
      serverService: { ok: serverState === 'active', state: serverState },
      internalHealth,
      localTls: { ...localTls, host: tlsHost || null, port: tlsHost ? tlsPort : null },
      remoteAgent,
    },
    metrics,
    thresholds,
    warnings,
    errors,
    actions,
  };
  writeStatus(statePath, status);

  const summary = `level=${status.level} remoteAgent=${remoteAgent.online ? 'online' : 'offline'} sessions=${remoteAgent.sessions || 0} load1=${metrics.load1} memAvailableMB=${metrics.memoryAvailableMb} diskUsed=${metrics.diskUsedPercent}% actions=${actions.length}`;
  if (errors.length > 0) console.error(`[monitor] CRITICAL ${summary} errors=${errors.join('; ')}`);
  else if (warnings.length > 0) console.warn(`[monitor] WARNING ${summary} warnings=${warnings.join('; ')}`);
  else console.log(`[monitor] OK ${summary}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[monitor] FATAL ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  collectResourceWarnings,
  envFlag,
  pinnedLocalTlsOptions,
  positiveNumber,
  selectDevice,
};
