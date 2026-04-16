# Anthropic SDK 三件套关系解析

本文档解释 `@anthropic-ai/sdk`、`@anthropic-ai/claude-agent-sdk` 和 `claude-code-cli` 之间的关系，以及在 AICO-Bot 框架中的使用方式。

---

## 一、三层架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              应用层 (AICO-Bot)                                   │
│                                                                             │
│   调用 unstable_v2_createSession() 创建 Agent 会话                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     @anthropic-ai/claude-agent-sdk                          │
│                            (Agent SDK)                                      │
│                                                                             │
│   • 提供高级 API: query(), unstable_v2_createSession()                     │
│   • 管理 Session 生命周期                                                   │
│   • 处理工具调用、MCP 服务器                                                 │
│   • 内置 cli.js 作为 Claude Code CLI                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
                    ▼                               ▼
┌─────────────────────────────────┐   ┌─────────────────────────────────────┐
│      @anthropic-ai/sdk          │   │        claude-code-cli              │
│       (API SDK)                 │   │     (内置在 Agent SDK 中)            │
│                                 │   │                                     │
│  • 直接调用 Anthropic REST API  │   │  • 实际的 Agent 执行引擎             │
│  • 处理 HTTP 请求/响应          │   │  • 文件编辑、命令执行、代码理解       │
│  • 流式响应解析                 │   │  • 通过 SDK API 调用底层模型         │
│  • 类型定义                     │   │                                     │
└─────────────────────────────────┘   └─────────────────────────────────────┘
                    │                               │
                    └───────────────┬───────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Anthropic API                                     │
│                      (api.anthropic.com 或兼容端点)                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、各包详解

### 2.1 @anthropic-ai/sdk (API SDK)

**定位**: 官方 TypeScript API 客户端库

**职责**:
- 直接调用 Anthropic REST API
- 处理 HTTP 请求、认证、重试
- 流式响应解析
- 提供 TypeScript 类型定义

**安装**:
```bash
npm install @anthropic-ai/sdk
```

**直接使用示例**:
```typescript
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: 'sk-...' })

// 直接调用 API
const message = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }]
})

// 流式调用
const stream = await client.messages.stream({
  model: 'claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'Hello' }]
})
for await (const event of stream) {
  console.log(event)
}
```

**AICO-Bot 中的使用**:
- 在 `execute.ts` 中直接调用用于轻量级 API 请求
- 作为 `@anthropic-ai/claude-agent-sdk` 的依赖

---

### 2.2 @anthropic-ai/claude-agent-sdk (Agent SDK)

**定位**: 构建 AI Agent 的高级 SDK

**职责**:
- 提供高级 Agent API (Session 管理、工具调用、MCP)
- **内置 Claude Code CLI** (cli.js)
- 管理 Agent 生命周期
- 处理多轮对话、会话恢复

**安装**:
```bash
npm install @anthropic-ai/claude-agent-sdk
```

**核心 API**:

```typescript
import {
  unstable_v2_createSession,  // 创建持久化 Session
  query,                       // 单次查询
  tool,                        // 定义工具
  createSdkMcpServer          // 创建 MCP 服务器
} from '@anthropic-ai/claude-agent-sdk'
```

**V2 Session 创建**:
```typescript
const session = await unstable_v2_createSession({
  model: 'claude-sonnet-4-20250514',
  cwd: '/path/to/project',

  // 使用内置 CLI 或自定义路径
  executable: 'node',           // 或 'bun', 'deno'
  executableArgs: ['--no-warnings'],

  // 环境变量
  env: {
    ANTHROPIC_API_KEY: 'sk-...',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
  },

  // MCP 服务器
  mcpServers: {
    'my-server': { command: 'node', args: ['mcp-server.js'] }
  },

  // 权限模式
  permissionMode: 'bypassPermissions',

  // 恢复会话
  resume: 'previous-session-id'
})

// 发送消息
session.send('Hello, Claude!')

// 流式接收响应
for await (const message of session.stream()) {
  if (message.type === 'assistant') {
    console.log(message.content)
  }
}
```

**AICO-Bot 中的使用位置**:
| 文件 | 用途 |
|------|------|
| `session-manager.ts` | 创建/管理 V2 Session |
| `send-message.ts` | 通过 Session 发送消息 |
| `conversation-mcp/index.ts` | 创建 AICO-Bot Apps MCP 服务器 |
| `ai-browser/sdk-mcp-server.ts` | 创建 AI Browser MCP 服务器 |
| `apps/runtime/execute.ts` | 自动化任务执行 |
| `api-validator.service.ts` | API 凭证验证 |

---

### 2.3 claude-code-cli (CLI)

**定位**: Agent 执行引擎

**职责**:
- 实际执行 Agent 逻辑
- 文件读写、命令执行、代码理解
- 工具调用处理
- 与 Anthropic API 通信

**存在形式**:
- **内置在 Agent SDK 中** (`cli.js`)
- 也可以单独安装使用

**关键点**: Agent SDK 的 `cli.js` 就是 Claude Code CLI！

```typescript
// Agent SDK 类型定义中的证据
interface SDKSessionOptions {
  /** Path to Claude Code executable */
  pathToClaudeCodeExecutable?: string;

  /** Executable to use (node, bun) */
  executable?: 'bun' | 'deno' | 'node';
}
```

**AICO-Bot 的使用方式**:
```typescript
// sdk-config.ts
const sdkOptions = {
  executable: electronPath,  // Headless Electron 作为 Node 运行时
  executableArgs: ['--no-warnings'],
  // ...
}
```

---

## 三、调用链路

```
┌────────────────────────────────────────────────────────────────────────────┐
│                           AICO-Bot 调用链路                                     │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  1. 用户发送消息                                                            │
│     │                                                                      │
│     ▼                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  ChatStore.sendMessage()                                            │  │
│  │  → api.agentSendMessage()                                           │  │
│  │  → IPC: 'agent:send-message'                                        │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│     │                                                                      │
│     ▼                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  Main Process: sendMessage()                                        │  │
│  │  → getOrCreateV2Session() [session-manager.ts]                      │  │
│  │  → unstable_v2_createSession(sdkOptions) [Agent SDK]                │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│     │                                                                      │
│     ▼                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  Agent SDK: unstable_v2_createSession()                             │  │
│  │  → spawn(executable, [cli.js, ...], env)                            │  │
│  │  → 启动 Claude Code CLI 子进程                                       │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│     │                                                                      │
│     ▼                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  Claude Code CLI (cli.js)                                           │  │
│  │  → 读取 ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL                       │  │
│  │  → 加载 MCP 服务器                                                   │  │
│  │  → 调用 Anthropic API (@anthropic-ai/sdk)                           │  │
│  │  → 处理工具调用                                                      │  │
│  │  → 流式返回响应                                                      │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│     │                                                                      │
│     ▼                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  Anthropic API (或兼容端点)                                          │  │
│  │  → 生成响应                                                          │  │
│  │  → 流式返回                                                          │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│     │                                                                      │
│     ▼                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  流式响应处理 [stream-processor.ts]                                  │  │
│  │  → 解析 stream_event                                                │  │
│  │  → sendToRenderer('agent:message', ...)                             │  │
│  │  → sendToRenderer('agent:thought', ...)                             │  │
│  │  → sendToRenderer('agent:tool-call', ...)                           │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│     │                                                                      │
│     ▼                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  Renderer: 实时显示                                                  │  │
│  │  → 文本流                                                            │  │
│  │  → 思考过程                                                          │  │
│  │  → 工具调用                                                          │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 四、AICO-Bot 中的具体使用

### 4.1 创建 Session

```typescript
// session-manager.ts
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk'

const session = await unstable_v2_createSession({
  model: credentials.sdkModel,
  cwd: workDir,
  env: buildSdkEnv(credentials),  // 设置 ANTHROPIC_API_KEY 等
  mcpServers,                     // MCP 服务器配置
  systemPrompt: buildSystemPrompt(),
  permissionMode: 'bypassPermissions',
  executable: electronPath,       // 使用 Headless Electron
  executableArgs: ['--no-warnings'],
  resume: sessionId,              // 恢复历史会话
})
```

### 4.2 创建 MCP 服务器

```typescript
// conversation-mcp/index.ts
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'

const notifyTool = tool({
  name: 'notify',
  inputSchema: z.object({ message: z.string() }),
  handler: async ({ message }) => {
    // 发送通知
  }
})

export function createAICO-BotAppsMcpServer(spaceId: string) {
  return createSdkMcpServer({
    name: 'aico-bot-apps',
    tools: [notifyTool, openUrlTool, askQuestionTool]
  })
}
```

### 4.3 直接 API 调用

```typescript
// apps/runtime/execute.ts
// 轻量级场景直接用 API SDK
const { default: Anthropic } = await import('@anthropic-ai/sdk')

const client = new Anthropic({
  apiKey: credentials.apiKey,
  baseURL: credentials.baseUrl
})

const response = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Quick question' }]
})
```

---

## 五、关键配置项

### 5.1 Agent SDK Session Options

| 选项 | 类型 | 说明 |
|------|------|------|
| `model` | string | 模型名称 |
| `cwd` | string | 工作目录 |
| `env` | object | 环境变量 (含 API Key) |
| `executable` | string | Node 运行时 |
| `executableArgs` | string[] | 运行时参数 |
| `mcpServers` | object | MCP 服务器配置 |
| `systemPrompt` | string/object | 系统提示词 |
| `permissionMode` | string | 权限模式 |
| `resume` | string | 恢复的 Session ID |
| `maxTurns` | number | 最大工具调用轮数 |
| `allowedTools` | string[] | 允许的工具列表 |

### 5.2 环境变量

```typescript
// AICO-Bot 设置的环境变量
{
  // API 凭证
  ANTHROPIC_API_KEY: 'sk-...',           // 或编码的后端配置
  ANTHROPIC_BASE_URL: 'https://...',     // API 端点

  // 配置目录
  CLAUDE_CONFIG_DIR: '~/Library/Application Support/aico-bot/claude-config',

  // 性能优化
  CLAUDE_CODE_REMOTE: 'true',
  CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
  DISABLE_TELEMETRY: '1',

  // Electron 作为 Node
  ELECTRON_RUN_AS_NODE: '1',
}
```

---

## 六、版本信息

| 包 | AICO-Bot 使用版本 | 说明 |
|---|---|---|
| `@anthropic-ai/sdk` | `latest` (0.73.0) | API 客户端 |
| `@anthropic-ai/claude-agent-sdk` | `0.1.76` | Agent SDK |
| `claude-code-cli` | 内置于 Agent SDK | CLI 引擎 |

---

## 七、总结

| 包 | 层级 | 职责 | AICO-Bot 使用场景 |
|---|---|---|---|
| `@anthropic-ai/sdk` | 底层 | HTTP API 调用 | 轻量级请求、API 验证 |
| `@anthropic-ai/claude-agent-sdk` | 中层 | Agent 编排、Session 管理 | 主要 Agent 逻辑 |
| `claude-code-cli` | 核心 | Agent 执行引擎 | 由 Agent SDK 内部调用 |

**关键理解**:
1. Agent SDK **内置** CLI，不需要单独安装
2. Agent SDK 通过 `@anthropic-ai/sdk` 调用 API
3. AICO-Bot 通过 Agent SDK 创建 Session，由 CLI 执行实际任务

---

*文档生成时间: 2026-03-01*
