# Remote Terminal

Remote Terminal 是 Android 与桌面端共用的远程终端客户端。客户端和 Agent 都主动连接阿里云 Relay；Agent 不需要开放 SSH、RDP 或其他入站端口，浏览器网页端不再提供。

![客户端界面](docs/images/screenshot.png)

## 能力

- 基于 `xterm.js` 与 `node-pty` 的真实交互式 Shell
- 多会话、快速切换、分屏、历史回放和断线恢复
- 输出序号校验、渲染背压与完整终端快照重同步
- Android 与桌面客户端内置 UI，不从云端下载页面或脚本
- 客户端与 Agent 分离凭据，多设备独立路由
- WSS、出口代理、会话/连接/消息/缓存上限
- 命令输入审计、私有文件权限与日志轮转

持有有效客户端 Token 的用户可以操作 Agent 运行账户权限范围内的完整 Shell。本项目不是 SSH 的等价安全实现，也不是多租户堡垒机。

## 精简架构

```text
Android / Desktop ── WSS 443 ──┐
                               ├── Node Relay（原生 TLS，单进程）
Agent ───────────── WSS 443 ───┘             │
                                             │ Token 路由
Agent 上的 node-pty / bash / zsh  <──────────┘
```

Relay 只提供 `/health` 和 WSS 鉴权/路由；其他普通 HTTP 请求统一返回 `410 Gone`。它不包含客户端 UI、Express、Nginx 或静态资源依赖。所有命令都在 Agent 所在机器执行，终端状态不会写入 Relay 磁盘。

协议中的客户端角色字段仍叫 `browser`，这是为了兼容已经安装的 Android/桌面客户端，不代表服务器仍提供网页端。

## 目录

- `clients/ui/`：Android 与桌面端共用的离线 UI
- `clients/android/`：Android WebView 外壳和系统安全能力
- `clients/desktop/`：Electron 桌面外壳
- `server/`：精简 HTTPS/WSS Relay
- `agent/`：远端终端 Agent
- `deploy/systemd/`：低权限服务与定期监控单元

## 配置

复制示例并生成两枚不同的随机 Token：

```bash
cp config.json.example config.json
node -e "for(let i=0;i<2;i++) console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

生产 Relay 的关键配置：

```json
{
  "port": 443,
  "bindHost": "0.0.0.0",
  "useTLS": true,
  "tlsCertPath": "/etc/remote-terminal/tls/fullchain.pem",
  "tlsKeyPath": "/etc/remote-terminal/tls/privkey.pem",
  "enableHttpRedirect": false,
  "devices": {
    "production-a": {
      "name": "生产服务器 A",
      "browserToken": "客户端随机Token",
      "agentToken": "另一个Agent随机Token"
    }
  }
}
```

Agent 配置：

```json
{
  "agentToken": "与Relay中对应设备的agentToken完全一致",
  "serverUrl": "wss://terminal.example.cn",
  "workspaceRoot": "/srv/remote-terminal-workspace",
  "maxSessions": 12,
  "offlineOutputBytes": 262144,
  "auditEnabled": true,
  "auditLogPath": "/var/log/remote-terminal/audit.log"
}
```

旧版 `tokens` / `token` 仍可迁移使用，但新部署应使用 `devices` 双凭据模式。`workspaceRoot` 是终端起始目录，不是操作系统沙箱。

## 部署 Relay

Relay 推荐使用仓库内的 systemd 单元。它以独立低权限账户运行，只额外获得绑定 443 所需的 `CAP_NET_BIND_SERVICE`：

```bash
cd /opt/remote-terminal/server
npm ci --omit=dev --no-audit --no-fund

sudo install -m 0644 /opt/remote-terminal/deploy/systemd/remote-terminal-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable remote-terminal-server.service
```

首次签发证书时，让 Certbot standalone 临时使用 80；Relay 本身只监听 443：

```bash
sudo certbot certonly --standalone -d terminal.example.cn
sudo /opt/remote-terminal/scripts/install-relay-certificate.sh terminal.example.cn
sudo ln -s /opt/remote-terminal/scripts/install-relay-certificate.sh \
  /etc/letsencrypt/renewal-hooks/deploy/remote-terminal-relay
sudo systemctl restart remote-terminal-server.service
```

续期配置应使用 standalone，并通过 dry-run 验证：

```bash
sudo certbot reconfigure --cert-name terminal.example.cn --standalone
sudo certbot renew --cert-name terminal.example.cn --dry-run --no-random-sleep-on-renew
```

证书 hook 会把新证书原子复制到 `/etc/remote-terminal/tls/`，权限为 `root:remote-terminal-server 0640`，随后平滑重启 Relay。无需 Nginx，80 端口平时没有常驻监听。

以后从 GitHub 更新现有服务器：

```bash
SERVER_HOST=服务器地址 \
SERVER_SSH_PORT=822 \
REMOTE_DIR=/opt/remote-terminal \
REMOTE_CONFIG_PATH=/etc/remote-terminal/server.json \
bash deploy.sh
```

`deploy.sh` 只接受干净的远端 Git 工作区，只执行快进更新、Relay 生产依赖安装、现有服务重启和本机健康检查。它不会上传配置或密钥，也不会修改防火墙和 systemd 单元。

## 定期监控

`deploy/systemd/remote-terminal-monitor.*` 每五分钟检查：

- Relay systemd 状态与本机 `/health`
- 公网域名 TLS 证书
- 指定远程 Agent 的在线状态与会话数
- 负载、可用内存和磁盘使用率
- 纯中转主机是否误运行 Remote Terminal Agent

`RT_MONITOR_AUTO_HEAL=1` 允许监控在 Relay 停止或健康检查失败时重启一次。监控不依赖也不会启动 Nginx。

## 构建客户端

先安装共用 UI 依赖：

```bash
npm ci --prefix clients --no-audit --no-fund
```

Android：

```bash
cd clients/android
./gradlew assembleDebug
```

桌面端：

```bash
cd clients/desktop
npm ci
npm run dist
```

两端都会调用 `clients/prepare-client-ui.js`，把 `clients/ui/` 与本地 xterm 依赖复制进安装包。运行时只访问用户配置的 WSS 地址。

## 运行 Agent

```bash
cd /opt/remote-terminal/agent
npm ci --no-audit --no-fund
CW_CONFIG_PATH=/etc/remote-terminal/agent.json node index.js
```

受限网络可设置 `proxyUrl`、`HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY`。TLS 证书默认严格校验；私有 CA 应通过 `tlsCaPath` 指定，不应关闭证书校验。

## 测试

```bash
npm ci --prefix clients --no-audit --no-fund
npm ci --prefix server --no-audit --no-fund
npm ci --prefix agent --no-audit --no-fund
npm test
bash scripts/run-server-tests.sh
```

测试覆盖客户端离线打包、设置持久化、Relay HTTP/WSS 协议、鉴权隔离、终端快照、输出顺序、断线恢复、资源上限、真实 PTY 与安全边界。

## 安全要求

- 公网必须使用有效 WSS，不使用明文 `ws://`。
- Relay 与 Agent 均应使用独立低权限账户。
- 客户端与 Agent Token 至少 32 个随机字符，彼此不同并定期轮换。
- 配置、TLS 私钥、代理凭据和审计日志必须限制读取权限。
- 审计日志可能包含密钥、密码或其他敏感命令参数。
- 高风险环境应增加主机防火墙、设备证书或 mTLS。

## 许可证

MIT，见 [LICENSE](LICENSE)。
