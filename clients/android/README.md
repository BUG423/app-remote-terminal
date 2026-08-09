# Remote Terminal Android

Android 客户端在构建时把通用终端 UI 和 xterm 打进 APK，运行时只连接登录页配置的阿里云 HTTPS/WSS 中转地址。

构建要求：JDK 17、Android SDK Platform 35、Build Tools 35.0.0。

```bash
npm ci --prefix .. --no-audit --no-fund
export JAVA_HOME=/path/to/jdk-17
export ANDROID_SDK_ROOT=/path/to/android-sdk
./gradlew assembleDebug
```

调试 APK 输出到 `app/build/outputs/apk/debug/app-debug.apk`。正式发布前还需要配置独立签名密钥和 release 签名块，密钥不得提交进仓库。
