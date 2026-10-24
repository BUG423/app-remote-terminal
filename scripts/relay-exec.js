#!/usr/bin/env node
'use strict';

// One command in a new, disposable Agent terminal. No Agent/relay changes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let WebSocket;
for (const source of ['ws', '../server/node_modules/ws', '../agent/node_modules/ws']) {
  try { WebSocket = require(source); break; } catch {}
}

function readProfile(filename) {
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077)) {
    throw new Error('APP profile must be a private regular file (0600, <=16 KiB)');
  }
  const profile = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const url = new URL(profile.relayUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (profile.type !== 'remote-terminal-app' ||
      !(url.protocol === 'wss:' || (loopback && url.protocol === 'ws:')) ||
      url.username || url.password || url.search || url.hash ||
      typeof profile.browserToken !== 'string' || profile.browserToken.length < 32) {
    throw new Error('Invalid APP pairing profile');
  }
  return profile;
}

async function execute(profile, command, { timeoutMs = 90000, maxOutputBytes = 8 * 1024 ** 2 } = {}) {
  if (!WebSocket) throw new Error('Install relay or Agent dependencies first');
  if (!command || Buffer.byteLength(command) > 1024 ** 2) throw new Error('Command must be 1 byte to 1 MiB');
  const id = 'cli-' + crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  const start = '__START_' + nonce + '__';
  const done = '__DONE_' + nonce + '__:';
  const encoded = Buffer.from(command).toString('base64');
  // Bound physical input lines below Linux PTY canonical MAX_CANON (4096).
  const parts = encoded.match(/.{1,768}/g).map(part => "'" + part + "'");
  const input = `stty -echo; printf '\\n${start}\\n'; printf '%s' \\\n${parts.join(' \\\n')} | base64 -d | bash; rc=$?; printf '\\n${done}%s\\n' "$rc"\r`;
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(profile.relayUrl);
    let creationRequested = false, sent = false, deleting = false, finished = false;
    let output = '', result, failure, cleanupTimer;
    const send = message => ws.send(JSON.stringify(message));
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(cleanupTimer);
      ws.close();
      if (failure) reject(failure); else resolve(result);
    };
    const clean = error => {
      if (deleting || finished) return;
      failure = error;
      if (!creationRequested || ws.readyState !== WebSocket.OPEN) return finish();
      deleting = true;
      send({ type: 'terminal_delete', sessionId: id });
      cleanupTimer = setTimeout(() => {
        failure = new Error(`Temporary session cleanup unconfirmed: ${id}`);
        finish();
      }, 8000);
    };
    const timer = setTimeout(() => clean(new Error('Remote command timed out')), timeoutMs);
    ws.on('open', () => send({ type: 'auth', token: profile.browserToken, role: 'browser', protocolVersion: 2 }));
    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw); } catch { return clean(new Error('Invalid relay response')); }
      if (m.type === 'error') return clean(new Error('Relay rejected request'));
      if (m.type === 'agent_status' && !m.online) return clean(new Error('Agent went offline'));
      if (m.type === 'auth_ok') {
        if (creationRequested || deleting || finished) return;
        if (!m.agentOnline) return clean(new Error('Agent offline'));
        creationRequested = true;
        return send({ type: 'terminal_create', sessionId: id, title: 'CLI command' });
      }
      if (m.sessionId !== id) return;
      if (m.type === 'terminal_closed' && deleting) return finish();
      // A late create/attach acknowledgement must not execute after timeout.
      if (deleting || finished) return;
      if (m.type === 'terminal_error') return clean(new Error('Agent terminal request failed'));
      if (m.type === 'terminal_created') {
        return send({ type: 'terminal_attach', sessionId: id });
      }
      if (m.type === 'terminal_attached' && !sent) {
        sent = true;
        for (let offset = 0; offset < input.length; offset += 4096) {
          send({ type: 'terminal_input', sessionId: id, data: input.slice(offset, offset + 4096) });
        }
      }
      if (m.type !== 'terminal_output' || deleting) return;
      output += m.data || '';
      if (Buffer.byteLength(output) > maxOutputBytes + input.length * 3) return clean(new Error('Output bound exceeded'));
      const begin = output.indexOf('\n' + start + '\r\n');
      if (begin < 0) return;
      const body = output.slice(begin + start.length + 3);
      const end = body.match(new RegExp('\\r?\\n' + done + '(\\d+)\\r?\\n'));
      if (!end) return;
      result = { exitCode: Number(end[1]), output: body.slice(0, end.index), sessionId: id, cleanupConfirmed: true };
      clean();
    });
    ws.on('error', () => clean(new Error('Relay connection failed')));
    ws.on('close', () => {
      if (!finished) {
        failure = new Error(`Relay disconnected; session cleanup unconfirmed: ${id}`);
        finish();
      }
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const get = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
  if (!get('--profile') || !(get('--command') || get('--command-file'))) {
    throw new Error('Usage: relay-exec.js --profile APP.json --command-file SCRIPT [--timeout 90]');
  }
  const command = get('--command-file') ? fs.readFileSync(path.resolve(get('--command-file')), 'utf8') : get('--command');
  const seconds = Number(get('--timeout') || 90);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300) throw new Error('Timeout must be 1..300 seconds');
  const result = await execute(readProfile(get('--profile')), command, { timeoutMs: seconds * 1000 });
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.exitCode ? 1 : 0;
}

module.exports = { execute, readProfile };
if (require.main === module) main().catch(error => {
  process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
  process.exitCode = 1;
});
