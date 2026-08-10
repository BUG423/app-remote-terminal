# 界面截图

`screenshot.png` 是根 README 使用的设备管理界面截图。

桌面三栏布局视觉回归脚本可生成设备栏、会话栏和终端工作区截图：

```bash
cd clients/desktop
npm run visual:desktop
```

默认输出到 `/tmp/remote-terminal-desktop.png`。

桌面端的移动布局视觉回归脚本可生成会话列表和键盘态截图：

```bash
cd clients/desktop
npm run visual:mobile
```

默认输出到 `/tmp/remote-terminal-mobile-sessions.png` 和 `/tmp/remote-terminal-mobile-terminal.png`；可用 `REMOTE_TERMINAL_VISUAL_DIR` 指定目录。
