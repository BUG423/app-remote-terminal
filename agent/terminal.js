'use strict';

const pty = require('node-pty');
const path = require('node:path');
const { buildTerminalEnv, resolveShell } = require('./terminal-environment');

function createTerminal({ sessionId, cwd, cols = 120, rows = 30, onData, onExit }) {
  const shell = resolveShell();
  const shellName = path.basename(shell).toLowerCase();
  const shellArgs = ['bash', 'zsh', 'sh', 'dash', 'ksh'].includes(shellName) ? ['-i'] : [];
  const ptyProcess = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: buildTerminalEnv(process.env, sessionId),
  });

  console.log(
    `🖥  终端已创建: ${sessionId.slice(0, 8)} (pid=${ptyProcess.pid}, shell=${shellName}, cwd=${cwd})`
  );

  ptyProcess.onData((data) => {
    if (!onData) return;
    try { onData(data); } catch (err) {
      console.error(`❌ 终端输出处理失败 [${sessionId.slice(0, 8)}]: ${err.message}`);
    }
  });

  ptyProcess.onExit((event) => {
    console.log(`🛑 终端退出: ${sessionId.slice(0, 8)} (code=${event.exitCode}, signal=${event.signal})`);
    if (!onExit) return;
    try { onExit(event); } catch (err) {
      console.error(`❌ 终端退出处理失败 [${sessionId.slice(0, 8)}]: ${err.message}`);
    }
  });

  return {
    write(data) {
      try {
        ptyProcess.write(data);
        return true;
      } catch (err) {
        console.error(`❌ 终端写入失败 [${sessionId.slice(0, 8)}]: ${err.message}`);
        return false;
      }
    },
    resize(nextCols, nextRows) {
      try {
        if (nextCols > 0 && nextRows > 0) ptyProcess.resize(nextCols, nextRows);
        return true;
      } catch (err) {
        console.error(`❌ 终端 resize 失败 [${sessionId.slice(0, 8)}]: ${err.message}`);
        return false;
      }
    },
    kill(signal = 'SIGTERM') {
      try { ptyProcess.kill(signal); } catch { /* process may already be gone */ }
    },
    get pid() {
      return ptyProcess.pid;
    },
  };
}

module.exports = { createTerminal };
