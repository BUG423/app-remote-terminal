'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolveShell(env = process.env, platform = os.platform()) {
  if (platform === 'win32') return env.COMSPEC || 'powershell.exe';
  const candidates = [env.SHELL, '/bin/bash', '/bin/sh'].filter(Boolean);
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* try the next safe shell */ }
  }
  throw new Error('no executable interactive shell is available');
}

function buildTerminalEnv(source, sessionId) {
  const result = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (/^CW_/.test(key) || key === 'CLAUDE_WEB_TOKEN' || key === 'REMOTE_TERMINAL_AGENT_TOKEN') continue;
    result[key] = value;
  }
  result.TERM = 'xterm-256color';
  result.COLORTERM = 'truecolor';
  result.REMOTE_TERMINAL_SESSION_ID = sessionId;
  return result;
}

module.exports = { buildTerminalEnv, resolveShell };
