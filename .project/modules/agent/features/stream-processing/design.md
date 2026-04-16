# 功能 -- 流式响应处理

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（从现有代码逆向生成）
> 所属模块：modules/agent

## 描述

Agent 模块的流式处理核心引擎，被主对话 Agent（send-message.ts）和自动化 App 运行时（execute.ts）共同使用。处理 V2 SDK 会话消息流的所有事件类型，包括 token 级流式文本、thinking 块、tool_use 块及其增量更新，并实时向渲染进程发送事件更新。

## 依赖

- `session-manager.ts` -- 会话活动标记（`markSessionActivity`）
- `message-utils.ts` -- SDK 消息解析、单次用量提取、结果用量提取
- `mcp-manager.ts` -- MCP 状态广播
- `helpers.ts` -- `sendToRenderer` 向渲染进程发送事件
- `terminal/terminal-gateway.ts` -- 终端命令跟踪
- `space.service.ts` -- 获取工作目录用于终端提示

## 实现逻辑

### 正常流程

1. **消息发送**：将消息内容（字符串或多模态内容块）发送到 V2 会话
2. **流事件循环**：迭代 `v2Session.stream()` 处理每条 SDK 消息
3. **stream_event 处理**（token 级流式）：
   - `content_block_start`：创建 thinking/text/tool_use 块，发送 `agent:thought` 事件
   - `content_block_delta`：累积增量内容，发送 `agent:thought-delta` 和 `agent:message` 事件
   - `content_block_stop`：完成块，解析 tool_use 的 JSON 输入，发送 `agent:tool-call`，通知终端网关
4. **非流式消息处理**（assistant/user/system/result）：
   - 解析 SDK 消息为 Thought 对象
   - tool_result 合并到对应的 tool_use thought
   - 文本块累积为最终回复
   - 捕获 session ID 和 MCP 状态
5. **子代理事件路由**：通过 `parent_tool_use_id` 路由子代理事件到隔离状态
6. **Turn-level 注入**：在工具结果后检测待注入消息，支持连续多轮 Worker 报告
7. **流结束处理**：构建 StreamResult，包含最终内容、thoughts、token 用量、中断/错误状态

### 异常流程

1. **中断检测**：未收到 result 消息或 `error_during_execution` 标记
2. **maxTurns 达到**：SDK 报告 `error_max_turns`，显示可操作的提示
3. **认证重试**：SDK 报告 401 `api_retry`，通知调用方重建会话
4. **空响应**：最终内容为空且无错误 thought，发送空响应错误
5. **子代理清理**：流结束时清理未完成的子代理（发送 worker:completed 事件）
6. **上下文压缩通知**：处理 `compact_boundary` 系统消息，通知前端

## 涉及 API

- `processStream(params: ProcessStreamParams): Promise<StreamResult>` -- 流式处理核心函数
- `queueInjection()` / `getAndClearInjection()` / `hasPendingInjection()` -- turn-level 消息注入队列

## 涉及数据

- `ProcessStreamParams` -- 流处理参数（会话、消息内容、回调等）
- `StreamResult` -- 流处理结果（内容、thoughts、token 用量、状态标志）
- `StreamCallbacks` -- 调用方回调（`onComplete`、`onRawMessage`）
- `pendingInjectionQueues: Map<conversationId, PendingInjection[]>` -- 待注入消息队列

## 变更

-> changelog.md
