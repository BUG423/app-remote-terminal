# Remote Terminal

Remote Terminal 是一套 Android、Windows、macOS 和 Linux 通用的远程终端软件。客户端与受控端 Agent 都主动连接 Relay，受控设备无需开放 SSH、RDP 或其他入站端口。

当前客户端版本为 `0.3.3`。浏览器网页端已下架；Relay 不托管页面、不依赖 Nginx，只保留健康检查、角色分离鉴权、设备路由和终端状态同步。

![Remote Terminal 设备管理界面](docs/images/screenshot.png)

## 功能

- 安装后直接进入软件，在“设备”页添加域名和浏览器 Token。
- 管理、搜索、重命名、删除和切换多台设备。
- 每台设备独立保存会话别名、置顶状态和当前会话。
- 新建、查看、搜索、重命名、置顶和删除终端会话。
- 完整终端快照、滚动历史、断线重连、序号断档重同步和渲染背压保护。
- Android 键盘顶起终端内容，并适配状态栏、刘海、导航栏和预测式返回。
- 桌面端支持快速切换、分屏、快捷键、大段粘贴确认和本地显示设置。

## 架构

```text
Android / Desktop ─────── WSS ──────────┐
                                        │
                                        ▼
                                Node.js Relay
                                        ▲
                                        │
Agent + node-pty ───────── WSS ─────────┘
        │
        └── 受控账户的 bash / zsh / PowerShell
```

Relay 的 HTTP 控制面只有：

- `GET /health`：健康检查。
- WebSocket：协议 v2 鉴权与终端消息。
- 其他路径：`410 Gone`。

协议角色名称 `browser` 是客户端兼容名称，不表示仍存在网页端。

## 客户端使用

1. 安装 APK 或桌面安装包。
2. 打开“设备”，选择“添加设备”。
3. 输入设备名称、Relay 地址和该设备的 `browserToken`。
4. 保存并连接，在“终端”页查看或新建会话。

地址支持域名、IP、自定义端口和路径，例如：

```text
wss://terminal.example.cn
wss://terminal.example.cn:8443/relay
```

公网连接必须使用 WSS，并提供与域名或 IP 匹配的有效 TLS 证书。`ws://` 仅允许本机回环测试。使用自定义端口时，需要在阿里云安全组和主机防火墙中放行对应 TCP 端口；生产环境优先使用 `443`。

## 本地数据与安全边界

普通本地配置只保存设备名称、WSS 地址、显示设置、会话别名和置顶状态。Token 不进入 `localStorage`：

- Android 使用 Android Keystore 的 AES-GCM 密钥加密，并关闭云备份和设备迁移备份。
- 桌面端使用 Electron `safeStorage` 和原子凭据文件；文件权限为 `0600`。
- Linux 若只有 `basic_text` 后端，软件拒绝持久化 Token，只在当前进程内保存。

每台设备必须使用两枚不同的随机 Token，长度为 32–512 个字符：

- `browserToken`：只允许原生客户端登录。
- `agentToken`：只允许受控端 Agent 登录。

持有有效 `browserToken` 的用户可以操作 Agent 当前账户权限范围内的完整 Shell。本项目不是多租户堡垒机，也不提供文件系统沙箱。Agent 必须绑定到管理员明确指定的既有用户、HOME 和工作目录；项目脚本和自动部署工具不得自行创建用户、工作目录或迁移原账户数据。如需隔离账户，必须由管理员另行明确授权并手工准备。

内置“逐按键审计日志”已移除，因为它会记录密码、私钥口令和其他交互式秘密。需要合规审计时，应在受控设备上使用操作系统级方案，并设置明确的脱敏、访问控制和留存策略。

## Relay 配置

生成两枚独立随机 Token：

```bash
node -e "for(let i=0;i<2;i++) console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

复制 [config.json.example](config.json.example)，只配置 Relay：

```json
{
  "port": 443,
  "bindHost": "0.0.0.0",
  "useTLS": true,
  "tlsCertPath": "/etc/remote-terminal/tls/fullchain.pem",
  "tlsKeyPath": "/etc/remote-terminal/tls/privkey.pem",
  "devices": {
    "production-a": {
      "name": "生产服务器 A",
      "browserToken": "客户端随机Token",
      "agentToken": "另一枚Agent随机Token"
    }
  }
}
```

生产模式拒绝符号链接配置和组/其他用户可读的配置文件：

```bash
sudo install -o remote-terminal-server -g remote-terminal-server -m 0600 \
  config.json /etc/remote-terminal/server.json
```

安装依赖并启用低权限 systemd 服务：

```bash
npm ci --prefix /opt/remote-terminal/server --omit=dev --no-audit --no-fund
sudo install -m 0644 deploy/systemd/remote-terminal-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now remote-terminal-server.service
```

Relay 可直接提供 TLS，不需要 Nginx。证书部署脚本会把 Certbot 证书原子复制到受限目录并重启服务：

```bash
sudo certbot certonly --standalone -d terminal.example.cn
sudo scripts/install-relay-certificate.sh terminal.example.cn
```

## Agent 配置

先在准备运行 Agent 的原始终端中记录身份，不能使用 `sudo` 切换用户：

```bash
id -un
id -u
printf '%s\n' "$HOME"
pwd -P
```

复制 [agent/config.json.example](agent/config.json.example)，把以上结果原样写入身份绑定字段：

```json
{
  "agentToken": "与 Relay 对应设备的 agentToken 一致",
  "serverUrl": "wss://terminal.example.cn",
  "requiredUser": "当前用户名",
  "requiredUid": 1000,
  "requiredHome": "/home/当前用户",
  "requiredWorkingDirectory": "/已经存在的原始工作目录",
  "maxSessions": 12
}
```

Agent 不会创建工作目录。配置的用户、UID、HOME 或启动目录只要有一项不一致，Agent 就会在创建终端前拒绝启动。这样 `cloud`、`codex`、Shell 配置和当前用户凭据均沿用原环境。

配置文件只需由当前用户保护：

```bash
chmod 600 agent/config.json
./start-local.sh
```

需要后台常驻时，可将 [remote-terminal-agent.service](deploy/systemd/remote-terminal-agent.service) 安装为当前用户的 `systemctl --user` 单元，并参考 [agent.env.example](deploy/systemd/remote-terminal-agent.env.example) 在 `~/.config/remote-terminal/agent.env` 中填写既有工作目录、Agent 入口和配置路径。不得安装为系统级服务，不得添加 `User=`/`Group=`，也不得执行 `useradd`、`adduser`、`chown` 或创建替代 HOME。若使用 PM2，也必须由当前用户直接运行并显式设置原始 `cwd`，不能使用 `sudo pm2`。

受限网络可使用 `proxyUrl`、`HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY`。私有 CA 使用绝对路径 `tlsCaPath`；不要关闭 TLS 校验。

## 构建客户端

共用 UI：

```bash
npm ci --prefix clients --no-audit --no-fund
```

Android 需要 JDK 17、Android SDK Platform 35 和 Build Tools 35.0.0：

```bash
cd clients/android
./gradlew lintDebug assembleDebug
./gradlew lintRelease assembleRelease
```

输出：

```text
clients/android/app/build/outputs/apk/debug/app-debug.apk
clients/android/app/build/outputs/apk/release/app-release-unsigned.apk
```

桌面端使用 Electron 43：

```bash
cd clients/desktop
npm ci
npm run smoke
npm run dist
npm run dist:win:zip
```

常用输出：

```text
clients/desktop/dist/Remote Terminal-0.3.3.AppImage
clients/desktop/dist/Remote Terminal-0.3.3-win.zip
```

仓库不保存发布签名密钥。正式分发前应在受控发布环境签名 Android、Windows 和 macOS 安装包。

## 更新与监控

`deploy.sh` 只接受现有、干净的 Git 工作区和已安装的 systemd 服务。它不会上传 Token、修改防火墙、回退到 PM2 或部署网页：

```bash
SERVER_HOST=服务器地址 \
SERVER_SSH_PORT=822 \
REMOTE_DIR=/opt/remote-terminal \
REMOTE_CONFIG_PATH=/etc/remote-terminal/server.json \
bash deploy.sh
```

可选的 `remote-terminal-monitor.*` 每五分钟检查 Relay、TLS、Agent 在线状态和资源阈值。自动恢复默认关闭；只有显式设置 `RT_MONITOR_AUTO_HEAL=1` 才会尝试重启一次 Relay。

## 测试

```bash
npm ci --prefix clients --no-audit --no-fund
npm ci --prefix server --no-audit --no-fund
npm ci --prefix agent --no-audit --no-fund
npm test
bash scripts/run-server-tests.sh
npm run test:latency
cd clients/desktop
npm run latency:ui
```

测试覆盖角色隔离、配置权限、限流、异常 JSON/二进制协议、重复 Agent 竞态、真实 PTY、历史快照、断线恢复、渲染背压、TLS、客户端离线打包和设备管理。延迟测试使用临时本机 Relay、假 Agent 和真实 PTY，不连接或重启生产设备；界面延迟测试同时覆盖桌面与手机宽度、终端自动铺满和突发输出阻塞。

## 目录

```text
clients/ui/            Android 与桌面端共用的离线 UI
clients/android/       Android WebView、Keystore 与系统 Insets
clients/desktop/       Electron、safeStorage 与桌面打包
server/                原生 HTTPS/WSS Relay
agent/                 node-pty 终端 Agent
lib/                   安全配置读取与终端状态公共实现
deploy/systemd/        低权限服务与监控单元
scripts/               证书、测试和运维脚本
tests/                 单元、协议、TLS、恢复与安全测试
```

## 许可证

MIT，见 [LICENSE](LICENSE)。
