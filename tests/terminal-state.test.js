'use strict';

const assert = require('assert');
const { Terminal } = require('../server/node_modules/@xterm/headless');
const { Unicode11Addon } = require('../server/node_modules/@xterm/addon-unicode11');
const { TerminalState, writeTerminal } = require('../server/terminal-state');

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`  ✅ ${name}`);
  } catch (err) {
    results.push(false);
    console.error(`  ❌ ${name}: ${err.stack || err.message}`);
  }
}

function visibleText(terminal) {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n');
}

async function rehydrate(snapshot) {
  const terminal = new Terminal({
    cols: snapshot.cols,
    rows: snapshot.rows,
    scrollback: 2000,
    allowProposedApi: true,
    logLevel: 'off',
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  await writeTerminal(terminal, snapshot.data);
  return terminal;
}

(async () => {
  console.log('╭──────────────────────────────────────────╮');
  console.log('│   终端状态快照与序列边界测试             │');
  console.log('╰──────────────────────────────────────────╯');

  await test('快照严格对应请求时的输出序列边界', async () => {
    const state = new TerminalState({ cols: 40, rows: 8 });
    const firstWrite = state.append('FIRST');
    const firstSnapshotPromise = state.snapshot();
    const secondWrite = state.append('-SECOND');
    await Promise.all([firstWrite.completion, secondWrite.completion]);

    const firstSnapshot = await firstSnapshotPromise;
    const finalSnapshot = await state.snapshot();
    assert.equal(firstSnapshot.sequence, 1);
    assert(firstSnapshot.data.includes('FIRST'));
    assert(!firstSnapshot.data.includes('SECOND'));
    assert.equal(finalSnapshot.sequence, 2);
    assert(finalSnapshot.data.includes('FIRST-SECOND'));
    state.dispose();
  });

  await test('ANSI 全屏界面与中文可从完整状态快照恢复', async () => {
    const state = new TerminalState({ cols: 50, rows: 10 });
    await state.append('\x1b[?1049h\x1b[2J\x1b[H\x1b[1;36m中文界面✅\x1b[0m\x1b[4;8H光标位置').completion;
    const snapshot = await state.snapshot();
    const restored = await rehydrate(snapshot);

    assert(!snapshot.data.includes('\ufffd'));
    assert(visibleText(restored).includes('中文界面✅'));
    assert(visibleText(restored).includes('光标位置'));
    assert.equal(restored.buffer.active.cursorX, state.terminal.buffer.active.cursorX);
    assert.equal(restored.buffer.active.cursorY, state.terminal.buffer.active.cursorY);
    restored.dispose();
    state.dispose();
  });

  await test('上游完整状态可原子替换中继状态并推进序号', async () => {
    const upstream = new TerminalState({ cols: 42, rows: 9 });
    await upstream.append('\x1b[2J\x1b[H上游恢复内容\x1b[5;3HEND').completion;
    const upstreamSnapshot = await upstream.snapshot();

    const relay = new TerminalState({ cols: 80, rows: 24 });
    await relay.append('这段旧中继内容必须被替换').completion;
    const restored = relay.restore(upstreamSnapshot.data, upstreamSnapshot.cols, upstreamSnapshot.rows);
    await restored.completion;
    const relaySnapshot = await relay.snapshot();
    const terminal = await rehydrate(relaySnapshot);

    assert.equal(restored.sequence, 2);
    assert.equal(relaySnapshot.sequence, 2);
    assert.equal(relaySnapshot.cols, 42);
    assert.equal(relaySnapshot.rows, 9);
    assert(visibleText(terminal).includes('上游恢复内容'));
    assert(!visibleText(terminal).includes('旧中继内容'));
    terminal.dispose();
    relay.dispose();
    upstream.dispose();
  });

  await test('历史过大时按完整终端行裁剪，不会从 UTF-8 或 ANSI 中间截断', async () => {
    const maxSnapshotBytes = 16 * 1024;
    const state = new TerminalState({
      cols: 80,
      rows: 10,
      scrollbackRows: 1000,
      maxSnapshotBytes,
    });
    for (let i = 0; i < 600; i++) {
      const color = 31 + (i % 7);
      await state.append(`\x1b[${color}m第${String(i).padStart(4, '0')}行-${'内容'.repeat(20)}\x1b[0m\r\n`).completion;
    }
    const snapshot = await state.snapshot();
    const restored = await rehydrate(snapshot);

    assert(snapshot.historyTruncated);
    assert(snapshot.bytes <= maxSnapshotBytes || snapshot.scrollbackRows === 0);
    assert(!snapshot.data.includes('\ufffd'));
    assert(visibleText(restored).includes('第0599行'));
    restored.dispose();
    state.dispose();
  });

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} 终端状态测试通过`);
  if (passed !== results.length) process.exitCode = 1;
})().catch((err) => {
  console.error('测试异常:', err);
  process.exitCode = 1;
});
