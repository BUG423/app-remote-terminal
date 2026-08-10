'use strict';

const assert = require('assert');
const {
  collectResourceWarnings,
  envFlag,
  positiveNumber,
  selectDevice,
} = require('../scripts/monitor-server');

const tests = [];

function test(name, fn) {
  try {
    fn();
    tests.push(true);
    console.log(`  ✅ ${name}`);
  } catch (err) {
    tests.push(false);
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

console.log('╔══════════════════════════════════════════╗');
console.log('║   Server 定期监控策略测试                ║');
console.log('╚══════════════════════════════════════════╝');

test('多设备配置必须显式选择被监控设备', () => {
  const config = { devices: { a: { browserToken: 'a'.repeat(32) }, b: { browserToken: 'b'.repeat(32) } } };
  assert.throws(() => selectDevice(config, ''), /RT_MONITOR_DEVICE_ID/);
  assert.equal(selectDevice(config, 'b').id, 'b');
});

test('设备选择只接受配置对象自己的属性', () => {
  assert.throws(() => selectDevice({ devices: {} }, '__proto__'), /not found/);
  assert.throws(() => selectDevice({ devices: [] }, ''), /RT_MONITOR_DEVICE_ID/);
});

test('资源阈值只报告实际越界指标', () => {
  const warnings = collectResourceWarnings(
    { load1: 5, cpuCount: 2, memoryAvailableMb: 200, diskUsedPercent: 70 },
    { loadPerCpu: 2, memoryAvailableMb: 256, diskUsedPercent: 85 }
  );
  assert.equal(warnings.length, 2);
  assert(warnings.some((item) => item.includes('load1')));
  assert(warnings.some((item) => item.includes('available memory')));
  assert(!warnings.some((item) => item.includes('disk usage')));
});

test('环境布尔值和数值限制使用安全默认值', () => {
  assert.equal(envFlag('yes'), true);
  assert.equal(envFlag('off', true), false);
  assert.equal(positiveNumber('300', 256, 64, 1024), 300);
  assert.equal(positiveNumber('9999', 256, 64, 1024), 256);
});

test('监控器不再持有扫描和杀死任意 Agent 进程的代码', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'monitor-server.js'), 'utf8');
  assert(!source.includes('process.kill('));
  assert(!source.includes("fs.readdirSync('/proc')"));
});

test('本机 TLS 探针固定 Relay 证书且不关闭证书校验', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'monitor-server.js'), 'utf8');
  assert(!source.includes('rejectUnauthorized: false'));
  assert(source.includes("crypto.timingSafeEqual(actualFingerprint, expectedFingerprint)"));
});

const passed = tests.filter(Boolean).length;
console.log(`\n${passed}/${tests.length} 监控策略测试通过`);
if (passed !== tests.length) process.exit(1);
