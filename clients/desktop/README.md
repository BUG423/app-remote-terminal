# Remote Terminal Desktop

桌面客户端把终端界面打包在安装包内部，只通过 HTTPS/WSS 连接阿里云中转，不依赖服务器提供网页。

运行：

```bash
npm install
REMOTE_TERMINAL_URL=wss://你的域名 npm start
```

生成安装包：`npm run dist`。首次启动无需登录；在“设备”页添加、搜索、重命名、删除或切换设备。`REMOTE_TERMINAL_URL` 只用于预填新设备的默认中转地址。Token 使用 Electron `safeStorage` 加密保存；Linux 环境若只能提供 `basic_text` 后端，则不会持久化 Token。
