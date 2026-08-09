'use strict';

const assert = require('assert');
const { StrictWebSocketClient } = require('../clients/ui/strict-websocket');
const { TerminalStreamController } = require('../clients/ui/terminal-stream');

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push(true);
    console.log(`  ✅ ${name}`);
  } catch (err) {
    results.push(false);
    console.error(`  ❌ ${name}: ${err.stack || err.message}`);
  }
}

class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.sent = [];
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 2; }
  open() { this.readyState = 1; this.onopen(); }
  message(data) { this.onmessage({ data: JSON.stringify(data) }); }
  closeEvent() { this.readyState = 3; this.onclose({ code: 1006 }); }
}

class ControlledTerminal {
  constructor() {
    this.writes = [];
    this.resizes = [];
    this.resetCount = 0;
  }
  write(data, callback) { this.writes.push({ data, callback }); }
  resize(cols, rows) { this.resizes.push([cols, rows]); }
  reset() { this.resetCount++; }
  complete(index) { this.writes[index].callback(); }
}

console.log('╭──────────────────────────────────────────╮');
console.log('│   浏览器连接状态与渲染背压测试           │');
console.log('╰──────────────────────────────────────────╯');

test('连接中重复 connect 不会创建第二条 WebSocket', () => {
  const sockets = [];
  const client = new StrictWebSocketClient({
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    getUrl: () => 'ws://test',
    getToken: () => 'token',
    onMessage: () => {},
  });
  assert(client.connect());
  assert.equal(client.connect(), false);
  assert.equal(sockets.length, 1);
});

test('旧连接的 message/close 事件不能污染新连接状态', () => {
  const sockets = [];
  const messages = [];
  let disconnects = 0;
  let timers = 0;
  const client = new StrictWebSocketClient({
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    getUrl: () => 'ws://test',
    getToken: () => 'token',
    onMessage: (data) => messages.push(data),
    onDisconnect: () => { disconnects++; },
    setTimer: () => { timers++; return timers; },
    clearTimer: () => {},
  });

  client.connect();
  const oldSocket = sockets[0];
  oldSocket.readyState = 3;
  client.connect();
  const currentSocket = sockets[1];
  currentSocket.open();
  client.markAuthenticated();

  oldSocket.message({ type: 'terminal_output', data: 'STALE' });
  oldSocket.closeEvent();
  assert.equal(client.socket, currentSocket);
  assert.equal(client.authenticated, true);
  assert.deepEqual(messages, []);
  assert.equal(disconnects, 0);
  assert.equal(timers, 0);
});

test('有效连接关闭只安排一个重连定时器', () => {
  const socket = new FakeSocket();
  const callbacks = [];
  const client = new StrictWebSocketClient({
    createSocket: () => socket,
    getUrl: () => 'ws://test',
    getToken: () => 'token',
    onMessage: () => {},
    setTimer: (fn) => { callbacks.push(fn); return callbacks.length; },
    clearTimer: () => {},
    random: () => 0.5,
  });
  client.connect();
  socket.open();
  assert.equal(socket.sent[0].protocolVersion, 2);
  socket.closeEvent();
  socket.closeEvent();
  assert.equal(callbacks.length, 1);
});

test('重连定时器不会以连接对象作为错误的函数 receiver', () => {
  const socket = new FakeSocket();
  let scheduled = false;
  function receiverSensitiveTimer() {
    assert.equal(this, undefined);
    scheduled = true;
    return 1;
  }
  const client = new StrictWebSocketClient({
    createSocket: () => socket,
    getUrl: () => 'ws://test',
    getToken: () => 'token',
    onMessage: () => {},
    setTimer: receiverSensitiveTimer,
    clearTimer: () => {},
  });
  client.connect();
  socket.open();
  socket.closeEvent();
  assert(scheduled);
});

test('xterm 同一时间只接收一个 write，并合并高频连续输出', () => {
  const terminal = new ControlledTerminal();
  const stream = new TerminalStreamController(terminal);
  stream.applySnapshot({ data: 'SNAP', seq: 5, cols: 80, rows: 24 });
  assert(stream.acceptOutput('SIX', 6));
  assert(stream.acceptOutput('SEVEN', 7));
  assert.deepEqual(terminal.writes.map((item) => item.data), ['SNAP']);
  assert.equal(terminal.resetCount, 1);
  assert.deepEqual(terminal.resizes, [[80, 24]]);

  terminal.complete(0);
  assert.deepEqual(terminal.writes.map((item) => item.data), ['SNAP', 'SIXSEVEN']);
  terminal.complete(1);
  assert.equal(stream.pendingBytes, 0);
});

test('一万条突发输出保持顺序且只形成一个待渲染批次', () => {
  const terminal = new ControlledTerminal();
  const stream = new TerminalStreamController(terminal, { maxPendingBytes: 1024 * 1024 });
  stream.applySnapshot({ data: '', seq: 0, cols: 80, rows: 24 });
  for (let sequence = 1; sequence <= 10000; sequence++) {
    assert(stream.acceptOutput(`${sequence},`, sequence));
  }
  assert.equal(stream.queue.length, 1);
  terminal.complete(0);
  assert.equal(terminal.writes.length, 2);
  assert(terminal.writes[1].data.startsWith('1,2,3,'));
  assert(terminal.writes[1].data.endsWith('9999,10000,'));
  terminal.complete(1);
});

test('序号断档会停止增量渲染并只请求一次完整同步', () => {
  const terminal = new ControlledTerminal();
  let resyncs = 0;
  const stream = new TerminalStreamController(terminal, { onResync: () => { resyncs++; } });
  stream.applySnapshot({ data: '', seq: 10, cols: 80, rows: 24 });
  assert.equal(stream.acceptOutput('gap', 12), false);
  assert.equal(stream.acceptOutput('ignored', 13), false);
  assert.equal(resyncs, 1);
  assert.equal(stream.accepting, false);
});

test('渲染待处理数据超过上限时丢弃队列并触发安全重同步', () => {
  const terminal = new ControlledTerminal();
  let resyncs = 0;
  const stream = new TerminalStreamController(terminal, {
    maxPendingBytes: 12,
    onResync: () => { resyncs++; },
  });
  stream.applySnapshot({ data: '', seq: 1, cols: 80, rows: 24 });
  stream.acceptOutput('中文', 2); // 6 UTF-8 bytes, queued behind the snapshot write
  assert.equal(stream.acceptOutput('abcdefg', 3), false);
  assert.equal(resyncs, 1);
  assert.equal(stream.queue.length, 0);
});

test('xterm write 同步异常时清空后续队列并请求重同步', () => {
  let resyncs = 0;
  const terminal = {
    resize() {},
    reset() {},
    write() { throw new Error('renderer failed'); },
  };
  const stream = new TerminalStreamController(terminal, { onResync: () => { resyncs++; } });
  assert(stream.applySnapshot({ data: 'BROKEN', seq: 4, cols: 80, rows: 24 }));
  assert.equal(resyncs, 1);
  assert.equal(stream.writing, false);
  assert.equal(stream.queue.length, 0);
  assert.equal(stream.accepting, false);
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 浏览器状态测试通过`);
if (passed !== results.length) process.exit(1);
