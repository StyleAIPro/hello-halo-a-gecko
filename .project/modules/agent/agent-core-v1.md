# 模块 — Agent 核心 agent-core-v1

> 版本：agent-core-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源架构：无（初始版本）

## 职责

管理 AI Agent 的完整生命周期，包括 Claude Code SDK 会话管理、消息发送与流式处理、工具调用编排、权限处理和 MCP 服务器集成。是 AICO-Bot 的核心业务模块，连接前端 UI 与底层 Claude Code SDK。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent Module                              │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐     │
│  │    index.ts   │  │   types.ts   │  │    helpers.ts      │     │
│  │  (Public API) │  │  (类型定义)   │  │  (工具函数)        │     │
│  └──────────────┘  └──────────────┘  └────────────────────┘     │
│                                                                  │
│  ┌──────────────────┐  ┌─────────────────────────────────┐      │
│  │ session-manager   │  │        stream-processor          │      │
│  │ (V2 会话生命周期)  │  │  (流式处理核心，共享于主对话+App)  │      │
│  └──────────────────┘  └─────────────────────────────────┘      │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐       │
│  │ send-message  │  │  orchestrator │  │   sdk-config     │       │
│  │ (消息发送入口) │  │ (Hyper Space) │  │ (SDK 配置构建)   │       │
│  └──────────────┘  └──────────────┘  └──────────────────┘       │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐       │
│  │ system-prompt │  │ mcp-manager  │  │  control.ts      │       │
│  │ (系统提示词)   │  │ (MCP 状态)   │  │ (停止/状态控制)   │       │
│  └──────────────┘  └──────────────┘  └──────────────────┘       │
│                                                                  │
│  ┌────────────────────┐  ┌──────────────────────────────┐       │
│  │ permission-handler  │  │ message-utils / mailbox /     │       │
│  │ (工具权限处理)       │  │ taskboard / hyper-space-mcp  │       │
│  └────────────────────┘  └──────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘

外部依赖:
  → @anthropic-ai/claude-agent-sdk (V2 Session API)
  → conversation.service (对话持久化)
  → space.service (工作目录/空间配置)
  → config.service (API 凭证/模型配置)
  → remote-ws / remote-ssh (远程空间执行)
```

## 对外接口

### IPC Handle 通道（渲染进程 → 主进程）

| 方法 | 通道名 | 输入 | 输出 | 说明 |
|------|--------|------|------|------|
| sendMessage | `agent:send-message` | `{ spaceId, conversationId, message, resumeSessionId?, images?, thinkingEnabled?, aiBrowserEnabled?, agentId? }` | `{ success, error? }` | 发送消息给 AI Agent |
| stopGeneration | `agent:stop` | `conversationId?` | `{ success, error? }` | 停止当前生成（指定会话或全部） |
| injectMessage | `agent:inject-message` | `{ conversationId, content, images?, thinkingEnabled?, aiBrowserEnabled? }` | `{ success, error? }` | 在 turn boundary 注入消息 |
| approveTool | `agent:approve-tool` | `conversationId` | `{ success }` | 批准工具执行（当前为 no-op，全部自动允许） |
| rejectTool | `agent:reject-tool` | `conversationId` | `{ success }` | 拒绝工具执行（当前为 no-op） |
| getSessionState | `agent:get-session-state` | `conversationId` | `{ success, data? }` | 获取会话运行时状态 |
| ensureSessionWarm | `agent:ensure-session-warm` | `spaceId, conversationId` | `{ success }` | 预热 V2 会话（用户切换对话时调用） |
| testMcpConnections | `agent:test-mcp` | 无 | `{ success, data? }` | 测试 MCP 服务器连接 |
| answerQuestion | `agent:answer-question` | `{ conversationId, questionId, answer }` | `{ success }` | 回答 Agent 提出的问题 |
| compactContext | `agent:compact-context` | `conversationId` | `{ success, error? }` | 手动触发上下文压缩 |

### Renderer Event 通道（主进程 → 渲染进程）

| 通道名 | 数据 | 说明 |
|--------|------|------|
| `agent:message` | `{ content, delta, isComplete, isStreaming, isNewTextBlock? }` | 流式文本消息（增量或完整） |
| `agent:thought` | `{ thought: Thought }` | 新思考过程条目（thinking/text/tool_use/error） |
| `agent:thought-delta` | `{ thoughtId, delta?, content?, isComplete?, isReady?, isToolInput?, isToolResult?, toolResult? }` | 思考过程增量更新 |
| `agent:tool-call` | `ToolCall` | 工具调用事件（name, status, input） |
| `agent:tool-result` | `{ toolId, result, isError }` | 工具执行结果 |
| `agent:complete` | `{ type, duration?, tokenUsage? }` | 生成完成通知 |
| `agent:error` | `{ type, error, errorType?, errorCode? }` | 错误通知 |
| `agent:compact` | `{ type, trigger, preTokens }` | 上下文压缩通知 |
| `agent:ask-question` | `{ id, questions }` | Agent 向用户提问 |
| `agent:terminal` | `TerminalOutputData` | 终端输出流 |
| `agent:turn-boundary` | `{ toolName?, toolId, timestamp }` | Turn boundary 通知（用于消息注入） |
| `agent:injection-start` | `{ content }` | 注入消息开始执行 |
| `agent:auth-retry` | `{ attempt, maxRetries }` | Auth 重试通知 |
| `agent:mcp-status` | `McpServerStatusInfo[]` | MCP 服务器状态广播 |
| `agent:team-message` | 消息数据 | Hyper Space 团队消息 |
| `worker:started` | `{ agentId, agentName, taskId, task, type, interactionMode? }` | 子 Agent（Worker）启动 |
| `worker:completed` | `{ agentId, agentName, taskId, result?, error?, status }` | 子 Agent（Worker）完成 |

## 内部组件

| 组件 | 职责 | 文件 |
|------|------|------|
| types | 类型定义（AgentRequest, SessionState, Thought, ToolCall, TokenUsage 等） | `services/agent/types.ts` |
| session-manager | V2 Session 生命周期管理（创建/复用/清理/健康检查/迁移/压缩） | `services/agent/session-manager.ts` |
| send-message | 消息发送入口（本地/远程/Hyper Space 路由、凭证解析、会话预热、流循环） | `services/agent/send-message.ts` |
| stream-processor | 流式处理核心（token 级流式、thought 累积、工具结果合并、子 Agent 事件、注入队列） | `services/agent/stream-processor.ts` |
| orchestrator | Hyper Space 多 Agent 编排（团队管理、任务路由、结果聚合、邮箱、看板） | `services/agent/orchestrator.ts` |
| sdk-config | SDK 配置构建（凭证解析/路由、OpenAI 兼容层、基础选项构建） | `services/agent/sdk-config.ts` |
| system-prompt | 系统提示词构建（AICO-Bot 自定义指令、AI Browser 扩展） | `services/agent/system-prompt.ts` |
| mcp-manager | MCP 服务器状态管理（缓存、广播、连接测试） | `services/agent/mcp-manager.ts` |
| permission-handler | 工具权限处理（当前为 bypass 模式） | `services/agent/permission-handler.ts` |
| control | 生成控制（停止、状态查询、活跃会话管理） | `services/agent/control.ts` |
| helpers | 工具函数（工作目录获取、凭证获取、渲染器通信） | `services/agent/helpers.ts` |
| message-utils | 消息构建与解析（SDK 消息转 Thought、Canvas 上下文格式化） | `services/agent/message-utils.ts` |
| hyper-space-mcp | Hyper Space MCP 服务器（子 Agent 工具暴露） | `services/agent/hyper-space-mcp.ts` |
| mailbox | Agent 间邮箱服务（异步消息传递） | `services/agent/mailbox.ts` |
| taskboard | Agent 间任务看板服务 | `services/agent/taskboard.ts` |
| persistent-worker | 持久化 Worker 管理 | `services/agent/persistent-worker.ts` |
| permission-forwarder | 权限转发（远程空间） | `services/agent/permission-forwarder.ts` |

## 功能列表

| 功能 | 状态 | 文档 |
|------|------|------|
| message-send | 已完成 | features/message-send/design.md |
| permission-handling | 已完成 | features/permission-handling/design.md |
| sdk-patch | 已完成 | features/sdk-patch/design.md |
| sdk-session | 已完成 | features/sdk-session/design.md |
| stream-processing | 已完成 | features/stream-processing/design.md |
| tool-orchestration | 已完成 | features/tool-orchestration/design.md |
| worker-management | 已完成 | features/worker-management/design.md |

## 绑定的 API

- 无（通过 IPC 通道暴露接口，不通过 HTTP API）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-17 | BUG-003：Windows 删除空间 EBUSY — `closeSessionsBySpaceId()` 改为 async，新增 `waitForSessionExit()` 等待 SDK 子进程退出 — `src/main/services/agent/session-manager.ts` | @zhaoyinqi |
| 2026-04-17 | BUG-002：修复 SDK turn injection patch 守卫条件导致第二次消息卡死 — `src/main/services/agent/sdk-turn-injection-patch.ts` | @zhaoyinqi |
| 2026-04-16 | 初始模块文档 | @moonseeker1 |
