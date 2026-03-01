# Halo 本地调用流程分析

本文档详细描述了 Halo 应用本地调用 Claude Code SDK 的完整架构和交互流程。

## 一、架构概览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Halo Electron App                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐     IPC      ┌─────────────────────────────────────┐  │
│  │   Renderer      │ ◄─────────► │          Main Process               │  │
│  │   (React)       │             │                                     │  │
│  │                 │             │  ┌───────────────────────────────┐  │  │
│  │  ┌───────────┐  │             │  │     Agent Module              │  │  │
│  │  │ChatStore  │  │             │  │                               │  │  │
│  │  └─────┬─────┘  │             │  │  ┌─────────────────────────┐  │  │  │
│  │        │        │             │  │  │  Session Manager        │  │  │  │
│  │  ┌─────▼─────┐  │             │  │  │  (V2 Session 复用)       │  │  │  │
│  │  │   API     │  │             │  │  └─────────────────────────┘  │  │  │
│  │  └───────────┘  │             │  │                               │  │  │
│  │                 │             │  │  ┌─────────────────────────┐  │  │  │
│  │  ┌───────────┐  │             │  │  │  SDK Config Builder     │  │  │  │
│  │  │Components │  │             │  │  │  (环境变量/配置)         │  │  │  │
│  │  │- Message  │  │             │  │  └─────────────────────────┘  │  │  │
│  │  │- Thought  │  │             │  │                               │  │  │
│  │  │- ToolCall │  │             │  │  ┌─────────────────────────┐  │  │  │
│  │  └───────────┘  │             │  │  │  Stream Processor        │  │  │  │
│  │                 │             │  │  │  (流式事件处理)          │  │  │  │
│  └─────────────────┘             │  │  └─────────────────────────┘  │  │  │
│                                  │  │                               │  │  │
│                                  │  │  ┌─────────────────────────┐  │  │  │
│                                  │  │  │  OpenAI Compat Router   │  │  │  │
│                                  │  │  │  (多提供商路由)          │  │  │  │
│                                  │  │  └─────────────────────────┘  │  │  │
│                                  │  └───────────────────────────────┘  │  │
│                                  └──────────────────┬──────────────────┘  │
│                                                     │                      │
│                                                     │ spawn                │
│                                                     ▼                      │
│                                  ┌──────────────────────────────────────┐ │
│                                  │   Claude Code SDK (V2 Session)       │ │
│                                  │   - Headless Electron as Node        │ │
│                                  │   - MCP Servers                      │ │
│                                  │   - Tool Execution                   │ │
│                                  └──────────────────┬──────────────────┘ │
│                                                     │ HTTP                │
│                                                     ▼                      │
│                                  ┌──────────────────────────────────────┐ │
│                                  │   Anthropic API / 其他 LLM 提供商     │ │
│                                  └──────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、核心组件清单

| 层级 | 组件 | 文件路径 | 职责 |
|------|------|----------|------|
| **前端** | `ChatStore` | `src/renderer/stores/chat.store.ts` | 状态管理、事件处理、消息发送 |
| **前端** | `api` | `src/renderer/api/index.ts` | IPC 调用封装 |
| **前端** | `transport` | `src/renderer/api/transport.ts` | Electron/HTTP 双模式通信 |
| **IPC** | `agent.ts` | `src/main/ipc/agent.ts` | IPC 处理器注册 |
| **后端** | `send-message.ts` | `src/main/services/agent/send-message.ts` | 消息发送主入口 |
| **后端** | `session-manager.ts` | `src/main/services/agent/session-manager.ts` | V2 Session 生命周期管理 |
| **后端** | `sdk-config.ts` | `src/main/services/agent/sdk-config.ts` | SDK 配置构建 |
| **后端** | `stream-processor.ts` | `src/main/services/agent/stream-processor.ts` | 流式事件处理 |
| **后端** | `helpers.ts` | `src/main/services/agent/helpers.ts` | 工具函数 |
| **后端** | `config.service.ts` | `src/main/services/config.service.ts` | API 凭证管理 |
| **后端** | `openai-compat-router` | `src/main/openai-compat-router/` | 多提供商路由兼容 |
| **SDK** | `@anthropic-ai/claude-agent-sdk` | npm 包 | Claude Code CLI 封装 |

---

## 三、详细交互流程

### 3.1 用户发送消息

```
用户输入 → ChatStore.sendMessage() → api.agentSendMessage() → IPC → Main Process
```

**前端 (chat.store.ts):**
```typescript
sendMessage: async (content, images, aiBrowserEnabled, thinkingEnabled) => {
  await api.agentSendMessage({
    spaceId,
    conversationId,
    message: content,
    images,
    aiBrowserEnabled,
    thinkingEnabled
  })
}
```

**IPC (agent.ts):**
```typescript
ipcMain.handle('agent:send-message', async (_event, request) => {
  await sendMessage(getMainWindow(), request)
  return { success: true }
})
```

---

### 3.2 Main Process 处理 (send-message.ts)

**入口函数:**
```typescript
export async function sendMessage(mainWindow, request) {
  // 1. 获取 Space 信息
  const space = getSpace(spaceId)

  // 2. 如果是远程执行，路由到 executeRemoteMessage()
  if (space?.claudeSource === 'remote' && space.remoteServerId) {
    await executeRemoteMessage(...)  // WebSocket 远程调用
    return
  }

  // 3. 本地执行流程
  const config = getConfig()
  const workDir = getWorkingDir(spaceId)

  // 4. 获取 API 凭证
  const credentials = await getApiCredentials(config)
  const resolvedCredentials = await resolveCredentialsForSdk(credentials)

  // 5. 获取或创建 V2 Session
  const v2Session = await getOrCreateV2Session(spaceId, conversationId, sdkOptions, sessionId)

  // 6. 处理流式响应
  await processStream({ v2Session, sessionState, ... })
}
```

---

### 3.3 V2 Session 管理 (session-manager.ts)

**核心功能：进程复用，避免每次冷启动 (3-5s)**

```typescript
export async function getOrCreateV2Session(spaceId, conversationId, sdkOptions, sessionId) {
  // 1. 检查是否已有可用 Session
  const existing = v2Sessions.get(conversationId)
  if (existing && isSessionTransportReady(existing.session)) {
    // 复用现有 Session
    return existing.session
  }

  // 2. 创建新 Session
  const session = await unstable_v2_createSession({
    model: credentials.sdkModel,
    cwd: workDir,
    env: buildSdkEnv(credentials),
    mcpServers,
    systemPrompt,
    resume: sessionId,  // 恢复历史会话
    // ...
  })

  // 3. 注册进程退出监听 (事件驱动清理)
  registerProcessExitListener(session, conversationId)

  // 4. 缓存 Session
  v2Sessions.set(conversationId, { session, spaceId, conversationId, ... })

  return session
}
```

**Session 健康检查:**
```typescript
function isSessionTransportReady(session: V2SDKSession): boolean {
  const transport = session.query?.transport
  if (typeof transport.isReady === 'function') {
    return transport.isReady()
  }
  return transport.ready ?? false
}
```

**进程退出监听:**
```typescript
function registerProcessExitListener(session, conversationId) {
  const transport = session.query?.transport
  transport.onExit((error) => {
    cleanupSession(conversationId, `process exited: ${error?.message}`)
  })
}
```

---

### 3.4 SDK 配置构建 (sdk-config.ts)

**环境变量构建:**
```typescript
export function buildSdkEnv(params) {
  return {
    ...getCleanUserEnv(),  // 继承用户环境，但移除 AI SDK 变量

    // Electron 作为 Node 运行
    ELECTRON_RUN_AS_NODE: 1,
    ELECTRON_NO_ATTACH_CONSOLE: 1,

    // API 凭证
    ANTHROPIC_API_KEY: params.anthropicApiKey,
    ANTHROPIC_BASE_URL: params.anthropicBaseUrl,

    // Halo 专用配置目录 (隔离用户自己的 ~/.claude)
    CLAUDE_CONFIG_DIR: path.join(app.getPath('userData'), 'claude-config'),

    // Localhost 绕过代理
    NO_PROXY: 'localhost,127.0.0.1',

    // 性能优化
    CLAUDE_CODE_REMOTE: 'true',
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_COST_WARNINGS: '1',
  }
}
```

**SDK Options 构建:**
```typescript
export function buildBaseSdkOptions(params) {
  return {
    model: credentials.sdkModel,
    cwd: workDir,
    abortController,
    env: buildSdkEnv(credentials),
    mcpServers,                    // MCP 服务器配置
    systemPrompt: buildSystemPrompt(),
    maxTurns: 50,
    permissionMode: 'bypassPermissions',
    includePartialMessages: true,  // 启用 token 级流式
    executable: electronPath,      // Headless Electron
    executableArgs: ['--no-warnings'],
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    canUseTool: createCanUseTool({ sendToRenderer, spaceId, conversationId }),
  }
}
```

---

### 3.5 流式处理 (stream-processor.ts)

**核心循环:**
```typescript
export async function processStream(params) {
  // 1. 发送消息到 Session
  v2Session.send(messageContent)

  // 2. 流式接收响应
  for await (const sdkMessage of v2Session.stream()) {

    // 处理 stream_event (token 级流式)
    if (sdkMessage.type === 'stream_event') {
      const event = sdkMessage.event

      // 文本块开始
      if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
        sendToRenderer('agent:message', { isNewTextBlock: true })
      }

      // 文本增量
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        sendToRenderer('agent:message', { delta: event.delta.text, isStreaming: true })
      }

      // Thinking 块开始
      if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
        sendToRenderer('agent:thought', { thought: { type: 'thinking', isStreaming: true } })
      }

      // Thinking 增量
      if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
        sendToRenderer('agent:thought-delta', { thoughtId, delta: event.delta.thinking })
      }

      // Tool Use 块开始
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        sendToRenderer('agent:thought', { thought: { type: 'tool_use', toolName } })
        sendToRenderer('agent:tool-call', { id, name, status: 'running' })
      }

      // Tool Use 输入 JSON 增量
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        sendToRenderer('agent:thought-delta', { thoughtId, delta: event.delta.partial_json, isToolInput: true })
      }

      // 块结束
      if (event.type === 'content_block_stop') {
        // 标记完成，发送最终状态
        sendToRenderer('agent:thought-delta', { thoughtId, isComplete: true })
      }
    }

    // 处理完整 SDK 消息
    if (sdkMessage.type === 'assistant') {
      // 提取 token 使用量
    }

    if (sdkMessage.type === 'result') {
      sendToRenderer('agent:message', { content: finalContent, isComplete: true })
      sendToRenderer('agent:complete', { tokenUsage })
    }
  }
}
```

---

### 3.6 前端事件处理 (chat.store.ts)

**事件监听注册 (App.tsx):**
```typescript
// App.tsx 中注册 IPC 事件监听
window.halo.onAgentMessage((data) => chatStore.handleAgentMessage(data))
window.halo.onAgentThought((data) => chatStore.handleAgentThought(data))
window.halo.onAgentToolCall((data) => chatStore.handleAgentToolCall(data))
window.halo.onAgentToolResult((data) => chatStore.handleAgentToolResult(data))
window.halo.onAgentComplete((data) => chatStore.handleAgentComplete(data))
window.halo.onAgentError((data) => chatStore.handleAgentError(data))
```

**ChatStore 事件处理:**
```typescript
handleAgentMessage: (data) => {
  const session = getSession(data.conversationId)

  // 新文本块开始
  if (data.isNewTextBlock) {
    session.textBlockVersion++
    session.streamingContent = ''
  }

  // 流式增量
  if (data.isStreaming && data.delta) {
    session.streamingContent += data.delta
  }

  // 完成
  if (data.isComplete) {
    session.isGenerating = false
    session.isStreaming = false
    updateMessage(data.conversationId, data.content)
  }
},

handleAgentThought: (data) => {
  const session = getSession(data.conversationId)
  session.thoughts.push(data.thought)
},

handleAgentThoughtDelta: (data) => {
  const thought = session.thoughts.find(t => t.id === data.thoughtId)
  if (thought) {
    if (data.delta) thought.content += data.delta
    if (data.toolInput) thought.toolInput = data.toolInput
    if (data.isComplete) thought.isStreaming = false
    if (data.isReady) thought.isReady = true
    if (data.toolResult) thought.toolResult = data.toolResult
  }
},

handleAgentToolCall: (data) => {
  // 更新工具调用状态
  updateToolCall(data.conversationId, data)
},

handleAgentComplete: (data) => {
  session.isGenerating = false
  session.isStreaming = false
},

handleAgentError: (data) => {
  session.error = data.error
  session.errorType = data.errorType
  session.isGenerating = false
}
```

---

## 四、关键设计模式

| 模式 | 实现 | 优势 |
|------|------|------|
| **V2 Session 复用** | `v2Sessions` Map 缓存 | 避免每次冷启动 3-5s |
| **事件驱动清理** | `transport.onExit()` 监听 | 即时释放资源，无 FD 泄漏 |
| **Token 级流式** | `stream_event` + `includePartialMessages` | 实时响应，用户体验好 |
| **多提供商路由** | `OpenAI Compat Router` | 统一接口支持 Anthropic/OpenAI/OAuth |
| **凭证编码** | `encodeBackendConfig()` | 模型选择绑定到 Session |
| **LRU 缓存** | `conversationCache` | 限制内存，快速访问最近会话 |
| **Session 迁移** | `migrateSessionIfNeeded()` | 兼容旧配置目录 |

---

## 五、完整时序图

```
┌────────┐     ┌──────────┐     ┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│ User   │     │ Renderer │     │ Main Process│     │ Session Mgr  │     │ Claude SDK  │
└───┬────┘     └────┬─────┘     └──────┬──────┘     └──────┬───────┘     └──────┬──────┘
    │               │                   │                   │                    │
    │  Type message │                   │                   │                    │
    │──────────────►│                   │                   │                    │
    │               │                   │                   │                    │
    │               │ agent:send-message│                   │                    │
    │               │──────────────────►│                   │                    │
    │               │                   │                   │                    │
    │               │                   │ getOrCreateV2Session                   │
    │               │                   │──────────────────►│                    │
    │               │                   │                   │                    │
    │               │                   │                   │ unstable_v2_create │
    │               │                   │                   │───────────────────►│
    │               │                   │                   │                    │
    │               │                   │                   │◄───────────────────│
    │               │                   │                   │    V2Session       │
    │               │                   │                   │                    │
    │               │                   │◄──────────────────│                    │
    │               │                   │                   │                    │
    │               │                   │ processStream()   │                    │
    │               │                   │────────────────────────────────────────►│
    │               │                   │                   │                    │
    │               │                   │  stream_event (text_delta)             │
    │               │                   │◄────────────────────────────────────────│
    │               │                   │                   │                    │
    │               │ agent:message     │                   │                    │
    │               │  { delta }        │                   │                    │
    │               │◄──────────────────│                   │                    │
    │               │                   │                   │                    │
    │  See typing...│                   │                   │                    │
    │◄──────────────│                   │                   │                    │
    │               │                   │                   │                    │
    │               │                   │  stream_event (thinking)               │
    │               │                   │◄────────────────────────────────────────│
    │               │                   │                   │                    │
    │               │ agent:thought     │                   │                    │
    │               │◄──────────────────│                   │                    │
    │               │                   │                   │                    │
    │  See thinking │                   │                   │                    │
    │◄──────────────│                   │                   │                    │
    │               │                   │                   │                    │
    │               │                   │  stream_event (tool_use)               │
    │               │                   │◄────────────────────────────────────────│
    │               │                   │                   │                    │
    │               │ agent:tool-call   │                   │                    │
    │               │◄──────────────────│                   │                    │
    │               │                   │                   │                    │
    │  See tool     │                   │                   │                    │
    │◄──────────────│                   │                   │                    │
    │               │                   │                   │                    │
    │               │                   │  tool_result      │                    │
    │               │                   │◄────────────────────────────────────────│
    │               │                   │                   │                    │
    │               │ agent:tool-result │                   │                    │
    │               │◄──────────────────│                   │                    │
    │               │                   │                   │                    │
    │               │                   │  result message   │                    │
    │               │                   │◄────────────────────────────────────────│
    │               │                   │                   │                    │
    │               │ agent:complete    │                   │                    │
    │               │◄──────────────────│                   │                    │
    │               │                   │                   │                    │
    │  Done         │                   │                   │                    │
    │◄──────────────│                   │                   │                    │
    │               │                   │                   │                    │
```

---

## 六、IPC 事件清单

| 事件名 | 方向 | 数据结构 | 说明 |
|--------|------|----------|------|
| `agent:send-message` | Renderer → Main | `{ spaceId, conversationId, message, images, ... }` | 发送消息 |
| `agent:stop` | Renderer → Main | `{ conversationId }` | 停止生成 |
| `agent:message` | Main → Renderer | `{ delta?, content?, isStreaming, isComplete, isNewTextBlock? }` | 文本流 |
| `agent:thought` | Main → Renderer | `{ thought: Thought }` | 思考块开始 |
| `agent:thought-delta` | Main → Renderer | `{ thoughtId, delta?, content?, toolInput?, isComplete?, isReady?, toolResult? }` | 思考增量 |
| `agent:tool-call` | Main → Renderer | `{ id, name, status, input }` | 工具调用 |
| `agent:tool-result` | Main → Renderer | `{ toolId, result, isError }` | 工具结果 |
| `agent:error` | Main → Renderer | `{ error, errorType? }` | 错误 |
| `agent:complete` | Main → Renderer | `{ tokenUsage? }` | 完成 |
| `agent:compact` | Main → Renderer | `{ trigger, preTokens }` | 上下文压缩通知 |

---

## 七、Session 生命周期

```
┌─────────────────────────────────────────────────────────────────┐
│                    V2 Session 生命周期                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. 创建 (getOrCreateV2Session)                                 │
│     │                                                          │
│     ├─ 检查缓存是否存在                                         │
│     ├─ 检查进程是否存活 (isSessionTransportReady)               │
│     ├─ 检查配置是否变更 (needsSessionRebuild)                   │
│     └─ 创建新 Session (unstable_v2_createSession)              │
│                                                                 │
│  2. 使用 (processStream)                                        │
│     │                                                          │
│     ├─ 发送消息                       │
│     └─ 流式接收响应                        │
│                                                                 │
│  3. 复用 (后续消息)                                             │
│     │                                                          │
│     └─ 直接从缓存获取，无需重新创建                              │
│                                                                 │
│  4. 清理 (cleanupSession)                                       │
│     │                                                          │
│     ├─ 进程退出监听触发                 │
│     ├─ 空闲超时 (30 min)                                        │
│     ├─ 配置变更                           │
│     └─ 显式关闭                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 八、多提供商支持

Halo 通过 `OpenAI Compat Router` 支持多种 LLM 提供商：

```
┌─────────────────────────────────────────────────────────────────┐
│                    凭证解析流程                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  getApiCredentials(config)                                      │
│     │                                                          │
│     ├─ Anthropic provider                                       │
│     │     └─ 直接使用 API Key                                   │
│     │                                                          │
│     ├─ OpenAI provider                                          │
│     │     └─ 编码到 ANTHROPIC_API_KEY                          │
│     │                                                          │
│     └─ OAuth provider (Google/GitHub)                          │
│           └─ 编码到 ANTHROPIC_API_KEY                          │
│                                                                 │
│  resolveCredentialsForSdk(credentials)                         │
│     │                                                          │
│     ├─ PROXY_ANTHROPIC=true                                    │
│     │     └─ Anthropic 也走本地路由器                           │
│     │                                                          │
│     └─ 非 Anthropic 提供商                                      │
│           └─ encodeBackendConfig({ url, key, model, apiType }) │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 九、性能优化点

1. **V2 Session 复用**: 避免每次消息都启动新进程 (节省 3-5s)
2. **Token 级流式**: 用户实时看到响应，无需等待完整回复
3. **LRU 缓存**: 限制会话缓存数量，控制内存使用
4. **事件驱动清理**: 进程退出立即释放资源，无 FD 泄漏
5. **Headless Electron**: 无 Dock 图标，无 UI 开销
6. **禁用非必要功能**: 禁用遥测、文件检查点等

---

## 十、相关文件索引

```
src/
├── main/
│   ├── ipc/
│   │   └── agent.ts                    # IPC 处理器
│   ├── services/
│   │   ├── agent/
│   │   │   ├── index.ts                # 模块导出
│   │   │   ├── send-message.ts         # 消息发送入口
│   │   │   ├── session-manager.ts      # Session 生命周期
│   │   │   ├── sdk-config.ts           # SDK 配置构建
│   │   │   ├── stream-processor.ts     # 流式处理
│   │   │   ├── helpers.ts              # 工具函数
│   │   │   ├── message-utils.ts        # 消息解析
│   │   │   ├── system-prompt.ts        # 系统提示词
│   │   │   └── permission-handler.ts   # 权限处理
│   │   ├── config.service.ts           # 配置管理
│   │   └── conversation.service.ts     # 会话存储
│   └── openai-compat-router/           # 多提供商路由
│       └── index.ts
├── renderer/
│   ├── api/
│   │   ├── index.ts                    # API 封装
│   │   └── transport.ts                # 通信层
│   └── stores/
│       └── chat.store.ts               # 聊天状态管理
└── preload/
    └── index.ts                        # Preload 脚本 (IPC 桥接)
```

---

*文档生成时间: 2026-03-01*
