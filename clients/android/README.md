# Remote Terminal Android

Android 客户端在构建时把通用终端 UI 和 xterm 打进 APK，首次打开直接进入“设备”页，运行时只连接用户添加的阿里云 WSS 中转地址。每台设备的 Token 使用 Android Keystore 加密保存；应用关闭备份、明文网络、跨文件来源访问和 WebView 调试（Release）。

构建要求：JDK 17、Android SDK Platform 35、Build Tools 35.0.0。

```bash
npm ci --prefix .. --no-audit --no-fund
export JAVA_HOME=/path/to/jdk-17
export ANDROID_SDK_ROOT=/path/to/android-sdk
./gradlew lintDebug assembleDebug
```

调试 APK 输出到 `app/build/outputs/apk/debug/app-debug.apk`。应用使用 `adjustResize` 和系统 Insets 处理状态栏、刘海与输入法，键盘弹出时终端区域会随可视高度收缩。正式发布前还需要配置独立签名密钥和 release 签名块，密钥不得提交进仓库。
