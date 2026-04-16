# Remote Agent Proxy 多客户端隔离分析

本文档分析了多个 AICO-Bot 客户端连接同一台远程服务器 proxy 时的会话隔离机制，包括 SDK 子进程、MCP 工具调用、模型服务调用、记忆管理等维度的隔离情况，以及已知问题和改进方案。

---

## 一、整体架构

```
AICO-Bot 客户端 A                    AICO-Bot 客户端 B
=================                    =================
Token-A (auth + credentials)         Token-B (auth + credentials)
WebSocket 连接 1                      WebSocket 连接 2
conversationId-A                     conversationId-B
MCP Tools A (per-ws)                 MCP Tools B (per-ws)
       |                                    |
       v                                    v
     Remote Agent Proxy (server.ts)
       |                                    |
       v                                    v
  ClaudeManager.sessions Map
  ┌─────────────────────┐    ┌─────────────────────┐
  │ Session A           │    │ Session B           │
  │ (SDK 子进程 A)      │    │ (SDK 子进程 B)      │
  │ 独立对话历史        │    │ 独立对话历史        │
  │ 独立 system prompt  │    │ 独立 system prompt  │
  │ 独立工作目录        │    │ 独立工作目录        │
  └─────────────────────┘    └─────────────────────┘
       |                                    |
       v                                    v
  各自调用 LLM API (独立凭证)
```

---

## 二、各维度隔离情况

### 2.1 SDK 子进程隔离 (已隔离)

- **隔离 key**: `conversationId` (即客户端发送的 `sessionId`)
- **实现位置**: `claude-manager.ts` 中的 `sessions` Map
- **机制**: 每个 `conversationId` 对应一个独立的 `@anthropic-ai/claude-agent-sdk` V2 Session（即一个独立的 SDK 子进程）
- **子进程包含**: 独立的对话历史、system prompt、工作目录、MCP servers

```typescript
// claude-manager.ts
private sessions: Map<string, V2SessionInfo> = new Map()

// Session 创建/复用
const existing = this.sessions.get(conversationId)
if (existing) {
  // 检查配置变更，决定是否复用
} else {
  // 创建新 Session: unstable_v2_createSession()
}
```

**Session 复用判断条件** (任一变更则销毁重建):
- SDK 子进程是否存活 (transport readiness)
- 模型、工作目录、API Key、Base URL、Context Window 是否变更
- MCP 工具签名是否变更
- Resume Session ID 是否存在

### 2.2 API 凭证隔离 (已隔离)

- **隔离方式**: 按 token 隔离，3 级优先级解析
- **实现位置**: `server.ts` 中的 `tokenCredentials` Map

```typescript
// server.ts
private tokenCredentials: Map<string, { apiKey?: string; baseUrl?: string; model?: string }> = new Map()
```

**凭证解析优先级**:
1. **per-request options**: 单次请求中显式传入的 `apiKey`, `baseUrl`, `model`
2. **token-bound credentials**: 通过 `credentials:update` 绑定到当前 authToken 的凭证
3. **instance-level config**: proxy 启动时的全局配置 (`.env` 或环境变量)

```typescript
// server.ts handleClaudeChat
const boundCredentials = client?.authToken ? this.tokenCredentials.get(client.authToken) : undefined
const resolvedOptions = (boundCredentials && !options?.apiKey && !options?.baseUrl && !options?.model)
    ? { ...options, apiKey: boundCredentials.apiKey, baseUrl: boundCredentials.baseUrl, model: boundCredentials.model }
    : options
```

凭证最终通过环境变量注入 SDK 子进程:
```typescript
// claude-manager.ts buildSdkOptions
const effectiveApiKey = credentials?.apiKey || this.apiKey
const effectiveBaseUrl = credentials?.baseUrl || this.baseUrl
const effectiveModel = credentials?.model || this.model
```

### 2.3 MCP 工具调用隔离 (已隔离)

- **隔离方式**: 按 WebSocket 连接隔离
- **实现位置**: `server.ts` 中的 `clients` Map per-connection 状态

**工具注册** (per-connection):
```typescript
// server.ts - 每个 ws 连接独立存储 MCP 工具定义
client.aicoBotMcpTools = message.payload?.tools
client.aicoBotMcpCapabilities = message.payload?.aicoBotMcpCapabilities
```

**工具调用路由** (per-session):
```typescript
// server.ts handleClaudeChat - 从当前 ws 连接获取 MCP 工具
const clientState = this.clients.get(ws)
const aicoBotMcpToolDefs = clientState?.aicoBotMcpTools

// 工具执行器绑定到特定的 ws 连接
const aicoBotMcpToolExecutor = aicoBotMcpToolDefs && aicoBotMcpToolDefs.length > 0
    ? (callId, toolName, args) => this.executeAicoBotMcpTool(ws, sessionId, callId, toolName, args)
    : undefined
```

**MCP Bridge 流程**:
1. 客户端 A 连接时发送 `mcp:tools:register`，注册 ai-browser、gh-search 等工具
2. SDK 子进程 A 需要调用 ai-browser 时，proxy 通过 WebSocket 将 `mcp:tool:call` 发回客户端 A 的 ws 连接
3. 客户端 A 本地执行工具，将结果通过 `mcp:tool:response` 发回 proxy
4. proxy 将结果注入 SDK 子进程 A

### 2.4 对话历史/记忆管理隔离 (已隔离)

- **隔离方式**: 每个 SDK 子进程内部维护自己的对话历史
- **增量消息**: 首轮发送完整消息历史，后续只发送最后一条用户消息
- **Session Resume**: 通过 `sdkSessionId` 实现跨 WebSocket 重连的会话恢复

```typescript
// claude-manager.ts streamChat
// 首轮: 完整消息历史
if (!sessionInfo.sdkSessionId) {
  await session.send(messages)
}
// 后续: 只发送最后一条
const lastMessage = messages[messages.length - 1]
await session.send(lastMessage.content)
```

### 2.5 System Prompt 隔离 (已隔离)

每个 session 创建时独立构建 system prompt:
```typescript
// claude-manager.ts buildSdkOptions
const systemPrompt = customSystemPrompt
    ? `${basePrompt}\n\n# Additional Instructions (from space configuration)\n\n${customSystemPrompt}`
    : basePrompt
```

### 2.6 工作目录隔离 (已隔离)

每个 session 有独立的工作目录，变更时销毁重建:
```typescript
// claude-manager.ts
// workDir 变更检测
if (existing.workDir !== options.workDir) {
  // 销毁旧 session，创建新 session
}
```

### 2.7 WebSocket 连接隔离 (已隔离)

每个 WebSocket 连接在 `clients` Map 中有独立的状态对象:
```typescript
// server.ts
private clients: Map<WebSocket, {
    authenticated: boolean
    sessionId?: string
    sdkSessionId?: string
    authToken?: string
    aicoBotMcpTools?: Array<{ name: string; description: string; inputSchema: Record<string, any>; serverName: string }>
    aicoBotMcpCapabilities?: { aiBrowser: boolean; ghSearch: boolean; version?: number }
}> = new Map()
```

### 2.8 Token 认证 (已隔离)

支持多 token 同时存在:
```typescript
// server.ts
private authTokens: Set<string> = new Set()

// Token 来源:
// 1. config.authTokens 数组
// 2. config.authToken 单个
// 3. tokens.json 文件 (热加载，fs.watch + 100ms debounce)
```

客户端可通过 `register-token-disk` 消息自注册 token (无需先认证)。

---

## 三、已知问题与隔离缺陷

### 3.1 CRITICAL: `pendingAskQuestions` 全局清理 Bug

**位置**: `server.ts`

**问题**: 当**任何** session 的 stream 结束时，清理逻辑遍历**所有** pending AskUserQuestion，导致其他 session 的 pending question 被错误 reject。

```
Session A stream 结束
  → 遍历 pendingAskQuestions (全局 Map)
  → Session B 的 pending question 也被 reject ← BUG!
```

**影响**: 并发 session 中出现虚假错误，用户问题提示被意外关闭。

**修复方案**: 将 `pendingAskQuestions` 改为按 session 作用域的嵌套 Map:
```typescript
// 修复前
private pendingAskQuestions: Map<string, { resolve; reject }> = new Map()

// 修复后
private pendingAskQuestions: Map<string, Map<string, { resolve; reject }>> = new Map()
// 外层 key: sessionId, 内层 key: questionId

// 清理时只清理当前 session 的 pending questions
```

### 3.2 Session 与 Token 未绑定

**位置**: `claude-manager.ts`

**问题**: Session 以 `conversationId` 为 key，不校验其归属 token。如果两个不同 token 的客户端发送相同的 `conversationId`，它们会共享同一个 SDK 子进程。

**影响**: 理论上可能跨客户端泄露对话历史、MCP 工具和工作目录。实际碰撞概率极低 (UUID 级别 sessionId)。

**修复方案**: 在 session key 中加入 token 维度，或在 `handleClaudeChat` 中校验 session 归属权:
```typescript
// 方案 A: session key 包含 token
const sessionKey = `${authToken}:${conversationId}`

// 方案 B: session 记录归属 token，访问时校验
if (existing.ownerToken !== client.authToken) {
  // 拒绝访问或创建新 session
}
```

### 3.3 Background Tasks 完全不隔离

**位置**: `server.ts`, `background-tasks.ts`

**问题**: `BackgroundTaskManager` 是全局单例，所有客户端共享同一个任务池。

**影响**:
- 任何认证客户端可以 `task:list` 看到所有任务
- 任何客户端可以 `task:cancel` 取消其他客户端的任务
- 任务更新通过 `broadcastToAllClients` 广播给所有客户端，泄露其他客户端的操作信息 (命令名、输出、PID)

**修复方案**:
```typescript
// 给 task 增加 ownerToken 字段
interface BackgroundTask {
  id: string
  command: string
  cwd: string
  status: 'running' | 'completed' | 'cancelled'
  ownerToken: string  // 新增: 所属客户端 token
}

// task:list 过滤
list(token?: string) {
  const tasks = Array.from(this.tasks.values())
  return token ? tasks.filter(t => t.ownerToken === token) : tasks
}

// task:cancel 校验所有权
cancel(id: string, token: string) {
  const task = this.tasks.get(id)
  if (task && task.ownerToken !== token) return false
  // ...
}

// task:update 只发给 owner
this.bgTaskManager.on('update', (event) => {
  const ownerWs = this.findClientByToken(event.ownerToken)
  if (ownerWs) this.sendMessage(ownerWs, { type: 'task:update', data: event })
})
```

### 3.4 `pendingMcpToolCalls` / `pendingHyperSpaceTools` 全局 Map

**位置**: `server.ts`

**问题**: MCP 工具调用和 HyperSpace 工具的 pending 回调存储在全局 flat Map 中，未按 session 作用域隔离。

**影响**: ID 包含 `Date.now()` + `Math.random()`，实际碰撞概率极低，但架构上不严谨。

**修复方案**: 改为嵌套 Map，按 sessionId 作用域化:
```typescript
// 修复前
private pendingMcpToolCalls: Map<string, { resolve; reject; ws; sessionId }> = new Map()

// 修复后
private pendingMcpToolCalls: Map<string, Map<string, { resolve; reject; ws }>> = new Map()
// 外层 key: sessionId, 内层 key: callId
```

---

## 四、隔离情况总表

| 维度 | 隔离级别 | 隔离方式 | 状态 |
|------|---------|---------|------|
| SDK 子进程 | Per-session | `conversationId` key in sessions Map | ✅ 已隔离 |
| 对话历史 | Per-session | SDK 子进程内部维护 | ✅ 已隔离 |
| API 凭证 | Per-token | 3 级优先级: per-request > token-bound > instance | ✅ 已隔离 |
| MCP 工具定义 | Per-WebSocket | clients Map per-connection state | ✅ 已隔离 |
| MCP 工具调用路由 | Per-WebSocket | executeAicoBotMcpTool 绑定特定 ws | ✅ 已隔离 |
| System Prompt | Per-session | 创建时独立构建 | ✅ 已隔离 |
| 工作目录 | Per-session | 变更时销毁重建 | ✅ 已隔离 |
| WebSocket 连接 | Per-connection | 独立状态对象 | ✅ 已隔离 |
| Token 认证 | Multi-token | Set + per-token credential bindings | ✅ 已隔离 |
| Session 归属权 | 无校验 | 不检查 session 是否属于当前 token | ⚠️ 缺陷 |
| Background Tasks | 全局共享 | 单例 BackgroundTaskManager | ❌ 未隔离 |
| pendingAskQuestions | 全局清理 | stream 结束时清理所有 session 的 pending | ❌ Bug |
| pendingMcpToolCalls | 全局 Map | 未按 session 作用域化 | ⚠️ 理论风险 |

---

## 五、改进优先级

| 优先级 | 问题 | 影响范围 | 修复复杂度 |
|--------|------|---------|-----------|
| P0 | `pendingAskQuestions` 全局清理 bug | 并发 session 稳定性 | 低 — 改为嵌套 Map |
| P1 | Session 与 Token 未绑定 | 安全性 (跨客户端泄露) | 低 — session key 加入 token |
| P1 | Background Tasks 无隔离 | 功能隔离 + 信息泄露 | 中 — task 增加 owner，过滤/校验 |
| P2 | `pendingMcpToolCalls` / `pendingHyperSpaceTools` 全局 Map | 理论风险 | 低 — 改为嵌套 Map |

---

## 六、关键代码位置索引

| 文件 | 关键行号 | 说明 |
|------|---------|------|
| `packages/remote-agent-proxy/src/server.ts` | 19-27 | clients Map 定义 (per-connection state) |
| `packages/remote-agent-proxy/src/server.ts` | 33-36 | authTokens Set + tokenCredentials Map |
| `packages/remote-agent-proxy/src/server.ts` | 39-54 | pendingHyperSpaceTools + pendingMcpToolCalls + pendingAskQuestions |
| `packages/remote-agent-proxy/src/server.ts` | 106-180 | WebSocket connection handler |
| `packages/remote-agent-proxy/src/server.ts` | 430-437 | MCP tools register (per-ws) |
| `packages/remote-agent-proxy/src/server.ts` | 768-776 | credential resolution (3-tier priority) |
| `packages/remote-agent-proxy/src/server.ts` | 872-877 | MCP tool executor binding to ws |
| `packages/remote-agent-proxy/src/server.ts` | 1181-1219 | executeAicoBotMcpTool |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 511 | sessions Map 定义 |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 706-746 | createSdkMcpServer (per-session MCP) |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 762-917 | buildSdkOptions (credential injection) |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 998-1247 | getOrCreateSession |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 1555-1562 | message sending (incremental) |

---

*文档生成时间: 2026-04-14*
