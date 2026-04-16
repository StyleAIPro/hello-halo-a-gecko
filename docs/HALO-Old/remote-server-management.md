# 远程服务器管理模块实现方案

## 1. 概述

远程服务器管理模块允许用户通过 SSH 连接远程服务器，在上面部署并运行 AICO-Bot Remote Agent Proxy（一个 Node.js 服务），然后将 AI Agent 工作负载路由到远程机器执行。

核心能力：
- 通过 SSH 管理远程服务器连接
- 自动部署/更新 Remote Agent Proxy 到远程服务器
- 通过 WebSocket 与远程 Proxy 通信，实现远程对话
- 支持多台远程服务器、多 PC 独立部署互不干扰

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                         AICO-Bot Desktop                             │
│                                                                      │
│  ┌────────────────┐    ┌──────────────────┐    ┌─────────────────┐  │
│  │   React UI     │◄──►│   Main Process   │◄──►│  SSH Manager    │  │
│  │  (Renderer)    │IPC │                  │    │  (ssh2 library) │  │
│  └────────────────┘    └───────┬──────────┘    └───────┬─────────┘  │
│                                │                       │             │
│                       ┌────────┴────────┐              │             │
│                       │ Remote Deploy   │              │             │
│                       │ Service         │──────────────┘             │
│                       └────────┬────────┘                            │
│                                │                                    │
│                       ┌────────┴────────┐                            │
│                       │ Remote WS       │                            │
│                       │ Client          │                            │
│                       └────────┬────────┘                            │
└────────────────────────────────┼────────────────────────────────────┘
                                 │ WebSocket
                    ┌────────────┴────────────┐
                    │  Remote Agent Proxy     │
                    │  (Node.js on remote)    │
                    │  Port: 30000-40000      │
                    └─────────────────────────┘
```

可选 SSH 隧道路径：
```
Main Process ──SSH Tunnel──► localhost:localPort ──forwarded──► remote:assignedPort
```

## 3. 数据模型

### 3.1 RemoteServer（共享类型）

定义在 `src/shared/types/index.ts:65-91`，主进程和渲染进程共用。

```typescript
interface RemoteServer {
  id: string                      // 格式: server-{timestamp}-{random}
  name: string                    // 用户自定义名称
  host: string                    // SSH 主机地址
  sshPort: number                 // SSH 端口，默认 22
  username: string                // SSH 用户名
  password: string                // SSH 密码（加密存储）
  authToken: string               // WebSocket 认证 token
  status: 'disconnected' | 'connected' | 'deploying' | 'error'
  error?: string                  // 错误信息

  // Claude API 配置
  workDir?: string                // 远程工作目录
  claudeApiKey?: string           // Claude API Key（加密存储）
  claudeBaseUrl?: string          // 自定义 API Base URL
  claudeModel?: string            // 模型名称
  aiSourceId?: string             // 关联的 AI Source ID

  // Agent 检测状态
  sdkInstalled?: boolean          // SDK 是否安装且版本匹配
  sdkVersion?: string             // 已安装的 SDK 版本
  sdkVersionMismatch?: boolean    // SDK 版本是否不匹配
  proxyRunning?: boolean          // Bot 代理健康检查是否通过

  // 每 PC 隔离字段
  clientId?: string               // 本机机器标识，格式: client-{hash12}
  assignedPort?: number           // 远程服务器上分配的端口 (30000-40000)
  deployPath?: string             // 远程部署路径: /opt/claude-deployment-{clientId}
}
```

### 3.2 内部类型（仅主进程）

定义在 `remote-deploy.service.ts:56-63`。

```typescript
interface RemoteServerConfig extends RemoteServer {
  ssh: SSHConfig                  // { host, port, username, password, privateKey? }
  lastConnected?: Date
}

interface RemoteServerConfigInput extends Omit<RemoteServerConfig, 'id' | 'status' | 'lastConnected'> {
  ssh: SSHConfig
}
```

### 3.3 配置持久化

服务器配置存储在全局配置文件中（`getConfig().remoteServers`），通过 `saveServers()` / `loadServers()` 读写。连接状态（`status`）不持久化，每次启动时重置为 `disconnected`。

## 4. 核心服务

### 4.1 RemoteDeployService

文件：`src/main/services/remote-deploy/remote-deploy.service.ts`

中央服务类，管理所有远程服务器的生命周期。内部维护两个 Map：

```typescript
private servers: Map<string, RemoteServerConfig>       // 服务器配置
private sshManagers: Map<string, SSHManager>           // SSH 连接管理器
```

#### 4.1.1 服务器管理

| 方法 | 说明 |
|------|------|
| `addServer(config)` | 添加服务器：生成 ID/clientId → 保存配置 → 建立 SSH → 分配端口 → 检测 Agent |
| `removeServer(id)` | 删除服务器：断开 SSH → 移除连接池 → 从配置中删除 |
| `updateServer(id, updates)` | 更新服务器配置字段 |
| `connectServer(id)` | 建立 SSH 连接并分配端口 |
| `disconnectServer(id)` | 断开 SSH 连接 |

#### 4.1.2 部署管理

| 方法 | 说明 |
|------|------|
| `deployToServer(id)` | 完整部署：`deployAgentSDK()` → `deployAgentCode()` |
| `deployAgentSDK(id)` | 安装 Node.js 和 `@anthropic-ai/claude-agent-sdk`（版本匹配时跳过） |
| `deployAgentCode(id)` | 上传代码、安装依赖、同步 system prompt、启动 Agent |
| `updateAgentCode(id)` | 增量更新：比较 MD5 决定是否 npm install，更新 SDK，重启 |
| `startAgent(id)` | 通过 `nohup node dist/index.js` 启动 Proxy 进程 |
| `stopAgent(id)` | 通过 `pkill -f` 停止 Proxy 进程 |
| `restartAgentWithNewConfig(id)` | 停止后启动（API Key/URL/Model 变更时） |

#### 4.1.3 检测机制

`detectAgentInstalled(id)` 两级检测：

```
Level 1 (60%)  npm list -g @anthropic-ai/claude-agent-sdk
               → 检查 SDK 是否安装，解析版本号
               → 要求版本 === REQUIRED_SDK_VERSION ('0.2.104')

Level 2 (75%)  curl http://localhost:{port+1}/health
               → 检查 Bot 代理是否在运行
               → 判断 healthData.status === 'ok'
               → 条件: server.assignedPort 存在（不依赖 SDK 已安装）
```

检测结果写入服务器配置的 `sdkInstalled`、`sdkVersion`、`sdkVersionMismatch`、`proxyRunning` 字段。

#### 4.1.4 事件推送

两个回调机制，通过 IPC 推送到渲染进程：

```typescript
// 命令输出（用于终端显示）
private commandOutputCallbacks: Array<(serverId, type, content) => void>
emitCommandOutput(serverId, 'command' | 'output' | 'error' | 'success', content)

// 部署进度（用于进度条）
private deployProgressCallbacks: Array<(serverId, stage, message, progress) => void>
emitDeployProgress(serverId, stage, message, progress)
```

### 4.2 SSH Manager

文件：`src/main/services/remote-ssh/ssh-manager.ts`

基于 `ssh2` 库的 SSH 连接管理器。

| 方法 | 说明 |
|------|------|
| `connect(config)` | 建立 SSH 连接，keepalive 间隔 30s，最大 10 次失败 |
| `executeCommandFull(cmd)` | 执行命令，返回 `{ stdout, stderr, exitCode }` |
| `executeCommandStreaming(cmd, onOutput)` | 流式执行命令，实时回调 stdout/stderr |
| `uploadFile(localPath, remotePath)` | 通过 SFTP 上传文件 |
| `isConnected()` | 返回连接状态 |
| `disconnect()` | 关闭连接 |
| `ensureConnected()` | 健康检查（`echo ok`），失败则自动重连 |

### 4.3 Remote WS Client

文件：`src/main/services/remote-ws/remote-ws-client.ts`

WebSocket 客户端，与远程 Proxy 通信。

**连接流程**：
1. 构建 URL：`ws://{host}:{port}/agent`
2. 发送 `Authorization: Bearer {authToken}` 头
3. 发送认证消息 `{ type: 'auth', payload: { token } }`
4. 等待 `auth:success` 响应（10s 超时）

**重连机制**：
- 最多 5 次，指数退避：3s → 6s → 12s → 24s → 48s
- 主动 `disconnect()` 不触发重连

**健康检查**：
- 每 30s 发送 `ping`
- 90s 无 `pong` 则关闭连接（code 4001）

**连接池**：
- 按 `serverId` 缓存连接，最大存活 30 分钟
- `acquireConnection()` 获取或创建连接
- `removePooledConnection()` 强制销毁（停止 Agent 前调用，避免 socket hang up）

## 5. 每 PC 隔离机制

### 5.1 Machine ID 生成

文件：`src/main/services/remote-deploy/machine-id.ts`

```
getMachineId():
  win32  → reg query HKLM\SOFTWARE\Microsoft\Cryptography MachineGuid
  darwin → ioreg -rd1 -c IOPlatformExpertDevice → IOPlatformUUID
  linux  → /etc/machine-id
  fallback → SHA-256(hostname + username)

getClientId():
  SHA-256(getMachineId()).substring(0, 12)
  → "client-{hash12}"
```

### 5.2 端口分配

文件：`src/main/services/remote-deploy/port-allocator.ts`

```
calculatePreferredPort(clientId):
  SHA-256(clientId) → uint32 → PORT_RANGE_START + (uint32 % 10001)
  端口范围: 30000 - 40000

resolvePort(sshManager, clientId):
  1. 计算首选端口
  2. 检查端口是否被本 clientId 占用 → 是则直接使用
  3. 检查端口是否空闲 → 是则使用
  4. 否则尝试下一个端口，最多 20 次
```

### 5.3 部署路径

```
deployPath = /opt/claude-deployment-{clientId}
```

同一台远程服务器上，不同 PC 会生成不同的 `clientId`，从而获得不同的端口和部署路径，互不干扰。

### 5.4 asar 兼容

打包成 exe 后，`packages/remote-agent-proxy/` 位于 app.asar 内部。`getRemoteAgentProxyPath()` 返回 `{app.asar}/packages/remote-agent-proxy`。`createDeployPackage()` 检测到路径包含 `.asar` 时，先将文件拷贝到临时 staging 目录，再从 staging 目录打包 tar.gz，最后清理临时目录。

## 6. 添加远程服务器流程

### 6.1 用户视角

```
用户填写表单（名称、Host、SSH 端口、用户名、密码、AI Provider）
  │
  ├─ 点击"添加"按钮
  │
  ├─ Dialog 内容切换为进度视图（同一个 dialog，表单变为进度条）
  │   ├─ spinner + 服务器名称 + 当前步骤消息 + 百分比
  │   ├─ 进度条实时更新
  │   └─ 成功时显示绿色 ✓ / 失败时显示红色错误信息 + "Close" 按钮
  │
  ├─ 后端 addServer() 执行
  │   ├─ 5%   保存服务器配置
  │   ├─ 10%   建立 SSH 连接
  │   ├─ 50%   分配端口
  │   ├─ 55%   开始检测远程 Agent
  │   ├─ 60%   检查 SDK 安装
  │   ├─ 75%   检查 Bot 代理状态
  │   └─ 100%  完成
  │
  ├─ Dialog 自动关闭
  └─ 服务器列表中出现新卡片（带 SDK + Bot 代理状态徽章）
```

### 6.2 后端流程

`RemoteDeployService.addServer()` (remote-deploy.service.ts:282)：

```
addServer(config)
  │
  ├─ 1. generateId() → "server-{timestamp}-{random7}"
  ├─ 2. getClientId() → "client-{hash12}"（本机机器标识）
  │
  ├─ 3. emitDeployProgress('add', 'Saving...', 5%)
  ├─ 4. 构建 RemoteServerConfig，设置 clientId、deployPath
  ├─ 5. servers.set(id, server) → saveServers()
  │
  ├─ 6. emitDeployProgress('ssh', 'Establishing SSH...', 10%)
  ├─ 7. connectServer(id)
  │   └─ SSHManager.connect(sshConfig)
  │
  ├─ 8. resolvePort(sshManager, clientId) → 分配端口 30000-40000
  │   ├─ calculatePreferredPort() → SHA-256(clientId) 哈希 → 端口号
  │   └─ resolvePort() → 检查端口是否空闲，最多递增 20 次
  │
  ├─ 9. emitDeployProgress('detect', 'Detecting remote agent...', 55%)
  ├─ 10. detectAgentInstalled(id)
  │   ├─ Level 1: npm list -g @anthropic-ai/claude-agent-sdk → 更新 sdkInstalled/sdkVersion
  │   └─ Level 2: curl /health → 更新 proxyRunning
  │
  ├─ 11. emitDeployProgress('complete', 'Server added successfully', 100%)
  └─ 12. return id
```

**注意**：addServer 只建立 SSH 连接并检测，不自动部署 Agent。部署需要手动点击 "Update Agent"。

### 6.3 前端实现细节

**Dialog 进度视图**（`RemoteServersSection.tsx`）：

- 条件：`saving && !editingServer && addProgress`
- 显示：spinner/✓/✗ 图标 + 服务器名 + 步骤消息 + 百分比 + 进度条
- 成功/错误时显示 "Close" 按钮
- Cancel 按钮在 saving 时禁用，防止中途取消

**进度事件接收**（IPC 监听器）：

```
后端 emitDeployProgress(id, stage, message, progress)
  → mainWindow.webContents.send('remote-server:deploy-progress', data)
  → 前端 handleDeployProgress(data)
      ├─ 如果是第一个事件且 ID 未知 → 捕获 serverId
      ├─ addTerminalEntry() → 写入终端输出
      ├─ setAddProgress() → 更新进度状态
      └─ setExpandedServers() → 自动展开服务器卡片
```

## 7. Update Agent 流程

### 7.1 用户视角

```
用户点击服务器卡片上的 "Update Agent" 按钮
  │
  ├─ 检查活跃会话
  │   └─ 有活跃会话 → 弹确认框："正在使用此服务器，是否强制停止更新？"
  │
  ├─ Dialog 确认后，终端区域显示更新过程
  │   ├─ 停止 Agent
  │   ├─ 增量更新（跳过环境初始化）
  │   ├─ 重启 Agent
  │   └─ 显示版本对比信息
  │
  └─ 服务器卡片刷新状态徽章
```

### 7.2 后端流程

IPC handler `remote-server:update-agent` (remote-server.ts:487)：

```
remote-server:update-agent(serverId)
  │
  ├─ 1. startUpdate(serverId) — 标记更新开始
  │
  ├─ 2. stopAgent(serverId)
  │   ├─ removePooledConnection(id) — 移除 WebSocket 连接池
  │   └─ pkill -f "node.*{deployPath}" — 杀掉远程 node 进程
  │
  ├─ 3. updateAgentCode(serverId) — 增量更新
  │   │
  │   ├─ 检查是否首次部署
  │   │   ├─ version.json 不存在 / npm 不可用
  │   │   └─ 回退到 deployAgentCode() 完整安装
  │   │
  │   ├─ 【增量更新路径】
  │   │   ├─ 创建远程目录 (dist, patches, config, logs, scripts)
  │   │   ├─ 检测 npm 路径（处理非交互式 shell PATH 问题）
  │   │   ├─ 打包 packages/remote-agent-proxy/ 为 tar.gz
  │   │   ├─ SSH 健康检查
  │   │   ├─ SFTP 上传 tar.gz 到远程
  │   │   ├─ 解压部署包
  │   │   │
  │   │   ├─ 比较 package.json MD5
 │   │   │   ├─ MD5 不同 → npm install --legacy-peer-deps
│   │   │   └─ MD5 相同 → 检查依赖完整性，缺失则修复
 │   │   │
 │   │   ├─ 检查全局 SDK 版本
│   │   │   ├─ 版本 !== 0.2.104 → npm install -g 更新 SDK
│   │   │   └─ 版本匹配 → 跳过
│   │   │
│   │   ├─ 检查 SDK 补丁文件 (patches/*.patch)
│   │   │   └─ 有变更则上传 sdk.mjs
│   │   │
│   │   ├─ 同步 system prompt
│   │   │
│   │   └─ 重启 Agent
│   │       ├─ curl /health 检查活跃会话数
│   │       ├─ 有活跃会话 → 跳过重启（代码已更新，等会话结束后手动重启）
│   │       ├─ 正在运行 → stopAgent → startAgent
│   │       └─ 未运行 → startAgent
│   │           ├─ nohup node {deployPath}/dist/index.js &
│   │           ├─ 等待 5 秒
│   │           ├─ 检查端口是否监听
│   │           └─ 失败时自修复（检查日志中的模块缺失 → npm install → 重试）
│   │
  │   └─ 【完整安装回退路径】deployAgentCode()
  │       └─ 创建目录 → 上传 → 安装 Node.js → npm install → 安装 SDK → 同步 prompt → 启动
  │
  ├─ 4. detectAgentInstalled(serverId) — 刷新检测状态
  │   ├─ Level 1: npm list -g → 更新 sdkInstalled/sdkVersion
  │   └─ Level 2: curl /health → 更新 proxyRunning
  │
  ├─ 5. completeUpdate(serverId) + sendCompleteEvent() + 系统通知
  └─ 6. return { success, data: { remoteVersion, localVersion, ... } }
```

### 7.3 前端更新完成后处理

```
收到 IPC 结果
  ├─ ack 确认更新状态
  ├─ 终端显示版本信息（本地版本 vs 远端版本）
  ├─ 非批量模式 → 弹对话框显示版本对比
  └─ loadServers() → 刷新卡片状态徽章
```

## 8. 对话消息流程

文件：`src/main/services/agent/send-message.ts`

当用户向远程空间的对话发送消息时：

```
sendMessageToRemote()
  │
  ├─ Phase 1: SSH 隧道建立
  │   └─ sshTunnelService.establishTunnel()（如果启用 SSH 隧道）
  │
  ├─ Phase 2: Agent 检查 + WebSocket 连接（并行）
  │   ├─ checkAndStartAgent()
  │   │   └─ 检查 Proxy 是否运行，未运行则直接报错
  │   └─ acquireConnection() → 建立 WebSocket
  │
  ├─ Phase 3: MCP Bridge 注册
  │   └─ 注册本地 MCP 工具，使远程 Claude 可以调用
  │
  └─ Phase 4: 对话执行
      └─ 通过 WebSocket 发送消息，接收流式响应
```

**重要设计决策**：发送消息时不会自动部署或启动 Proxy。如果 Proxy 未运行，会直接报错，用户需要先在远程服务器管理界面手动部署。

## 9. 部署流程

### 9.1 完整部署（首次）

`deployToServer(id)` → `deployAgentSDK(id)` → `deployAgentCode(id)`

```
deployAgentSDK:
  1. 检查 SDK 是否已安装且版本匹配
  2. 检测/安装 Node.js（支持 Debian/RHEL/openEuler/Amazon/Alpine/Arch）
  3. 检测/安装 npm 和 npx
  4. 版本匹配 → 跳过；版本不匹配 → npm install -g 更新

deployAgentCode:
  1. 创建远程目录: {deployPath}/dist, logs, data, ~/.agents/skills
  2. 打包本地 packages/remote-agent-proxy/ 为 tar.gz
  3. SFTP 上传
  4. npm install --legacy-peer-deps
  5. 同步 system prompt
  6. startAgent()
```

### 9.2 Agent 启动

`startAgent(id)`:

```
  1. 读取 version.json 获取构建信息
  2. kill 已有进程
  3. nohup env REMOTE_AGENT_PORT={port} \
         REMOTE_AGENT_AUTH_TOKEN={token} \
         REMOTE_AGENT_WORK_DIR={workDir} \
         IS_SANDBOX=1 \
         DEPLOY_DIR={deployPath} \
         node {deployPath}/dist/index.js &
  4. 等待 5s，验证端口监听
  5. 自修复：如果日志显示 ERR_MODULE_NOT_FOUND → npm install → 重试
```

### 9.3 Agent 自修复

`startAgent()` 内部：

启动后如果端口未监听，检查日志中是否包含模块缺失错误。如果是，自动执行 `npm install --legacy-peer-deps` 并重试一次启动。这是单次重试，不是循环。

## 10. 前端实现

### 10.1 双入口

远程服务器管理有两个前端入口：

| 入口 | 文件 | 位置 |
|------|------|------|
| Settings 面板 | `RemoteServersSection.tsx` | Settings > Remote Servers |
| 独立页面 | `RemoteServersPage.tsx` | 主导航 |

Settings 面板版本功能更完整（终端输出、批量更新），独立页面版本功能较基础。

### 10.2 服务器卡片信息

每个服务器卡片显示：
- 服务器名称、host:port
- clientId（用于排查）
- AI 模型信息
- 状态徽章：SDK 版本、Bot 代理运行状态
- 操作按钮：连接/断开、更新 Agent、编辑、删除

## 11. IPC 通道

### 11.1 渲染进程 → 主进程（invoke/handle）

文件：`src/main/ipc/remote-server.ts`

| 通道 | 说明 |
|------|------|
| `remote-server:add` | 添加服务器 |
| `remote-server:list` | 获取服务器列表 |
| `remote-server:get` | 获取单个服务器 |
| `remote-server:update` | 更新服务器配置 |
| `remote-server:update-ai-source` | 更新 AI Source |
| `remote-server:update-model` | 更新模型 |
| `remote-server:delete` | 删除服务器 |
| `remote-server:connect` | 建立 SSH 连接 |
| `remote-server:disconnect` | 断开 SSH 连接 |
| `remote-server:deploy` | 完整部署 |
| `remote-server:update-agent` | 增量更新 Agent |
| `remote-server:deploy-agent` | 仅部署 SDK |
| `remote-server:start-agent` | 启动 Agent |
| `remote-server:stop-agent` | 停止 Agent |
| `remote-server:check-agent` | 检查 Agent 安装状态 |
| `remote-server:is-agent-running` | 检查 Agent 是否运行 |
| `remote-server:get-agent-logs` | 获取 Agent 日志 |
| `remote-server:test-connection` | 测试连接（仅检查 status） |
| `remote-server:execute` | 执行远程命令 |
| `remote-server:list-skills` | 列出远程 Skills |
| `remote-server:list-tasks` | 列出后台任务 |
| `remote-server:cancel-task` | 取消后台任务 |
| `remote-server:cleanup-scan` | 清理孤儿部署 |
| `remote-server:delete-deployment` | 删除指定部署 |

### 11.2 主进程 → 渲染进程（send/on）

| 通道 | 说明 |
|------|------|
| `remote-server:status-change` | 服务器状态变更通知 |
| `remote-server:command-output` | 命令输出流（终端显示） |
| `remote-server:deploy-progress` | 部署进度更新（进度条） |
| `remote-server:update-complete` | Agent 更新完成通知 |

### 11.3 Preload 桥接

文件：`src/preload/index.ts:894-937`

两个命名空间暴露到 `window.aicoBot`：

- `window.aicoBot.remoteServer.*` — 服务器管理操作
- `window.aicoBot.remoteAgent.*` — 远程 Agent 通信操作

### 11.4 Renderer API 层

文件：`src/renderer/api/index.ts:1836-2155`

双模式传输：Electron 模式走 IPC，Web 模式走 HTTP REST。

## 12. 添加新 IPC 端点的步骤

1. **`src/main/ipc/remote-server.ts`** — 注册 `ipcMain.handle()` 处理器
2. **`src/preload/index.ts`** — 在 `remoteServer` 或 `remoteAgent` 命名空间中暴露方法
3. **`src/renderer/api/index.ts`** — 在 `api` 对象中添加方法，支持 IPC 和 HTTP 两种模式

## 13. Proxy 启动/部署的所有触发路径

| 触发方式 | 入口 | 自动/手动 |
|---------|------|----------|
| 用户点击 "Deploy" | `remote-server:deploy` | 手动 |
| 用户点击 "Update Agent" | `remote-server:update-agent` | 手动 |
| 用户点击 "Start Agent" | `remote-server:start-agent` | 手动 |
| 用户点击 "Deploy Agent SDK" | `remote-server:deploy-agent` | 手动（仅 SDK，不启动） |
| 修改 API Key/Model/URL | `remote-server:update` | 手动（自动重启） |
| 发送对话消息 | `send-message.ts` | 仅检查，不通则报错 |

**没有定时任务或后台健康检查来自动重启 Proxy**。如果 Proxy 进程崩溃且没有新的对话消息，它会保持停止状态。

## 14. 关键常量

| 常量 | 值 | 位置 |
|------|-----|------|
| `REQUIRED_SDK_VERSION` | `0.2.104` | `remote-deploy.service.ts:66` |
| 端口范围 | `30000 - 40000` | `port-allocator.ts` |
| SSH keepalive 间隔 | `30s` | `ssh-manager.ts:86` |
| WebSocket ping 间隔 | `30s` | `remote-ws-client.ts:846` |
| WebSocket pong 超时 | `90s` | `remote-ws-client.ts` |
| WebSocket 重连次数 | `5` | `remote-ws-client.ts:814` |
| WebSocket 重连基础延迟 | `3s`（指数退避） | `remote-ws-client.ts` |
| 连接池最大存活 | `30 min` | `remote-ws-client.ts:1064` |

## 15. 关键文件索引

| 文件 | 说明 |
|------|------|
| `src/shared/types/index.ts` | RemoteServer 共享类型定义 |
| `src/main/services/remote-deploy/remote-deploy.service.ts` | 核心部署服务 |
| `src/main/services/remote-deploy/port-allocator.ts` | 端口分配器 |
| `src/main/services/remote-deploy/machine-id.ts` | 机器 ID 生成 |
| `src/main/services/remote-ssh/ssh-manager.ts` | SSH 连接管理 |
| `src/main/services/remote-ws/remote-ws-client.ts` | WebSocket 客户端 + 连接池 |
| `src/main/services/agent/send-message.ts` | 对话消息发送（含远程路径） |
| `src/main/ipc/remote-server.ts` | IPC 处理器注册 |
| `src/preload/index.ts` | Preload 桥接 |
| `src/renderer/api/index.ts` | 前端 API 层 |
| `src/renderer/components/settings/RemoteServersSection.tsx` | Settings 面板组件 |
| `src/renderer/pages/RemoteServersPage.tsx` | 独立页面组件 |
| `packages/remote-agent-proxy/` | 远程 Proxy 源码（部署到远程的代码） |
