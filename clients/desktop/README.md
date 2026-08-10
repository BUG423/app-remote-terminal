# Remote Terminal Desktop

桌面客户端把终端界面打包在安装包内部，只通过 HTTPS/WSS 连接阿里云中转，不依赖服务器提供网页。

运行：

```bash
npm install
REMOTE_TERMINAL_URL=wss://你的域名 npm start
```

生成安装包：`npm run dist`。首次启动无需登录；桌面主界面采用三栏布局：左栏快速切换设备并在底部进入管理和设置，中栏管理当前设备的终端会话，右栏显示并操作选中的终端。在“设备管理”页仍可添加、搜索、重命名、删除设备。`REMOTE_TERMINAL_URL` 只用于预填新设备的默认中转地址。Token 使用 Electron `safeStorage` 加密并原子保存；Linux 环境若只能提供 `basic_text` 后端，则不会持久化 Token。当前运行时为 Electron 43。

桌面三栏和移动布局视觉回归可分别运行 `npm run visual:desktop`、`npm run visual:mobile`，截图默认写入 `/tmp`。运行 `npm run latency:ui` 可用临时本机 Relay 和假 Agent 检查桌面/手机宽度下的回显延迟、终端尺寸和突发输出阻塞，不会连接生产设备。
