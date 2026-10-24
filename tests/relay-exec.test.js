'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WebSocket = require('./ws-client');
const { execute } = require('../scripts/relay-exec');

(async () => {
  let executions = 0, deletes = 0, creations = 0, attaches = 0;
  const server = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  server.on('connection', ws => {
    let input = '';
    const send = data => ws.send(JSON.stringify(data));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.type === 'auth') return send({ type: 'auth_ok', agentOnline: true });
      if (m.type === 'terminal_create') {
        creations++;
        if (creations === 3) {
          // Creation confirmation arrives only after the command deadline.
          return setTimeout(() => {
            send({ type: 'terminal_created', sessionId: m.sessionId });
            send({ type: 'terminal_attached', sessionId: m.sessionId });
          }, 150);
        }
        return send({ type: 'terminal_created', sessionId: m.sessionId });
      }
      if (m.type === 'terminal_attach') {
        attaches++;
        send({ type: 'terminal_attached', sessionId: m.sessionId });
        return send({ type: 'terminal_attached', sessionId: m.sessionId });
      }
      if (m.type === 'terminal_delete') {
        deletes++;
        return setTimeout(() => send({ type: 'terminal_closed', sessionId: m.sessionId }), creations === 3 ? 80 : 30);
      }
      if (m.type !== 'terminal_input') return;
      assert(Buffer.byteLength(m.data) <= 4096);
      input += m.data;
      if (!input.endsWith('\r')) return;
      executions++;
      assert(Math.max(...input.split('\n').map(line => line.length)) < 4096);
      if (executions === 2) return; // A stalled remote command must clean up.
      // PTY echo contains the marker spelling: it must never finish the call.
      send({ type: 'terminal_output', sessionId: m.sessionId, data: input.replaceAll('\n', '\r\n') });
      const child = spawn('bash', ['-c', input.slice(0, -1)], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', data => send({ type: 'terminal_output', sessionId: m.sessionId,
                                           data: data.toString().replaceAll('\n', '\r\n') }));
    });
  });
  const profile = { relayUrl: `ws://127.0.0.1:${server.address().port}`, browserToken: 'x'.repeat(40) };
  try {
    const result = await execute(profile, "# " + 'padding'.repeat(2500) + "\nprintf '%s\\n' 'unicode 中文 $() `literal`'\nexit 7", { timeoutMs: 5000 });
    assert.equal(result.exitCode, 7);
    assert.equal(result.output.trim(), 'unicode 中文 $() `literal`');
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(executions, 1);
    assert.equal(deletes, 1);
    await assert.rejects(execute(profile, 'stalled command', { timeoutMs: 100 }), /timed out/);
    assert.equal(deletes, 2);
    await assert.rejects(execute(profile, 'must never run after timeout', { timeoutMs: 100 }), /timed out/);
    assert.equal(deletes, 3);
    assert.equal(executions, 2);
    assert.equal(attaches, 2);
    console.log('relay-exec: long input, quoting, framing, duplicate attach, exit code, timeout, late creation and confirmed cleanup passed');
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
