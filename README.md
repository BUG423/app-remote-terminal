# 💻 app-remote-terminal

[![Release](https://img.shields.io/github/v/release/BUG423/app-remote-terminal?color=brightgreen)](https://github.com/BUG423/app-remote-terminal/releases)
[![Platform: Android](https://img.shields.io/badge/Platform-Android-3DDC84?logo=android&logoColor=white)](https://developer.android.com/)
[![Platform: Desktop](https://img.shields.io/badge/Platform-Desktop_(Win%20%7C%20Mac%20%7C%20Linux)-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Runtime: Node.js](https://img.shields.io/badge/Runtime-Node.js_20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Protocol: WSS](https://img.shields.io/badge/Protocol-WSS_v2-blue?logo=websocket&logoColor=white)](https://websockets.spec.whatwg.org/)
[![License: CC BY-NC-ND 4.0](https://img.shields.io/badge/License-CC_BY--NC--ND_4.0-red.svg)](https://creativecommons.org/licenses/by-nc-nd/4.0/)

> **app-remote-terminal** 是一套专为多平台设计的高安全、零入站端口依赖的通用远程终端系统。覆盖 Android、Windows、macOS 与 Linux，客户端与受控端 Agent 均采用向外主动长连接（反向 WSS），受控设备无需开放 SSH、RDP 或公网防火墙入站端口。

---

## 📥 快速下载与安装

前往 **[GitHub Releases 最新发布页](https://github.com/BUG423/app-remote-terminal/releases)** 获取最新多端客户端与发布安装包：

👉 **[点击直接进入 Releases 下载各平台客户端](https://github.com/BUG423/app-remote-terminal/releases)**

---

## 🖼️ 核心界面预览

![Remote Terminal 设备管理界面](docs/images/screenshot.png)

---

## ✨ 核心特性

- **🔌 反向隧道·零入站端口开放**：受控主机与管理客户端双向主动发起 WSS 连接至轻量 Relay 中继，穿透 NAT 与复杂内网，彻底免去公网端口映射与传统 SSH 暴露风险。
- **🔐 硬件级凭据安全与零按键记录**：
  - **角色双 Token 隔离**：拆分 APP 控制凭据（`browserToken`）与受控端接入凭据（`agentToken`），每台电脑单独配对。
  - **系统级密钥保险箱**：Android 采用 Keystore AES-GCM 加密存储；桌面端依托 Electron `safeStorage` 与受限凭据文件（`0600`）。
  - **零交互痕迹审计**：不留存明文按键交互流，不记录密码或交互式机密。
- **⚡ 工业级终端流控与会话状态保真**：
  - 完整会话快照、断线重连平滑补齐、序号断档安全重同步。
  - 渲染背压控制（Backpressure），防止突发高频大日志压垮客户端渲染引擎。
- **📱 跨平台深度原生交互**：
  - **Android**：虚拟键盘动态顶起终端视图，精准适配系统状态栏、挖孔屏、刘海屏及预测式手势返回。
  - **桌面端（Windows / macOS / Linux）**：多会话多设备秒级切换、智能分屏、大文本粘贴二次确认与终端主题定制。

---

## 🏗️ 系统架构

```mermaid
flowchart LR
    subgraph Clients["原生客户端"]
        AND["📱 Android Native"]
        DSK["🖥️ Desktop (Win / Mac / Linux)"]
    end

    subgraph RelayCluster["Relay 通信中继"]
        SRV["⚡ Node.js WSS Relay<br/>• 角色鉴权隔离<br/>• 终端消息路由<br/>• 序号状态同步"]
    end

    subgraph TargetHosts["受控主机"]
        AGT["🤖 Agent 守护进程<br/>• node-pty 虚拟终端<br/>• 身份与工作目录锁定"]
        SH["💻 bash / zsh / PowerShell"]
    end

    AND -->|"WSS (出站)"| SRV
    DSK -->|"WSS (出站)"| SRV
    AGT -->|"WSS (出站)"| SRV
    AGT --> SH

    style RelayCluster fill:#eef2ff,stroke:#6366f1,color:#1e1b4b
    style Clients fill:#f0fdf4,stroke:#22c55e,color:#14532d
    style TargetHosts fill:#fff7ed,stroke:#f97316,color:#7c2d12
```

> **HTTP 控制面说明**：Relay 仅开放 `GET /health` 健康探针与 WebSocket 通信端点，其他所有未授权 HTTP 访问一律返回 `410 Gone`。

---

## 🚀 快速上手与运行

### 已有阿里云中转？只需要配对远程电脑

阿里云运行一次 Relay，并由 systemd 持续守护；每台受控电脑运行自己的 Agent；你的本机只运行 APP。APP 和 Agent 都主动连接同一个 `wss://` 中转地址。SSH 的端口只用于管理云服务器，不填进 APP 或 Agent 的中转地址。

| 填写位置 | 中转地址 | Token 从哪里取 |
| --- | --- | --- |
| 远程电脑的 Agent | 阿里云 WSS 地址 | 该电脑的 `agentToken` |
| 你本机的 APP | 同一个 WSS 地址 | 同一设备条目的 `browserToken`（APP 访问 Token） |

`browserToken` 可以控制该设备的终端，名称是历史协议命名。两枚 Token 不同，但必须来自服务器上的同一个设备条目。设备 ID 只用于服务器管理，不需要手动填进 Agent 或 APP。第二台电脑需要新增设备，不能复用第一台的 Agent Token。

在阿里云的项目目录运行以下命令，即可查看服务和**每一台** Agent 的状态，不输出 Token：

```bash
cd /opt/remote-terminal
npm run devices -- status
```

新增一台电脑（自动备份配置、生成独立凭据、重启服务；健康检查失败会恢复原配置）：

```bash
npm run devices -- add office-pc --name "办公室电脑" \
  --relay wss://你的中转域名 --restart --output /root/office-pc-pairing
```

已有设备直接导出，保持它的 Token 不变：

```bash
npm run devices -- show office-pc --relay wss://你的中转域名 \
  --output /root/office-pc-pairing-export
```

输出目录含两份私密文件：`office-pc.agent.json` 发给受控电脑，`office-pc.app.json` 留在控制端。不要把配对文件提交到 Git。

远程电脑安装 Agent 依赖后，在希望终端打开的既有工作目录运行向导，自动绑定当前用户、UID、HOME 和工作目录：

```bash
# 首次在项目目录安装依赖
npm ci --prefix agent

# 进入希望作为终端起点的既有目录，再运行项目里的向导
cd /你的既有工作目录
node /项目路径/scripts/setup-agent.js --profile /私密路径/office-pc.agent.json
```

不带 `--profile` 运行时，向导会询问中转地址和 Agent Token；已有配置需显式加 `--replace`，原文件会备份。按向导输出的命令启动 Agent；Linux/macOS 也可在绑定的工作目录执行 `/项目路径/start-local.sh`。保持向导使用的同一登录账户，无需 sudo。长期运行的 Linux Agent 可使用 [用户级 systemd 单元](deploy/systemd/remote-terminal-agent.service)。

本机 APP 打开「设备 → 添加设备 → 粘贴 APP 配对配置」，粘贴 `office-pc.app.json` 的内容，点击「填入设备信息 → 保存并连接」。也可手动填写名称、WSS 地址和 `browserToken`。

常见情况：

- **中转已连接，Agent 离线**：APP 凭据正确；检查远程电脑的 Agent 是否启动、地址是否相同、是否用了同一条设备记录的 `agentToken`。
- **Agent already connected / code 4000**：同一条设备已有在线电脑；新增设备或停止原电脑的 Agent。
- **Invalid token**：Agent 使用 `agentToken`，APP 使用 `browserToken`；修改服务器配置后需重启 Relay。
- **配置中的运行身份不符**：回到向导绑定的工作目录，用同一账户启动，或在新目录重新运行向导。

### 直接从控制终端执行命令

安装过 Relay 或 Agent 依赖的控制端可跳过桌面 APP，通过同一份私密 APP 配对文件执行：

```bash
node scripts/relay-exec.js --profile /私密路径/office-pc.app.json \
  --command 'hostname; pwd' --timeout 90
# 多行或较长的命令使用 --command-file /路径/command.sh
```

命令在远程 Agent 的新终端执行。CLI 输出包含退出码与终端输出的 JSON，等待临时会话删除确认后退出。
长命令分段发送，Token 不放进命令行；该流程无需在控制端启动 Agent。

下面是首次部署 Relay 和手动配置 Agent 的底层步骤。

### 1. 中继服务配置 (Relay)

生成两枚独立高强度随机 Token：

```bash
node -e "for(let i=0;i<2;i++) console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

复制配置文件模板 [config.json.example](config.json.example) 并填写 Relay 端口、TLS 证书及设备映射：

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
      "browserToken": "<客户端 Token>",
      "agentToken": "<受控端 Agent Token>"
    }
  }
}
```

以受限权限安装配置文件并启动服务：

```bash
sudo install -o remote-terminal-server -g remote-terminal-server -m 0600 \
  config.json /etc/remote-terminal/server.json
npm ci --prefix /opt/remote-terminal/server --omit=dev --no-audit --no-fund
sudo systemctl enable --now remote-terminal-server.service
```

### 2. 受控端配置 (Agent)

在目标机器既有登录账户下，复制 [agent/config.json.example](agent/config.json.example)：

```json
{
  "agentToken": "<与 Relay 对应的 agentToken>",
  "serverUrl": "wss://terminal.example.cn",
  "requiredUser": "当前用户名",
  "requiredUid": 1000,
  "requiredHome": "/home/当前用户",
  "requiredWorkingDirectory": "/已经存在的原始工作目录",
  "maxSessions": 12
}
```

启动本地受控 Agent：

```bash
chmod 600 agent/config.json
./start-local.sh
```

### 3. 客户端连接与使用

1. 打开 Android 或桌面端客户端，进入「设备」页面点击「添加设备」。
2. 输入设备名称、Relay 地址（如 `wss://terminal.example.cn`）以及分配的 `browserToken`。
3. 保存后即可实时接入受控终端，创建和管理多路 Shell 会话。

---

## 🛠️ 构建与测试

### 构建客户端

```bash
# 构建 Android 客户端 (需 JDK 17 及 Android SDK Platform 35)
cd clients/android
./gradlew assembleRelease

# 构建桌面客户端 (Electron)
cd clients/desktop
npm ci
npm run dist
```

### 自动化测试

```bash
# 运行完整协议与安全测试套件
npm test

# 运行性能与延迟基准评测
npm run test:latency
```

---

## 📄 知识产权与开源协议

本项目遵循 **[Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International (CC BY-NC-ND 4.0)](https://creativecommons.org/licenses/by-nc-nd/4.0/)** 严格非商业开源许可：

- ❌ **严禁商用**：任何个人或组织不得将本项目源码、编译产物或衍生版本用于任何商业盈利目的。
- ❌ **禁止演绎与分发修改版**：未经授权不得散布基于本项目修改后的二次分发版本。
- 🔒 **权利保留**：作者保留对本项目代码与架构的所有版权与法律追责权利。
