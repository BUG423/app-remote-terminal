# Remote Terminal Desktop

桌面客户端把终端界面打包在安装包内部，只通过 HTTPS/WSS 连接阿里云中转，不依赖服务器提供网页。

运行：

```bash
npm install
REMOTE_TERMINAL_URL=wss://你的域名 npm start
```

生成安装包：`npm run dist`。中转地址也可以在客户端登录页填写并保存在本机。
