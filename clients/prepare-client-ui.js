'use strict';

const fs = require('node:fs');
const path = require('node:path');

const clientsRoot = path.resolve(__dirname);
const outputDir = path.resolve(process.cwd(), process.argv[2] || '');

if (!process.argv[2] || (outputDir !== clientsRoot && !outputDir.startsWith(`${clientsRoot}${path.sep}`))) {
  throw new Error('输出目录必须位于 clients/ 内');
}

const uiDir = path.join(clientsRoot, 'ui');
const vendorFiles = {
  'xterm.js': path.join(clientsRoot, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'),
  'xterm.css': path.join(clientsRoot, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
  'addon-fit.js': path.join(clientsRoot, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
  'addon-unicode11.js': path.join(clientsRoot, 'node_modules', '@xterm', 'addon-unicode11', 'lib', 'addon-unicode11.js'),
};

for (const source of [uiDir, ...Object.values(vendorFiles)]) {
  if (!fs.existsSync(source)) throw new Error(`缺少客户端资源：${source}`);
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outputDir, 'www', 'vendor'), { recursive: true });
fs.cpSync(uiDir, path.join(outputDir, 'www'), { recursive: true });

for (const [name, source] of Object.entries(vendorFiles)) {
  fs.copyFileSync(source, path.join(outputDir, 'www', 'vendor', name));
}

console.log(`客户端 UI 已生成：${path.join(outputDir, 'www')}`);
