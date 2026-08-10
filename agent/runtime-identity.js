'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function realDirectory(value, label) {
  const requested = requiredText(value, label);
  if (!path.isAbsolute(requested)) throw new Error(`${label} must be an absolute path`);
  let resolved;
  try {
    resolved = fs.realpathSync(requested);
  } catch {
    throw new Error(`${label} must already exist`);
  }
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} must be a directory`);
  return resolved;
}

/**
 * Bind the Agent to the account and environment explicitly approved by the
 * operator. A deployment tool cannot silently substitute a service account,
 * HOME or workspace: any mismatch stops startup before a PTY is created.
 */
function verifyRuntimeIdentity(config, runtime = {}) {
  const userInfo = runtime.userInfo || os.userInfo();
  const env = runtime.env || process.env;
  const platform = runtime.platform || process.platform;
  const cwd = realDirectory(runtime.cwd || process.cwd(), 'current working directory');
  const requiredUser = requiredText(config.requiredUser, 'requiredUser');
  const requiredHome = realDirectory(config.requiredHome, 'requiredHome');
  const requiredWorkingDirectory = realDirectory(
    config.requiredWorkingDirectory,
    'requiredWorkingDirectory'
  );

  if (userInfo.username !== requiredUser) {
    throw new Error(`Agent must run as ${requiredUser}; current user is ${userInfo.username}`);
  }
  if (platform !== 'win32') {
    if (!Number.isSafeInteger(config.requiredUid) || config.requiredUid < 0) {
      throw new Error('requiredUid is required on this platform');
    }
    const uid = runtime.uid === undefined
      ? (typeof process.getuid === 'function' ? process.getuid() : userInfo.uid)
      : runtime.uid;
    if (uid !== config.requiredUid || userInfo.uid !== config.requiredUid) {
      throw new Error(`Agent must run as uid ${config.requiredUid}; current uid is ${uid}`);
    }
  }

  const accountHome = realDirectory(userInfo.homedir, 'account home');
  const environmentHome = realDirectory(env.HOME || env.USERPROFILE, 'environment HOME');
  if (accountHome !== requiredHome || environmentHome !== requiredHome) {
    throw new Error(`Agent HOME must remain ${requiredHome}`);
  }
  if (cwd !== requiredWorkingDirectory) {
    throw new Error(`Agent must start in ${requiredWorkingDirectory}; current directory is ${cwd}`);
  }

  return Object.freeze({
    username: requiredUser,
    uid: platform === 'win32' ? null : config.requiredUid,
    home: requiredHome,
    workingDirectory: requiredWorkingDirectory,
  });
}

module.exports = { verifyRuntimeIdentity };
