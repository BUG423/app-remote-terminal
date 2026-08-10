'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createTerminal } = require('./terminal');

const sessions = new Map();
const VALID_STATUSES = new Set(['running', 'exited']);
let WORKSPACE_ROOT = fs.realpathSync(process.cwd());

function setWorkspaceRoot(root) {
  if (typeof root !== 'string' || !root.trim() || !path.isAbsolute(root.trim())) {
    throw new Error('workspaceRoot must be an absolute existing directory');
  }
  const requested = root.trim();
  const resolved = path.resolve(requested);
  let realRoot;
  try {
    realRoot = fs.realpathSync(resolved);
  } catch {
    throw new Error('workspaceRoot must already exist; Agent never creates workspaces');
  }
  const stat = fs.statSync(realRoot);
  if (!stat.isDirectory()) throw new Error('workspaceRoot must be a directory');
  if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) {
    throw new Error('workspaceRoot must not be group- or world-writable');
  }
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('workspaceRoot must be owned by the current Agent user');
  }
  WORKSPACE_ROOT = realRoot;
  return WORKSPACE_ROOT;
}

function validSessionId(sessionId) {
  return typeof sessionId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(sessionId);
}

function createSession(sessionId, title, callbacks = {}) {
  if (!validSessionId(sessionId)) throw new Error('invalid sessionId');
  if (sessions.has(sessionId)) throw new Error('session already exists');
  const { onData, onExit } = callbacks;
  const safeTitle = typeof title === 'string'
    ? title.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
    : '';
  let terminal;
  terminal = createTerminal({
    sessionId,
    cwd: WORKSPACE_ROOT,
    onData: (data) => onData?.(sessionId, data),
    onExit: (event) => {
      const current = sessions.get(sessionId);
      if (!current || current.terminal !== terminal) return;
      current.status = 'exited';
      onExit?.(sessionId, event);
    },
  });

  const session = {
    id: sessionId,
    title: safeTitle || '新会话',
    cwd: WORKSPACE_ROOT,
    pid: terminal.pid,
    status: 'running',
    terminal,
    createdAt: Date.now(),
  };
  sessions.set(sessionId, session);
  console.log(`✅ 会话已创建: ${session.title} (${sessionId.slice(0, 8)})`);
  return session;
}

function destroySession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  console.log(`🗑  销毁会话: ${session.title} (${sessionId.slice(0, 8)})`);
  if (session.terminal) {
    session.terminal.kill('SIGTERM');
    const forceKill = setTimeout(() => session.terminal.kill('SIGKILL'), 3000);
    forceKill.unref();
  }
  return true;
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function listSessions() {
  return [...sessions.values()]
    .filter((session) => VALID_STATUSES.has(session.status))
    .map((session) => ({
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      pid: session.pid,
      status: session.status,
      createdAt: session.createdAt,
    }));
}

function destroyAllSessions() {
  for (const id of [...sessions.keys()]) destroySession(id);
}

module.exports = {
  setWorkspaceRoot,
  createSession,
  destroySession,
  getSession,
  listSessions,
  destroyAllSessions,
  validSessionId,
  get WORKSPACE_ROOT() {
    return WORKSPACE_ROOT;
  },
};
