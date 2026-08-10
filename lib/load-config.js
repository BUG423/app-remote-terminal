'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_CONFIG_BYTES = 1024 * 1024;

function loadConfig(filePath, options = {}) {
  const label = options.label || 'configuration';
  const resolved = path.resolve(filePath);
  const before = fs.lstatSync(resolved);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be a regular file, not a link`);
  }

  let fd;
  let raw;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(resolved, flags);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new Error(`${label} changed while it was being opened`);
    }
    if (stat.size <= 0 || stat.size > MAX_CONFIG_BYTES) {
      throw new Error(`${label} must be between 1 byte and ${MAX_CONFIG_BYTES} bytes`);
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      const message = `${label} permissions are too broad; run chmod 600 ${resolved}`;
      if (process.env.NODE_ENV === 'production') throw new Error(message);
      console.warn(`⚠  ${message}`);
    }
    raw = fs.readFileSync(fd, 'utf8');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value;
}

module.exports = { loadConfig, MAX_CONFIG_BYTES };
