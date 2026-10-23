'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Write credentials beside the destination, then publish them with one rename.
// Existing files require an explicit replacement and retain their owner.
function writePrivateJson(filePath, value, { replace = false } = {}) {
  const destination = path.resolve(filePath);
  let previous;
  try { previous = fs.lstatSync(destination); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (previous && (!previous.isFile() || previous.isSymbolicLink())) {
    throw new Error('配置必须是普通文件，不能是符号链接：' + destination);
  }
  if (previous && !replace) throw new Error('配置已存在，请保留原文件或明确使用 --replace：' + destination);

  const temporary = destination + '.' + crypto.randomUUID() + '.tmp';
  let backupPath;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    if (previous && process.platform !== 'win32') fs.fchownSync(fd, previous.uid, previous.gid);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (previous) {
      backupPath = destination + '.' + crypto.randomUUID() + '.bak';
      // Create the backup with restrictive permissions before copying any bytes.
      const backupFd = fs.openSync(backupPath, 'wx', 0o600);
      try {
        fs.writeFileSync(backupFd, fs.readFileSync(destination));
        if (process.platform !== 'win32') fs.fchownSync(backupFd, previous.uid, previous.gid);
        fs.fsyncSync(backupFd);
      } finally { fs.closeSync(backupFd); }
      fs.renameSync(temporary, destination);
    } else {
      // link() refuses to overwrite a destination created by another process.
      fs.linkSync(temporary, destination);
      fs.unlinkSync(temporary);
    }
    return { path: destination, backupPath };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

module.exports = { writePrivateJson };
