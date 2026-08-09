'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const smokeUserData = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'remote-terminal-desktop-smoke-'));

const localLibraries = path.join(__dirname, '..', '..', '..', '.tools', 'electron-libs', 'usr', 'lib', 'x86_64-linux-gnu');
const libraryPath = fs.existsSync(localLibraries)
  ? [localLibraries, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')
  : process.env.LD_LIBRARY_PATH;

try {
  const result = spawnSync(electron, ['--headless', '--disable-gpu', '--no-sandbox', '.'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      LD_LIBRARY_PATH: libraryPath,
      REMOTE_TERMINAL_SMOKE: '1',
      REMOTE_TERMINAL_SMOKE_USER_DATA: smokeUserData,
    },
    timeout: 30000,
  });

  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.includes('DESKTOP_SMOKE_OK')) process.exitCode = 1;
} finally {
  fs.rmSync(smokeUserData, { recursive: true, force: true });
}
