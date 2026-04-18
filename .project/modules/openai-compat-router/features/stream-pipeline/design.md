# 功能 -- 流式响应管线

> 日期：2026-04-17
> 指令人：@StyleAIPro
> 来源 PRD：无（从现有代码逆向生成）
> 所属模块：modules/openai-compat-router

## 描述

流式响应管线子系统，负责将 OpenAI 兼容提供商的 SSE 流式响应实时转换为 Anthropic Messages API 的 SSE 事件格式。使 Claude Code SDK 能够像接收 Anthropic 原生流一样处理来自 OpenAI、Groq、DeepSeek 等提供商的流式响应。

支持两种 OpenAI 流式协议的转换：Chat Completions streaming 和 Responses API streaming，并统一输出为 Anthropic SSE 事件（message_start、content_block_start、content_block_delta、content_block_stop、message_delta、message_stop）。

## 依赖

- `converters/response/openai-chat-to-anthropic.ts` -- 非流式响应转换（流结束时的最终响应）
- `converters/content-blocks.ts` -- 内容块格式转换
- `utils/id.ts` -- 消息 ID 和内容块 ID 生成
- `types/index.ts` -- StreamState 等共享类型

## 实现逻辑

### 正常流程

1. **SSE 流接收**：从后端 LLM 提供商接收 SSE 事件流
2. **流处理器选择**：
   - Chat Completions 流 → `openai-chat-stream.ts`
   - Responses API 流 → `openai-responses-stream.ts`
3. **基类状态管理**（`base-stream-handler.ts`）：
   a. 初始化 StreamState（消息 ID、内容块 ID、当前块类型等）
   b. 跟踪内容块生命周期（start → delta → stop）
   c. 管理累积的文本内容和工具调用输入
4. **Chat Completions 流转换**：
   a. 接收 `data: {"choices":[{"delta":{"content":"..."}}]}`
   b. 首个 chunk → 发送 `message_start` + `content_block_start`（text 类型）
   c. 后续 chunk → 发送 `content_block_delta`（text_delta）
   d. 工具调用 chunk → 发送 `content_block_start`（tool_use）+ `input_json_delta`
   e. 结束 chunk（finish_reason: stop）→ 发送 `content_block_stop` + `message_delta` + `message_stop`
5. **Responses API 流转换**：
   a. 接收 Responses API 事件（`response.output_item.added`、`response.content_part.delta` 等）
   b. 映射到对应的 Anthropic SSE 事件
   c. 处理 DeepSeek 等提供商的 `reasoning_content`（思考过程）→ 映射为 Anthropic thinking 块
6. **SSE 写入**（`sse-writer.ts`）：将转换后的事件格式化为标准 SSE 格式写入响应流

### 异常流程

1. **流中断**：后端连接意外断开，发送 `message_stop` 并清理状态
2. **解析错误**：SSE 事件格式异常，跳过无效事件或返回错误
3. **超时**：流式响应长时间无数据，终止流并返回超时错误
4. **提供商错误**：接收错误类型的 SSE 事件（如 429），转发为 Anthropic 错误格式

## 涉及 API

- `handleOpenAIChatStream(response, res, streamState)` -- 处理 OpenAI Chat Completions 流
- `handleOpenAIResponsesStream(response, res, streamState)` -- 处理 OpenAI Responses API 流
- `writeSSEEvent(res, event, data)` -- 写入 SSE 事件
- `initStreamState(request)` -- 初始化流状态

## 涉及数据

- `StreamState` -- 流处理状态（消息 ID、内容块列表、当前块索引、token 用量等）
- `ContentBlockState` -- 单个内容块状态（类型、累积内容、是否已开始/完成）
- `SSEEvent` -- SSE 事件结构（event 类型 + data）

## 变更

-> changelog.md
