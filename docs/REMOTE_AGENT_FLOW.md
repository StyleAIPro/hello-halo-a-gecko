# Halo 远程调用流程分析

本文档详细描述了 Halo 通过本地应用调用远程服务器 Claude Code 的完整架构和交互流程。

---

## 一、架构概览

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              Halo 本地应用                                            │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  ┌─────────────────┐     IPC      ┌─────────────────────────────────────────────┐  │
│  │   Renderer      │ ◄─────────► │              Main Process                    │  │
│  │   (React)       │             │                                             │  │
│  │                 │             │  send-message.ts                            │  │
│  │  ChatStore      │             │  ├─ 判断 space.claudeSource === 'remote'    │  │
│  │  sendMessage()  │             │  └─ 调用 executeRemoteMessage()             │  │
│  └─────────────────┘             │                                             │  │
│                                  │  ssh-tunnel.service.ts                      │  │
│                                  │  └─ 建立 SSH 隧道: localhost:8080 → 远程    │  │
│                                  │                                             │  │
│                                  │  remote-ws-client.ts                        │  │
│                                  │  └─ WebSocket 连接到 localhost:8080        │  │
│                                  └──────────────────┬──────────────────────────┘  │
│                                                     │                              │
└─────────────────────────────────────────────────────┼──────────────────────────────┘
                                                      │
                                                      │ SSH 隧道 (端口转发)
                                                      │ ssh -L 8080:localhost:8080 root@124.71.177.25
                                                      │
┌─────────────────────────────────────────────────────┼──────────────────────────────┐
│                         远程服务器 (124.71.177.25)    │                              │
├─────────────────────────────────────────────────────┼──────────────────────────────┤
│                                                     │                              │
│                                  ┌──────────────────▼──────────────────────┐      │
│                                  │    Remote Agent Proxy (Node.js)          │      │
│                                  │    监听 0.0.0.0:8080                      │      │
│                                  │                                          │      │
│                                  │    server.ts (WebSocket Server)          │      │
│                                  │    ├─ 鉴权: Authorization header         │      │
│                                  │    └─ 消息路由: claude:chat, fs:*, etc   │      │
│                                  │                                          │      │
│                                  │    claude-manager.ts                     │      │
│                                  │    └─ 管理 V2 Session                    │      │
│                                  └──────────────────┬──────────────────────┘      │
│                                                     │                              │
│                                                     │ spawn                        │
│                                                     ▼                              │
│                                  ┌──────────────────────────────────────────┐      │
│                                  │    Claude Code SDK (V2 Session)          │      │
│                                  │    - 读取 .env 配置                       │      │
│                                  │    - 调用阿里云 DashScope API            │      │
│                                  │    - 执行工具、文件操作                   │      │
│                                  └──────────────────┬──────────────────────┘      │
│                                                     │                              │
│                                                     │ HTTP                         │
│                                                     ▼                              │
│                                  ┌──────────────────────────────────────────┐      │
│                                  │    阿里云 DashScope API                   │      │
│                                  │    https://coding.dashscope.aliyuncs.com │      │
│                                  │    Model: qwen3.5-plus                   │      │
│                                  └──────────────────────────────────────────┘      │
│                                                                                     │
│  配置文件: /opt/claude-deployment/.env                                              │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │  ANTHROPIC_AUTH_TOKEN=sk-sp-f1fb71b790544f06874154d1693db6de               │   │
│  │  ANTHROPIC_BASE_URL=https://coding.dashscope.aliyuncs.com/apps/anthropic   │   │
│  │  ANTHROPIC_MODEL=qwen3.5-plus                                               │   │
│  │  PORT=8080                                                                  │   │
│  │  AUTH_TOKEN=MTc3MjM0ODUyMTc3NS0wLjM5Mjk5NDM2                                 │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、核心组件清单

### 2.1 本地组件

| 组件 | 文件路径 | 职责 |
|------|----------|------|
| `executeRemoteMessage` | `src/main/services/agent/send-message.ts` | 远程消息发送入口 |
| `sshTunnelService` | `src/main/services/remote-ssh/ssh-tunnel.service.ts` | SSH 端口转发 |
| `RemoteWsClient` | `src/main/services/remote-ws/remote-ws-client.ts` | WebSocket 客户端 |
| `SSHManager` | `src/main/services/remote-ssh/ssh-manager.ts` | SSH 连接管理 |

### 2.2 远程组件 (remote-agent-proxy)

| 组件 | 文件路径 | 职责 |
|------|----------|------|
| `index.ts` | `packages/remote-agent-proxy/src/index.ts` | 入口，加载 .env 配置 |
| `RemoteAgentServer` | `packages/remote-agent-proxy/src/server.ts` | WebSocket 服务器 |
| `ClaudeManager` | `packages/remote-agent-proxy/src/claude-manager.ts` | V2 Session 管理 |

---

## 三、详细交互流程

### 3.1 用户发送消息

```
用户输入 → ChatStore.sendMessage() → IPC → sendMessage() → executeRemoteMessage()
```

**路由判断 (send-message.ts:104-121):**
```typescript
// 判断是否走远程执行
if (space?.claudeSource === 'remote' && space.remoteServerId) {
  await executeRemoteMessage(
    mainWindow,
    request,
    space.remoteServerId,
    space.remotePath || '/root',
    space.useSshTunnel
  )
  return  // 不走本地流程
}
```

---

### 3.2 同步 Auth Token

**目的**: 确保本地配置的 token 与远程服务器一致

```typescript
// send-message.ts:457-494
// 创建临时 SSH 连接读取远程 .env
const tempManager = new SSHManager()
await tempManager.connect({ host, port, username, password })

const envContent = await tempManager.executeCommand(`cat ${DEPLOY_AGENT_PATH}/.env`)
const authTokenMatch = envContent.match(/^AUTH_TOKEN=(.+)/m)

if (authTokenMatch && authTokenMatch[1]) {
  const remoteAuthToken = authTokenMatch[1].trim()
  if (remoteAuthToken !== server.authToken) {
    // 更新本地配置
    server.authToken = remoteAuthToken
    await deployService.updateServer(serverId, { authToken: remoteAuthToken })
  }
}
```

---

### 3.3 建立 SSH 隧道

**目的**: 通过加密隧道访问远程 WebSocket 服务

```
本地 localhost:8080 ←→ SSH 隧道 ←→ 远程 localhost:8080
```

**实现 (ssh-tunnel.service.ts):**
```typescript
// 建立SSH连接
client.connect({
  host: config.host,        // 124.71.177.25
  port: config.port,        // 22
  username: config.username, // root
  password: config.password  // Huawei@234
})

// 创建本地 TCP 服务器
const server = net.createServer((socket) => {
  // 通过 SSH 转发连接
  client.forwardOut(
    '127.0.0.1', config.localPort,   // 本地 8080
    'localhost', config.remotePort,   // 远程 8080
    (err, stream) => {
      socket.pipe(stream).pipe(socket)
    }
  )
})

server.listen(8080, '127.0.0.1')
```

**关键点**:
- 先 `killPort(8080)` 清理占用端口的进程
- 使用 `forwardOut` 实现本地端口转发
- 保持 SSH 心跳 (30s interval)

---

### 3.4 WebSocket 连接

**客户端连接 (remote-ws-client.ts):**
```typescript
// 通过 SSH 隧道连接
const wsUrl = 'ws://localhost:8080/agent'

this.ws = new WebSocket(wsUrl, {
  headers: {
    'Authorization': `Bearer ${this.config.authToken}`
  }
})
```

**服务端鉴权 (server.ts:31-53):**
```typescript
// 检查 Authorization header
const authHeader = req.headers['authorization']
const token = authHeader.split(' ')[1]

if (token === this.config.authToken) {
  console.log('Client authenticated via Authorization header')
  this.clients.set(ws, { authenticated: true })
} else {
  ws.close(1008, 'Unauthorized')
}
```

---

### 3.5 发送聊天请求

**客户端发送 (remote-ws-client.ts:259-325):**
```typescript
sendChatWithStream(sessionId, messages, options) {
  // 注册流式事件处理器
  this.on('claude:stream', (data) => {
    fullContent += data.data?.text || ''
    this.emit('stream', { content: fullContent, delta: text })
  })

  // 发送请求
  this.send({
    type: 'claude:chat',
    sessionId,
    payload: {
      messages,  // 完整消息历史
      options: { ...options, stream: true }
    }
  })
}
```

**服务端处理 (server.ts:199-304):**
```typescript
async handleClaudeChat(ws, sessionId, payload) {
  const { messages, options, stream = true } = payload

  // 流式响应
  for await (const chunk of this.claudeManager.streamChat(
    sessionId,
    messages,
    options,
    onToolCall,
    onTerminalOutput
  )) {
    if (chunk.type === 'text') {
      this.sendMessage(ws, {
        type: 'claude:stream',
        sessionId,
        data: { text: chunk.data?.text || '' }
      })
    }
  }

  // 完成
  this.sendMessage(ws, { type: 'claude:complete', sessionId })
}
```

---

### 3.6 远程 Claude Manager

**V2 Session 创建 (claude-manager.ts:99-140):**
```typescript
getSession(sessionId: string): SDKSession {
  const options: SDKSessionOptions = {
    model: this.model || 'claude-sonnet-4-20250514',
    env: {
      ANTHROPIC_AUTH_TOKEN: this.apiKey,    // 阿里云 API Key
      ANTHROPIC_BASE_URL: this.baseUrl,     // DashScope URL
      CLAUDE_WORK_DIR: this.workDir,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      DISABLE_AUTOUPDATER: '1',
      API_TIMEOUT_MS: '3000000'
    }
  }

  const session = unstable_v2_createSession(options)
  return session
}
```

**流式聊天 (claude-manager.ts:184-329):**
```typescript
async *streamChat(sessionId, messages, options, onToolCall, onTerminalOutput) {
  const session = this.getSession(sessionId)

  // 发送最后一条消息
  const lastMessage = messages[messages.length - 1]
  await session.send(lastMessage.content)

  // 流式接收响应
  for await (const event of session.stream()) {
    if (event.type === 'content_block_delta' && event.delta?.text) {
      yield { type: 'text', data: { text: event.delta.text } }
    }
    if (event.type === 'result') {
      break
    }
  }
}
```

---

## 四、消息协议

### 4.1 客户端 → 服务端

| 类型 | 说明 | payload |
|------|------|---------|
| `auth` | 鉴权 | `{ token: string }` |
| `claude:chat` | 聊天请求 | `{ messages, options, stream }` |
| `fs:list` | 列出文件 | `{ path }` |
| `fs:read` | 读取文件 | `{ path }` |
| `fs:write` | 写入文件 | `{ path, content }` |
| `fs:delete` | 删除文件 | `{ path }` |
| `tool:approve` | 批准工具 | `{ toolId }` |
| `tool:reject` | 拒绝工具 | `{ toolId, reason }` |
| `ping` | 心跳 | - |

### 4.2 服务端 → 客户端

| 类型 | 说明 | data |
|------|------|------|
| `auth:success` | 鉴权成功 | - |
| `auth:failed` | 鉴权失败 | `{ message }` |
| `claude:stream` | 文本流 | `{ text }` |
| `claude:complete` | 聊天完成 | `{ content? }` |
| `claude:error` | 聊天错误 | `{ error }` |
| `tool:call` | 工具调用 | `{ id, name, input, status }` |
| `tool:result` | 工具结果 | `{ output }` |
| `terminal:output` | 终端输出 | `{ content, type }` |
| `pong` | 心跳响应 | - |

---

## 五、完整时序图

```
┌────────┐  ┌──────────┐  ┌─────────────┐  ┌───────────┐  ┌────────────┐  ┌──────────┐
│ User   │  │ Renderer │  │ Main Process│  │ SSH Tunnel│  │ Remote WS  │  │ Claude   │
│        │  │          │  │             │  │ (Local)   │  │ Server     │  │ Manager  │
└───┬────┘  └────┬─────┘  └──────┬──────┘  └─────┬─────┘  └──────┬─────┘  └────┬─────┘
    │            │               │               │               │              │
    │ Send msg   │               │               │               │              │
    │───────────►│               │               │               │              │
    │            │               │               │               │              │
    │            │ IPC: send     │               │               │              │
    │            │──────────────►│               │               │              │
    │            │               │               │               │              │
    │            │               │ Sync auth token (SSH)         │              │
    │            │               │──────────────►│               │              │
    │            │               │               │               │              │
    │            │               │ Establish SSH tunnel         │              │
    │            │               │──────────────►│               │              │
    │            │               │               │               │              │
    │            │               │◄──────────────│               │              │
    │            │               │  Tunnel ready │               │              │
    │            │               │               │               │              │
    │            │               │ WebSocket connect (via tunnel)│              │
    │            │               │──────────────────────────────►│              │
    │            │               │               │               │              │
    │            │               │               │  Auth check   │              │
    │            │               │◄─────────────────────────────►│              │
    │            │               │               │               │              │
    │            │               │ Send claude:chat              │              │
    │            │               │──────────────────────────────►│              │
    │            │               │               │               │              │
    │            │               │               │  Create/Get V2 Session       │
    │            │               │               │               │─────────────►│
    │            │               │               │               │              │
    │            │               │               │  session.send(msg)           │
    │            │               │               │               │─────────────►│
    │            │               │               │               │              │
    │            │               │               │               │  API request │
    │            │               │               │               │─────────────►│
    │            │               │               │               │              │
    │            │               │               │               │  Stream resp │
    │            │               │               │               │◄─────────────│
    │            │               │               │               │              │
    │            │               │               │  claude:stream│              │
    │            │               │◄──────────────────────────────│              │
    │            │               │               │  { text }     │              │
    │            │               │               │               │              │
    │            │ agent:message │               │               │              │
    │            │◄──────────────│               │               │              │
    │            │               │               │               │              │
    │ See text...│               │               │               │              │
    │◄───────────│               │               │               │              │
    │            │               │               │               │              │
    │            │               │               │  ... more streams ...        │
    │            │               │               │               │              │
    │            │               │               │  claude:complete             │
    │            │               │◄──────────────────────────────│              │
    │            │               │               │               │              │
    │            │ agent:complete│               │               │              │
    │            │◄──────────────│               │               │              │
    │            │               │               │               │              │
    │ Done       │               │               │               │              │
    │◄───────────│               │               │               │              │
```

---

## 六、远程服务器配置

### 6.1 目录结构

```
/opt/claude-deployment/
├── dist/
│   └── index.js          # 编译后的入口文件
├── node_modules/
│   └── @anthropic-ai/claude-agent-sdk/
├── data/                 # 数据目录
├── logs/                 # 日志目录
├── .env                  # 环境变量配置
├── package.json
└── index.js              # 启动脚本
```

### 6.2 环境变量 (.env)

```bash
# API 配置 (阿里云 DashScope)
ANTHROPIC_AUTH_TOKEN=sk-sp-f1fb71b790544f06874154d1693db6de
ANTHROPIC_BASE_URL=https://coding.dashscope.aliyuncs.com/apps/anthropic
ANTHROPIC_MODEL=qwen3.5-plus

# 服务器配置
PORT=8080

# WebSocket 鉴权 Token
AUTH_TOKEN=MTc3MjM0ODUyMTc3NS0wLjM5Mjk5NDM2
```

### 6.3 依赖 (package.json)

```json
{
  "name": "@halo/remote-agent-proxy",
  "version": "1.0.0",
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.1.76",
    "dotenv": "^17.3.1",
    "ws": "^8.18.0"
  }
}
```

---

## 七、与本地调用的对比

| 特性 | 本地调用 | 远程调用 |
|------|----------|----------|
| **执行位置** | 本地 Electron 进程 | 远程服务器 Node.js |
| **通信方式** | 直接 SDK 调用 | WebSocket over SSH 隧道 |
| **API 提供商** | Anthropic 或配置的提供商 | 远程服务器配置的提供商 |
| **Session 管理** | 本地 v2Sessions Map | 远程 ClaudeManager |
| **文件操作** | 本地文件系统 | 远程文件系统 |
| **网络要求** | 无 | 需要 SSH 连接 |
| **延迟** | 低 | 有 SSH + WS 开销 |
| **安全性** | 本地信任 | Token 鉴权 + SSH 加密 |

---

## 八、关键代码路径

### 8.1 本地发送远程消息

```
src/main/services/agent/send-message.ts:398-790
├── executeRemoteMessage()
│   ├── 同步 Auth Token (SSH)
│   ├── 建立 SSH 隧道 (可选)
│   ├── 检查/部署/启动远程 Agent
│   ├── 创建 WebSocket 客户端
│   ├── 注册事件处理器
│   ├── 构建消息历史
│   └── 发送聊天请求
```

### 8.2 远程服务处理

```
packages/remote-agent-proxy/src/
├── index.ts                    # 入口，加载 .env
├── server.ts                   # WebSocket 服务器
│   ├── connection handler      # 鉴权
│   └── message handler         # 路由
└── claude-manager.ts           # V2 Session 管理
    ├── getSession()            # 创建/复用 Session
    └── streamChat()            # 流式聊天
```

---

## 九、错误处理

### 9.1 常见错误

| 错误 | 原因 | 解决方案 |
|------|------|----------|
| `EADDRINUSE: port 8080` | 本地端口被占用 | `killPort()` 清理进程 |
| `Authentication failed` | Token 不匹配 | 同步远程 AUTH_TOKEN |
| `SSH tunnel failed` | SSH 连接失败 | 检查网络/密码 |
| `WebSocket timeout` | 连接超时 | 检查远程服务状态 |
| `Agent not running` | 远程服务未启动 | 自动部署/启动 |

### 9.2 自动恢复机制

1. **端口冲突**: 自动 `killPort(8080)` 清理
2. **Token 不匹配**: 自动同步远程配置
3. **服务未运行**: 自动部署并启动
4. **连接断开**: WebSocket 自动重连 (最多 5 次)

---

## 十、监控与调试

### 10.1 查看远程服务状态

```bash
# SSH 登录
ssh root@124.71.177.25

# 检查服务进程
ps aux | grep node

# 检查端口监听
netstat -tlnp | grep 8080

# 查看日志
tail -f /opt/claude-deployment/logs/*.log
```

### 10.2 本地调试日志

```typescript
// 开启详细日志
console.log(`[Agent][Remote] Connecting to WebSocket...`)
console.log(`[RemoteWsClient] Auth token: ${token.substring(0, 10)}...`)
console.log(`[SshTunnel] Tunnel established: localhost:8080 -> ${host}:8080`)
```

---

*文档生成时间: 2026-03-01*
*远程服务器: 124.71.177.25*
