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
    'www/index.html', 'www/app.js', 'www/client-settings.js', 'www/device-store.js', 'www/strict-websocket.js',
    'www/vendor/xterm.js', 'www/vendor/xterm.css', 'www/vendor/addon-fit.js',
  ]) {
    assert(fs.existsSync(path.join(generated, file)), `缺少打包资源 ${file}`);
  }

  const html = fs.readFileSync(path.join(generated, 'www', 'index.html'), 'utf8');
  assert(html.includes('src="./app.js'));
  assert(html.includes('src="./client-settings.js'));
  assert(html.includes('src="./device-store.js'));
  assert(html.includes('href="./vendor/xterm.css'));
  assert(html.includes('id="mobile-tabbar"'));
  assert(html.includes('id="mobile-command-form"'));
  assert(html.includes('id="device-page"'));
  assert(html.includes('id="desktop-device-rail"'));
  assert(html.includes('id="desktop-device-list"'));
  assert(html.includes('id="desktop-active-device-name"'));
  assert(html.indexOf('id="desktop-device-rail"') < html.indexOf('id="sidebar"'));
  assert(html.indexOf('id="sidebar"') < html.indexOf('id="workspace"'));
  assert(html.includes('id="device-search-input"'));
  assert(html.includes('id="session-rename-modal"'));
  assert(html.includes('id="history-bottom-btn"'));
  assert(html.includes('data-mobile-view="sessions"'));
  assert(html.includes('id="main-screen" class="screen"'));
  assert(!html.includes('id="login-screen"'));
  assert(!html.includes('src="/'));
  assert(!html.includes('href="/'));

  const desktopMain = fs.readFileSync(path.join(root, 'clients/desktop/main.js'), 'utf8');
  assert(desktopMain.includes('win.loadFile(uiEntryPath())'));
  assert(!desktopMain.includes('win.loadURL('));
  assert(desktopMain.includes('safeStorage.encryptString(payload)'));
  assert(desktopMain.includes("safeStorage.getSelectedStorageBackend() !== 'basic_text'"));
  assert(desktopMain.includes('remote-terminal:device-credential-read'));
  assert(desktopMain.includes("fs.openSync(temporary, 'wx', 0o600)"));
  assert(desktopMain.includes('trustedIpcEvent'));
  assert(desktopMain.includes('setPermissionCheckHandler'));
  assert(desktopMain.includes("session.defaultSession.on('will-download'"));

  const androidMain = fs.readFileSync(
    path.join(root, 'clients/android/app/src/main/java/cn/remoteterminal/app/MainActivity.kt'),
    'utf8',
  );
  assert(androidMain.includes('file:///android_asset/www/index.html'));
  assert(!androidMain.includes('https://terminal.example.cn'));
  assert(androidMain.includes('AndroidKeyStore'));
  assert(androidMain.includes('AES/GCM/NoPadding'));
  assert(androidMain.includes('readDeviceCredential'));
  assert(androidMain.includes('ciphertext:$deviceId'));
  assert(androidMain.includes('override fun onBackPressed()'));
  assert(androidMain.includes('RemoteTerminalApp.handleBack()'));
  assert(androidMain.includes('setSystemBarStyle'));
  assert(androidMain.includes('WindowInsets.Type.ime()'));
  assert(androidMain.includes('maxOf(systemBars.bottom, ime.bottom)'));
  assert(androidMain.includes('FrameLayout(this)'));
  assert(androidMain.includes('WindowInsets.Type.displayCutout()'));
  assert(androidMain.includes('WindowInsets.CONSUMED'));
  assert(androidMain.includes('onRenderProcessGone'));
  assert(androidMain.includes('RemoteTerminalApp.onResume()'));
  assert(androidMain.includes('settings.allowUniversalAccessFromFileURLs = false'));
  assert(androidMain.includes('settings.safeBrowsingEnabled = true'));
  assert(!androidMain.includes('webView.saveState'));

  const manifest = fs.readFileSync(
    path.join(root, 'clients/android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  assert(manifest.includes('android:usesCleartextTraffic="false"'));

  const clientApp = fs.readFileSync(path.join(root, 'clients/ui/app.js'), 'utf8');
  assert(clientApp.includes('remote-terminal-relay-url'));
  assert(!clientApp.includes('location.host'));
  assert(!clientApp.includes('isPackagedClient'));
  assert(clientApp.includes("setMobileView('terminal')"));
  assert(clientApp.includes('mobileCommandForm'));
  assert(clientApp.includes('handleMobileBack'));
  assert(clientApp.includes('onViewportChanged: handleMobileViewportChanged'));
  assert(clientApp.includes("classList.toggle('keyboard-open'"));
  assert(clientApp.includes('new DeviceStore.DeviceRegistry(localStorage)'));
  assert(clientApp.includes('deviceRegistry.setSessionAlias'));
  assert(clientApp.includes('renderDesktopDeviceRail'));
  assert(clientApp.includes("$('desktop-rail-add-device')"));
  assert(clientApp.includes('term.onScroll'));
  assert(clientApp.includes('MAX_TERMINAL_INPUT_BYTES'));
  assert(clientApp.includes('requireValidBrowserToken'));
  assert(!clientApp.includes("loginForm.addEventListener('submit'"));

  console.log('✅ Android 与桌面客户端使用本地 UI，并仅通过可配置 WSS 中转');
} finally {
  fs.rmSync(generated, { recursive: true, force: true });
}
