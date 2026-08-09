'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');

const localLibraries = path.join(__dirname, '..', '..', '..', '.tools', 'electron-libs', 'usr', 'lib', 'x86_64-linux-gnu');
const libraryPath = fs.existsSync(localLibraries)
  ? [localLibraries, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')
  : process.env.LD_LIBRARY_PATH;

const result = spawnSync(electron, ['--headless', '--disable-gpu', '--no-sandbox', '.'], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8',
  env: { ...process.env, LD_LIBRARY_PATH: libraryPath, REMOTE_TERMINAL_SMOKE: '1' },
  timeout: 30000,
});

process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) throw result.error;
if (result.status !== 0 || !result.stdout.includes('DESKTOP_SMOKE_OK')) process.exit(1);
