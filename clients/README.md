# 客户端

Android 和桌面客户端共用阿里云中转协议。终端 UI 会在构建时打进 APK 或桌面安装包，运行时不下载云端网页；Relay 只保留 HTTPS/WSS 健康检查、鉴权和路由。

`ui/` 是通用客户端界面，`prepare-client-ui.js` 是两端共用的资源构建入口。它把 UI 和 `clients/node_modules` 中的 xterm 依赖复制到客户端构建目录。

## 发布顺序

1. 执行 `npm ci --prefix clients` 安装锁定的共用 UI 依赖
2. 在登录页配置真实中转域名并验证 Android/桌面 WSS
3. 打包 Android APK 和 Windows/macOS/Linux 安装包
4. 发布前完成签名、版本号和回归测试
