# 功能 -- 协议格式转换

> 日期：2026-04-17
> 指令人：@StyleAIPro
> 来源 PRD：无（从现有代码逆向生成）
> 所属模块：modules/openai-compat-router

## 描述

协议格式转换子系统，负责在 Anthropic Claude Messages API 和 OpenAI API（Chat Completions / Responses）之间进行双向格式转换。这是 OpenAI 兼容路由的核心能力，使得 Claude Code SDK 发出的 Anthropic 格式请求能够被 OpenAI 兼容的 LLM 提供商正确理解和处理。

转换覆盖请求和响应两个方向，支持内容块（text、image、thinking、tool_use、tool_result）、消息格式（角色映射）、工具/函数调用 Schema 的完整映射。

## 依赖

- `types/anthropic.ts` -- Anthropic Messages API 类型定义
- `types/openai-chat.ts` -- OpenAI Chat Completions API 类型定义
- `types/openai-responses.ts` -- OpenAI Responses API 类型定义
- `utils/id.ts` -- ID 生成（message ID、tool use ID）
- `utils/index.ts` -- safeJsonParse、deepClone 通用工具

## 实现逻辑

### 正常流程

1. **请求转换（Anthropic → OpenAI）**：
   a. 接收 Anthropic Messages API 请求体
   b. 根据 API 类型选择转换器：
      - Chat Completions：`anthropic-to-openai-chat.ts` 将 messages、tools、system prompt 转换为 OpenAI Chat 格式
      - Responses API：`anthropic-to-openai-responses.ts` 将请求转换为 OpenAI Responses 格式
   c. **消息转换**（`messages.ts`）：Anthropic role（user/assistant）映射到 OpenAI role，处理多模态内容
   d. **内容块转换**（`content-blocks.ts`）：
      - text → text
      - image（base64/url）→ image_url
      - thinking → 不发送（thinking 为 Anthropic 专有）
      - tool_use → function call（名称映射）
      - tool_result → function output（角色包装为 tool）
   e. **工具转换**（`tools.ts`）：Anthropic tool 定义 ↔ OpenAI function 定义 Schema 转换

2. **响应转换（OpenAI → Anthropic）**：
   a. 接收 OpenAI API 响应体
   b. `openai-chat-to-anthropic.ts`：将 Chat Completions 响应转换为 Anthropic Messages 响应格式
   c. `openai-responses-to-anthropic.ts`：将 Responses API 响应转换为 Anthropic Messages 响应格式
   d. 反向映射内容块、消息角色和工具调用

### 异常流程

1. **不支持的参数**：Anthropic 特有参数（如 thinking）在转换时静默忽略或降级处理
2. **内容类型不兼容**：部分内容类型在 OpenAI 端不支持时跳过或转换为最接近的替代
3. **工具调用格式差异**：不同提供商的 tool call 格式可能有细微差异，通过 provider-adapters 层补偿
4. **JSON 解析失败**：工具调用的 JSON 输入/输出解析失败时返回错误响应

## 涉及 API

- `convertAnthropicToOpenAIChatRequest(anthroReq)` -- Anthropic → OpenAI Chat Completions 请求转换
- `convertAnthropicToOpenAIResponsesRequest(anthroReq)` -- Anthropic → OpenAI Responses API 请求转换
- `convertOpenAIChatToAnthropicResponse(openaiResp)` -- OpenAI Chat → Anthropic 响应转换
- `convertOpenAIResponsesToAnthropicResponse(openaiResp)` -- OpenAI Responses → Anthropic 响应转换
- `convertContentBlocks(blocks)` -- 内容块双向转换
- `convertMessages(messages)` -- 消息格式双向转换
- `convertTools(tools)` -- 工具定义双向转换

## 涉及数据

- `AnthropicMessageRequest` -- Anthropic Messages API 请求类型
- `AnthropicMessageResponse` -- Anthropic Messages API 响应类型
- `OpenAIChatRequest` -- OpenAI Chat Completions 请求类型
- `OpenAIChatResponse` -- OpenAI Chat Completions 响应类型
- `OpenAIResponsesRequest` -- OpenAI Responses API 请求类型
- `OpenAIResponsesResponse` -- OpenAI Responses API 响应类型
- `ContentBlock` -- 内容块联合类型（text/image/tool_use/tool_result）

## 变更

-> changelog.md
