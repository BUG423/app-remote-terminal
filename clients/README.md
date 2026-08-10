# 客户端

Android 和桌面客户端共用阿里云中转协议。终端 UI 会在构建时打进 APK 或桌面安装包，运行时不下载云端网页；Relay 只保留 HTTPS/WSS 健康检查、鉴权和路由。

`ui/` 是通用客户端界面，`prepare-client-ui.js` 是两端共用的资源构建入口。它把 UI 和 `clients/node_modules` 中的 xterm 依赖复制到客户端构建目录。

## 发布顺序

1. 执行 `npm ci --prefix clients` 安装锁定的共用 UI 依赖
2. 启动客户端，在“设备”页添加真实中转域名和浏览器 Token，验证多设备切换与 WSS
3. 打包 Android APK 和 Windows/macOS/Linux 安装包
4. 发布前完成签名、版本号和回归测试

客户端不会显示强制登录页。桌面端使用“设备—会话—终端”三栏布局，Android 保持适合窄屏的分页与底部导航。设备名称、地址、当前选择和本地会话别名按设备保存；32–512 字符的浏览器 Token 不写入 `localStorage`，Android 使用 Keystore，桌面端使用操作系统安全存储。若桌面环境只能提供明文后端，Token 将只保留到本次退出。公网地址必须使用 WSS，自定义端口和路径均受支持。
