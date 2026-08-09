'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const generated = path.join(root, 'clients', '.test-client-assets');

try {
  const result = spawnSync(process.execPath, ['clients/prepare-client-ui.js', generated], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  for (const file of [
    'www/index.html', 'www/app.js', 'www/client-settings.js', 'www/strict-websocket.js',
    'www/vendor/xterm.js', 'www/vendor/xterm.css', 'www/vendor/addon-fit.js',
  ]) {
    assert(fs.existsSync(path.join(generated, file)), `缺少打包资源 ${file}`);
  }

  const html = fs.readFileSync(path.join(generated, 'www', 'index.html'), 'utf8');
  assert(html.includes('src="./app.js'));
  assert(html.includes('src="./client-settings.js'));
  assert(html.includes('href="./vendor/xterm.css'));
  assert(html.includes('id="mobile-tabbar"'));
  assert(html.includes('id="mobile-command-form"'));
  assert(html.includes('data-mobile-view="sessions"'));
  assert(!html.includes('src="/'));
  assert(!html.includes('href="/'));

  const desktopMain = fs.readFileSync(path.join(root, 'clients/desktop/main.js'), 'utf8');
  assert(desktopMain.includes("win.loadFile(path.join(__dirname, 'ui', 'www', 'index.html'))"));
  assert(!desktopMain.includes('win.loadURL('));
  assert(desktopMain.includes('safeStorage.encryptString(token)'));
  assert(desktopMain.includes("mode: 0o600"));

  const androidMain = fs.readFileSync(
    path.join(root, 'clients/android/app/src/main/java/cn/remoteterminal/app/MainActivity.kt'),
    'utf8',
  );
  assert(androidMain.includes('file:///android_asset/www/index.html'));
  assert(!androidMain.includes('https://terminal.example.cn'));
  assert(androidMain.includes('AndroidKeyStore'));
  assert(androidMain.includes('AES/GCM/NoPadding'));
  assert(androidMain.includes('override fun onBackPressed()'));
  assert(androidMain.includes('RemoteTerminalApp.handleBack()'));
  assert(androidMain.includes('setSystemBarStyle'));
  assert(androidMain.includes('WindowInsets.Type.ime()'));
  assert(androidMain.includes('maxOf(systemBars.bottom, ime.bottom)'));
  assert(androidMain.includes('FrameLayout(this)'));
  assert(androidMain.includes('WindowInsets.Type.displayCutout()'));
  assert(androidMain.includes('WindowInsets.CONSUMED'));

  const manifest = fs.readFileSync(
    path.join(root, 'clients/android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  assert(manifest.includes('android:usesCleartextTraffic="false"'));

  const clientApp = fs.readFileSync(path.join(root, 'clients/ui/app.js'), 'utf8');
  assert(clientApp.includes('remote-terminal-relay-url'));
  assert(clientApp.includes("location.protocol === 'file:'"));
  assert(clientApp.includes("setMobileView('terminal')"));
  assert(clientApp.includes('mobileCommandForm'));
  assert(clientApp.includes('handleMobileBack'));
  assert(clientApp.includes('onViewportChanged: handleMobileViewportChanged'));
  assert(clientApp.includes("classList.toggle('keyboard-open'"));

  console.log('✅ Android 与桌面客户端使用本地 UI，并仅通过可配置 WSS 中转');
} finally {
  fs.rmSync(generated, { recursive: true, force: true });
}
