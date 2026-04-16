# Remote Agent 技术详解

> 版本：v1
> 日期：2026-04-16
> 归属模块：remote-agent

## 1. 系统概述

Remote Agent 是 AICO-Bot 的远程执行能力，允许用户在本地桌面端操作 AI Agent，但实际执行发生在远程 Linux 服务器上。

**核心能力：**
- 远程聊天：在远程服务器上运行 Claude SDK，流式返回结果
- SSH 隧道：安全的加密通信通道
- MCP Bridge：远程 Agent 可调用本地 PC 的浏览器、GitHub 等工具
- 远程部署：一键部署代理服务到远程服务器
- 会话恢复：跨重启的 SDK 会话持久化
- 多 PC 隔离：同一服务器支持多台本地 PC 独立运行
- 文件操作：远程文件浏览、读写、上传、下载

**适用场景：**
- AI Agent 需要 Linux 服务器环境（Docker、K8s、GPU 等）
- 本地 PC 算力不足，需要服务器级资源
- 需要远程服务器上的文件系统和网络访问
- 团队共享远程 Agent 服务

---

## 2. 架构全景

```
┌─────────────────────────────────────────────────────────────────────┐
│                          本地 AICO-Bot                               │
│                                                                     │
│  ┌──────────┐   IPC/HTTP   ┌──────────────┐                        │
│  │ React UI  │◄────────────►│   主进程      │                        │
│  │ 聊天界面   │              │              │                        │
│  └──────────┘              └──────┬───────┘                        │
│                                   │                                │
│                    ┌──────────────┼──────────────┐                 │
│                    │              │              │                  │
│                    ▼              │              ▼                  │
│           ┌────────────┐         │    ┌──────────────────┐         │
│           │ SSH Tunnel  │         │    │ AicoBotMcpBridge │         │
│           │ Service     │         │    │ (本地工具调度)    │         │
│           └──────┬─────┘         │    │ - ai-browser     │         │
│                  │               │    │ - gh-search      │         │
│                  │               │    └────────┬─────────┘         │
│                  │               │             │                    │
│                  ▼               ▼             │                    │
│           ┌────────────────────────────┐       │                    │
│           │      RemoteWsClient       │◄──────┘                    │
│           │   (WebSocket 客户端)       │  mcp:tool:call             │
│           └────────────┬───────────────┘  mcp:tool:response        │
│                        │                                          │
└────────────────────────┼──────────────────────────────────────────┘
                         │ WebSocket (ws://)
                         │ SSH 隧道转发或直连
                         │
┌────────────────────────┼──────────────────────────────────────────┐
│                        ▼          远程服务器                        │
│           ┌────────────────────────┐                               │
│           │  remote-agent-proxy    │                               │
│           │  (Node.js 服务)         │                               │
│           │                        │                               │
│           │  ┌──────────────────┐  │                               │
│           │  │  ClaudeManager   │  │                               │
│           │  │  (SDK 会话管理)   │  │                               │
│           │  └────────┬─────────┘  │                               │
│           │           │            │                               │
│           │           ▼            │                               │
│           │  ┌──────────────────┐  │                               │
│           │  │ Claude Agent SDK │  │                               │
│           │  │ (AI 推理执行)     │  │                               │
│           │  └──────────────────┘  │                               │
│           │                        │                               │
│           │  HTTP: /health, /tasks │                               │
│           └────────────────────────┘                               │
│                        │                                          │
│                        ▼                                          │
│           ┌────────────────────────┐                               │
│           │  /opt/claude-deployment │                               │
│           │  {clientId}/            │                               │
│           │  ├── proxy/             │                               │
│           │  └── .env               │                               │
│           └────────────────────────┘                               │
└───────────────────────────────────────────────────────────────────┘
```

---

## 3. 核心组件

### 3.1 RemoteWsClient — WebSocket 客户端

**位置：** `src/main/services/remote-ws/remote-ws-client.ts`（~1173 行）

管理与远程代理的 WebSocket 连接，是本地 AICO-Bot 与远程代理之间的通信桥梁。

**连接管理：**
- **连接 URL：** `ws://{host}:{port}/agent`
- **认证：** Bearer Token（WebSocket 握手 header + 首条 `auth` 消息双重认证）
- **心跳：** 每 30 秒发送 ping，90 秒无 pong 则断开
- **重连：** 指数退避（3s → 6s → 12s → 24s → 48s），最多 5 次
- **连接池：** 按服务器 ID 池化，30 分钟最大存活期，引用计数管理

**核心方法：**

| 方法 | 说明 |
|------|------|
| `sendChatWithStream(sessionId, messages, options)` | 发送聊天消息并接收流式响应，30 分钟空闲超时 |
| `interrupt(sessionId)` | 中断正在执行的远程任务 |
| `listFs(path)` / `readFile(path)` / `writeFile(path, content)` | 远程文件操作 |
| `uploadFile(path, content)` / `downloadFile(path)` / `deleteFile(path)` | 文件上传/下载/删除 |
| `registerMcpTools(tools, capabilities)` | 注册本地 MCP 工具到远程代理 |
| `sendMcpToolResult(callId, result)` / `sendMcpToolError(callId, error)` | 返回 MCP 工具执行结果 |

### 3.2 AicoBotMcpBridge — 本地工具桥接

**位置：** `src/main/services/remote-ws/aico-bot-mcp-bridge.ts`（~218 行）

将本地 PC 的 MCP 工具"桥接"到远程代理，使远程 Agent 可以调用本地资源。

**桥接的工具：**
- **ai-browser**（26 个工具）：`browser_click`、`browser_snapshot`、`browser_navigate`、`browser_screenshot` 等
- **gh-search**（8 个工具）：`gh_search_code`、`gh_issue_view`、`gh_pr_view`、`gh_repo_view` 等

**不桥接的工具：** `aico-bot-apps`（自动化）、`hyper-space`（多 Agent 编排）— 远程代理有自己独立的实现。

**工作原理：**
1. AICO-Bot 收集本地工具定义（名称、描述、输入 Schema），序列化后通过 WebSocket 发送给远程代理
2. 远程代理将这些工具注册到 Claude SDK，使 AI 知道可以使用这些工具
3. 当 AI 调用本地工具时，远程代理发送 `mcp:tool:call` 给 AICO-Bot
4. AICO-Bot 在本地执行工具，通过 `mcp:tool:response` 或 `mcp:tool:error` 返回结果

### 3.3 SSH Tunnel Service — SSH 隧道

**位置：** `src/main/services/remote-ssh/ssh-tunnel.service.ts`（~498 行）

管理 SSH 端口转发，为 WebSocket 连接提供加密通道。

**特性：**
- **动态端口分配：** 从 8080 起始，最多尝试 100 个端口
- **端口冲突检测：** 通过 `netstat`/`lsof` 检查端口占用
- **引用计数共享：** 同一服务器的多个 Space 共享同一条隧道
- **反向隧道支持：** 可创建反向端口转发
- **自动清理：** 断开连接时自动关闭隧道

### 3.4 RemoteDeployService — 部署管理

**位置：** `src/main/services/remote-deploy/remote-deploy.service.ts`

管理远程服务器的部署配置和生命周期。

**核心能力：**
- 服务器配置 CRUD（增删改查）
- 每 PC 隔离部署（通过 `clientId` + `assignedPort` + `deployPath`）
- SSH 连接管理
- 代码部署（SCP 到 `/opt/claude-deployment-{clientId}`）
- Agent 进程启停
- SDK 版本检查（要求 `>= 0.2.104`）
- 增量代码更新
- 技能同步到远程服务器

**多 PC 隔离机制：**

每台本地 PC 通过 `clientId`（机器指纹的前 12 位 hex）标识。同一远程服务器上，不同 PC 的代理部署在不同目录和端口，互不干扰。

```
/opt/claude-deployment-{clientId}/
├── proxy/                    # remote-agent-proxy 代码
├── .env                      # API Key、端口等配置
└── claude-agent-sdk/         # SDK 依赖
```

**端口分配策略（`port-allocator.ts`）：**
- 范围：30000-40000（10001 个端口）
- 同一 `clientId` 始终映射到同一端口（确定性分配）
- 碰撞检测：通过 SSH 命令 `ss -tln` 检查端口占用，最多重试 20 次

### 3.5 remote-agent-proxy — 远程代理服务

**位置：** `packages/remote-agent-proxy/`

独立 Node.js 服务，部署在远程服务器上，接收 WebSocket 命令并调用 Claude SDK 执行。

**技术栈：**
- `@anthropic-ai/claude-agent-sdk` — AI 推理
- `@modelcontextprotocol/sdk` — MCP 协议支持
- `express` — HTTP 健康检查端点
- `ws` — WebSocket 服务器
- `ssh2` —（不直接使用，由 AICO-Bot 本地管理 SSH）

**关键模块：**

| 文件 | 职责 |
|------|------|
| `src/server.ts`（~1052 行） | WebSocket 服务器、消息路由、认证、会话管理 |
| `src/claude-manager.ts` | Claude SDK 会话管理、流式处理、MCP 服务器设置 |
| `src/types.ts` | 完整的消息协议类型定义 |
| `src/background-tasks.ts` | 后台任务管理（长时间运行的命令） |
| `src/openai-compat-router/` | OpenAI 兼容 API 路由（支持非 Anthropic 提供商） |

**特性：**
- 7 天无活动自动关闭
- 认证失败自动重试
- HTTP 健康检查（端口 +1）：`/health`、`/health/api`、`/tasks`

---

## 4. 通信协议

### 4.1 消息格式

所有消息使用 JSON 格式，通过 WebSocket 双向传输。

**客户端 → 服务端（ClientMessage）：**

| 类别 | 消息类型 | 说明 |
|------|---------|------|
| 核心 | `auth` | 认证 |
| 核心 | `claude:chat` | 发送聊天消息（流式） |
| 核心 | `claude:interrupt` | 中断当前执行 |
| 核心 | `close:session` | 关闭会话 |
| 文件 | `fs:list` / `fs:read` / `fs:write` / `fs:upload` / `fs:delete` | 文件操作 |
| 工具 | `tool:approve` / `tool:reject` | Hyper Space 工具审批 |
| 心跳 | `ping` | 心跳 |
| Agent | `agent:spawn` / `agent:steer` / `agent:kill` / `agent:list` | Hyper Space Worker 管理 |
| MCP | `mcp:tools:register` / `mcp:tool:response` / `mcp:tool:error` | MCP Bridge |
| Token | `register-token` / `register-token-disk` / `reload-tokens` | 令牌管理 |
| 任务 | `task:list` / `task:get` / `task:cancel` / `task:spawn` | 后台任务 |
| 交互 | `ask:answer` | 回答 Agent 的问题 |

**服务端 → 客户端（ServerMessage）：**

| 类别 | 消息类型 | 说明 |
|------|---------|------|
| 认证 | `auth:success` / `auth:failed` / `auth_retry` | 认证结果 |
| 流式 | `claude:stream` | AI 响应文本流 |
| 流式 | `claude:complete` | 流式完成 |
| 流式 | `claude:error` | 执行错误 |
| 流式 | `claude:session` | SDK 会话 ID（用于恢复） |
| 流式 | `claude:usage` | Token 使用统计 |
| 文件 | `fs:result` / `fs:error` | 文件操作结果 |
| 心跳 | `pong` | 心跳响应 |
| 工具 | `tool:call` / `tool:delta` / `tool:result` / `tool:error` | 工具执行生命周期 |
| 终端 | `terminal:output` | 终端输出 |
| 思考 | `thought` / `thought:delta` | 思考过程 |
| MCP | `mcp:status` / `mcp:tool:call` | MCP 状态和工具调用 |
| Worker | `worker:started` / `worker:completed` | Hyper Space Worker 事件 |

### 4.2 认证流程

```
AICO-Bot (Client)                          remote-agent-proxy (Server)
       │                                           │
       │── WebSocket (Authorization header) ──────►│
       │── { type: 'register-token-disk' } ───────►│ 注册令牌到磁盘
       │◄── { type: 'register-token-disk:success' }─│
       │── { type: 'auth', payload: { token } } ───►│ 验证令牌
       │◄── { type: 'auth:success' } ───────────────│
       │                                           │
       │── { type: 'claude:chat', ... } ───────────►│ 开始聊天
```

### 4.3 远程聊天消息流

```
AICO-Bot                    WebSocket              remote-agent-proxy           Claude SDK
   │                           │                          │                         │
   │  executeRemoteMessage()   │                          │                         │
   │                           │                          │                         │
   │  1. 建立 SSH 隧道          │                          │                         │
   │  (如果 useSshTunnel)     │                          │                         │
   │                           │                          │                         │
   │  2. acquireConnection()  │                          │                         │
   │──────── WebSocket ───────►│                          │                         │
   │                           │                          │                         │
   │  3. registerMcpTools()    │                          │                         │
   │── mcp:tools:register ───►│── (存储工具定义)          │                         │
   │                           │                          │                         │
   │  4. sendChatWithStream()  │                          │                         │
   │── claude:chat ──────────►│── streamChat() ──────────►│── createSession/send   │
   │                           │                          │                         │
   │◄── claude:session ───────│◄─────────────────────────│◄── sessionId            │
   │  (保存会话 ID)            │                          │                         │
   │                           │                          │                         │
   │◄── thought ──────────────│◄─────────────────────────│◄── thinking start       │
   │◄── thought:delta ────────│◄─────────────────────────│◄── thinking delta       │
   │◄── thought ──────────────│◄─────────────────────────│◄── thinking stop        │
   │                           │                          │                         │
   │◄── claude:stream ────────│◄─────────────────────────│◄── text delta           │
   │◄── claude:stream ────────│◄─────────────────────────│◄── text delta           │
   │  (转发到 UI)              │                          │                         │
   │                           │                          │                         │
   │  5. AI 调用本地工具        │                          │                         │
   │◄── mcp:tool:call ────────│◄── (AI 想用 browser_click)│                         │
   │                           │                          │                         │
   │  本地执行 browser_click   │                          │                         │
   │── mcp:tool:response ────►│── tool result ──────────►│── 继续生成              │
   │                           │                          │                         │
   │◄── tool:call ────────────│◄─────────────────────────│◄── Bash 工具调用         │
   │◄── terminal:output ──────│◄─────────────────────────│◄── 命令输出             │
   │  (转发到终端面板)         │                          │                         │
   │                           │                          │                         │
   │◄── claude:complete ──────│◄─────────────────────────│◄── 生成完成             │
   │◄── claude:usage ─────────│◄─────────────────────────│◄── token 统计           │
   │                           │                          │                         │
   │  6. 持久化消息和会话       │                          │                         │
   │  releaseConnection()     │                          │                         │
```

### 4.4 中断流程

```
AICO-Bot                    WebSocket              remote-agent-proxy
   │                           │                          │
   │  用户点击停止按钮          │                          │
   │  interrupt(sessionId)     │                          │
   │                           │                          │
   │── claude:interrupt ─────►│── 中断 SDK 流           │
   │── close:session ────────►│── 清理会话              │
   │                           │                          │
   │  等待 300ms 排空队列       │                          │
   │  设置 isInterrupted=true  │                          │
   │  拒绝所有 pending promise │                          │
   │  disconnect()             │                          │
```

---

## 5. 消息路由

**位置：** `src/main/services/agent/send-message.ts`

`sendMessage()` 是所有聊天的入口，根据 Space 配置路由：

```typescript
if (space.claudeSource === 'remote' && space.remoteServerId) {
  // → executeRemoteMessage()  远程执行
} else if (space.spaceType === 'hyper') {
  // → Hyper Space 编排
} else {
  // → 本地 SDK 执行
}
```

**远程执行关键配置（Space 级别）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `claudeSource` | `'local' \| 'remote'` | 设为 `'remote'` 触发远程执行 |
| `remoteServerId` | `string` | 目标远程服务器 ID |
| `remotePath` | `string?` | 远程工作目录 |
| `useSshTunnel` | `boolean` | 是否使用 SSH 隧道（默认 `true`） |

**会话恢复：**
- 首次聊天：发送完整对话历史
- 恢复会话（`sdkSessionId` 存在）：仅发送当前用户消息（增量模式）
- `sdkSessionId` 由远程代理通过 `claude:session` 事件返回，本地持久化到对话记录

---

## 6. 部署架构

### 6.1 单 PC 部署

```
远程服务器
├── /opt/claude-deployment-abc123def456/
│   ├── proxy/           # remote-agent-proxy 代码
│   ├── .env             # API_KEY=sk-xxx, PORT=30000
│   └── node_modules/
```

### 6.2 多 PC 隔离

同一远程服务器支持多台本地 PC 同时使用，每台 PC 有独立的代理实例：

```
远程服务器
├── /opt/claude-deployment-abc123def456/   # PC-A
│   ├── proxy/ .env (PORT=30000)
│   └── ...
├── /opt/claude-deployment-fed789cba012/   # PC-B
│   ├── proxy/ .env (PORT=30042)
│   └── ...
└── /opt/claude-deployment-345ghi678jkl/   # PC-C
    ├── proxy/ .env (PORT=30084)
    └── ...
```

端口通过确定性哈希从 `clientId` 分配（范围 30000-40000），同一台 PC 始终获得相同端口。

### 6.3 SSH 隧道 vs 直连

| 模式 | 连接方式 | 适用场景 |
|------|---------|---------|
| SSH 隧道（默认） | `ws://localhost:{localPort}/agent` | 远程服务器在内网或仅开放 SSH |
| 直连 | `ws://{host}:{port}/agent` | 远程服务器直接开放 WebSocket 端口 |

---

## 7. IPC 接口

**位置：** `src/main/ipc/remote-server.ts`（~590 行）

所有远程操作通过 IPC 暴露给渲染进程，再通过 `src/renderer/api/index.ts` 以双模式（Electron IPC / HTTP）提供给前端。

### 7.1 服务器管理

| IPC 通道 | 说明 |
|----------|------|
| `remote-server:add` | 添加远程服务器配置 |
| `remote-server:list` | 列出所有服务器 |
| `remote-server:get` | 获取单个服务器详情 |
| `remote-server:update` | 更新服务器配置 |
| `remote-server:delete` | 删除服务器 |
| `remote-server:test-connection` | 测试连接 |

### 7.2 部署与 Agent 生命周期

| IPC 通道 | 说明 |
|----------|------|
| `remote-server:deploy` | 部署代理到服务器 |
| `remote-server:connect` | 建立 WebSocket 连接 |
| `remote-server:disconnect` | 断开连接 |
| `remote-server:check-agent` | 检查 SDK 是否安装 |
| `remote-server:deploy-agent` | 部署 SDK |
| `remote-server:start-agent` | 启动 Agent 进程 |
| `remote-server:stop-agent` | 停止 Agent 进程 |
| `remote-server:update-agent` | 完整更新（停止 + 部署 + 重启） |
| `remote-server:get-agent-logs` | 获取 Agent 日志 |
| `remote-server:is-agent-running` | 检查 Agent 运行状态 |

### 7.3 远程文件操作

| IPC 通道 | 说明 |
|----------|------|
| `remote-agent:fs-list` | 列出远程目录 |
| `remote-agent:fs-read` | 读取远程文件 |
| `remote-agent:fs-write` | 写入远程文件 |
| `remote-agent:fs-delete` | 删除远程文件 |

### 7.4 推送事件（主进程 → 渲染进程）

| 事件 | 说明 |
|------|------|
| `remote-server:status-change` | 服务器状态变更 |
| `remote-server:command-output` | 实时命令输出 |
| `remote-server:deploy-progress` | 部署进度更新 |
| `remote-server:update-complete` | 更新完成通知 |
| `remote-task:update` | 后台任务状态更新 |

---

## 8. 服务器配置

### 8.1 RemoteServer 配置结构

```typescript
interface RemoteServer {
  id: string                    // 唯一标识
  name: string                  // 显示名称
  host: string                  // 服务器地址
  sshPort: number               // SSH 端口（默认 22）
  username: string              // SSH 用户名
  password: string              // SSH 密码（加密存储）
  wsPort: number                // WebSocket 端口
  authToken: string             // 认证令牌
  status: 'disconnected' | 'connected' | 'deploying' | 'error'
  error?: string                // 错误信息
  workDir?: string              // 远程工作目录
  claudeApiKey?: string         // Claude API Key
  claudeBaseUrl?: string         // 自定义 API 地址
  claudeModel?: string           // 模型名称
  aiSourceId?: string            // AI 模型源 ID
  sdkInstalled?: boolean         // SDK 是否已安装
  sdkVersion?: string            // SDK 版本
  agentPath?: string             // claude-agent 二进制路径
  clientId?: string              // 本地 PC 标识
  assignedPort?: number          // 分配的端口号
  deployPath?: string            // 部署路径
}
```

### 8.2 AI 模型选择

远程 Agent 支持两种模型配置方式：

1. **直接配置：** 在服务器配置中填写 `claudeApiKey` + `claudeModel`
2. **AI 模型源绑定：** 通过 `aiSourceId` 关联已配置的 AI 模型源，支持 OpenAI 兼容 API

---

## 9. 远程思考过程流

远程 Agent 的思考过程（Thinking）通过专用消息类型传输：

```
远程服务器 (Claude SDK)       本地客户端 (send-message.ts)    前端 (chat.store.ts)
─────────────────────────    ─────────────────────────────    ─────────────────────
SDK thinking event            thought 事件 ────────────────►    handleAgentThought()
  |- thinking start ────────►    (type, text, isStreaming)      (显示思考面板)
  |- thinking delta ───────►  thought:delta 事件 ───────────►  handleAgentThoughtDelta()
  +- thinking stop ─────────►    (完成信号)                   thought.isStreaming = false
```

与本地执行不同，远程思考事件通过 WebSocket 异步传输，存在网络延迟。本地前端在收到 `thought` 事件时立即显示思考面板。

---

## 10. 故障排查

### 10.1 连接失败

| 症状 | 可能原因 | 解决方法 |
|------|---------|---------|
| `auth:failed` | authToken 不匹配 | 重新部署代理，确保本地和服务端的 token 一致 |
| WebSocket 连接超时 | SSH 隧道未建立 | 检查 SSH 凭证、网络连通性、端口是否被占用 |
| `ECONNREFUSED` | 代理未运行 | SSH 到服务器，检查代理进程是否存活 |
| 90 秒后断开 | 网络不稳定或防火墙 | 检查防火墙规则，确保 WebSocket 长连接不被中断 |

### 10.2 部署失败

| 症状 | 可能原因 | 解决方法 |
|------|---------|---------|
| SDK 版本不匹配 | SDK 版本 < 0.2.104 | 远程执行 `npm install @anthropic-ai/claude-agent-sdk@latest` |
| 权限不足 | 无法写入 /opt | 使用 sudo 部署，或修改部署路径 |
| 端口冲突 | 分配的端口已被占用 | 系统会自动重试，最多 20 次 |

### 10.3 执行异常

| 症状 | 可能原因 | 解决方法 |
|------|---------|---------|
| 消息发送后无响应 | 代理进程崩溃 | 检查代理日志 `remote-server:get-agent-logs` |
| 中断后无法恢复 | 会话状态不一致 | 开启新会话，不使用恢复模式 |
| MCP 工具调用失败 | 本地工具服务未启动 | 确认 ai-browser 服务正常运行 |
| Token 使用量异常 | API Key 额度用尽 | 检查 API 账户余额 |

### 10.4 诊断命令

```bash
# 检查远程代理状态
curl http://{server}:{port+1}/health

# 检查 API 连通性
curl http://{server}:{port+1}/health/api

# 检查后台任务
curl http://{server}:{port+1}/tasks

# 查看代理日志
# 通过 AICO-Bot UI: 设置 → 远程服务器管理 → 服务器详情 → 查看日志
```

---

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始文档 | @moonseeker1 |
