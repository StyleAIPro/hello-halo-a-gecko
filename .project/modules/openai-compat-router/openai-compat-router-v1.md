# 模块 -- OpenAI 兼容路由 openai-compat-router-v1

> 版本：openai-compat-router-v1
> 日期：2026-04-17
> 指令人：@StyleAIPro
> 来源架构：无，从现有代码逆向生成

## 职责

提供 Anthropic Claude Messages API 与 OpenAI API 之间的协议翻译层，使 AICO-Bot 能够透明地使用非 Anthropic 的 LLM 提供商（OpenAI、Groq、DeepSeek、OpenRouter 等），通过格式转换和本地 HTTP 代理实现零侵入的多模型接入。

## 架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     OpenAI Compat Router Module                              │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         server/ (HTTP 服务层)                          │  │
│  │                                                                        │  │
│  │  ┌──────────┐  ┌──────────────────┐  ┌────────────────────────────┐   │  │
│  │  │ index.ts │  │   router.ts      │  │   request-handler.ts       │   │  │
│  │  │ (生命周期) │  │ (Express 路由)   │  │ (请求处理核心)              │   │  │
│  │  └──────────┘  └──────────────────┘  └────────────────────────────┘   │  │
│  │                                                                        │  │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────────┐   │  │
│  │  │ request-queue.ts │  │ provider-adapters │  │   api-type.ts      │   │  │
│  │  │ (请求队列/限流)  │  │ (Provider 适配)   │  │ (API 类型检测)     │   │  │
│  │  └──────────────────┘  └──────────────────┘  └────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                      converters/ (协议转换层)                          │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────┐  ┌──────────────────────────────┐  │  │
│  │  │ request/                     │  │ response/                     │  │  │
│  │  │  anthro-to-openai-chat.ts    │  │  openai-chat-to-anthro.ts    │  │  │
│  │  │  anthro-to-openai-resp.ts    │  │  openai-resp-to-anthro.ts    │  │  │
│  │  └──────────────────────────────┘  └──────────────────────────────┘  │  │
│  │                                                                        │  │
│  │  ┌──────────────────┐  ┌──────────────┐  ┌──────────────────────┐    │  │
│  │  │ content-blocks.ts│  │ messages.ts  │  │    tools.ts          │    │  │
│  │  │ (内容块转换)      │  │ (消息格式)   │  │ (工具/函数调用转换)   │    │  │
│  │  └──────────────────┘  └──────────────┘  └──────────────────────┘    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                        stream/ (流式处理层)                            │  │
│  │                                                                        │  │
│  │  ┌────────────────────┐  ┌──────────────────────┐  ┌───────────────┐  │  │
│  │  │ sse-writer.ts      │  │ base-stream-handler  │  │ openai-chat-  │  │  │
│  │  │ (SSE 事件写入)     │  │ (流状态管理/基类)    │  │ stream.ts     │  │  │
│  │  └────────────────────┘  └──────────────────────┘  └───────────────┘  │  │
│  │                                                                        │  │
│  │  ┌────────────────────────┐                                           │  │
│  │  │ openai-responses-      │                                           │  │
│  │  │ stream.ts              │                                           │  │
│  │  └────────────────────────┘                                           │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                     interceptors/ (请求拦截层)                         │  │
│  │                                                                        │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────┐  │  │
│  │  │ warmup.ts    │  │ preflight.ts │  │      types.ts              │  │  │
│  │  │ (预热拦截)   │  │ (预检拦截)   │  │ (拦截器接口定义)            │  │  │
│  │  └──────────────┘  └──────────────┘  └────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                        types/ (类型定义层)                             │  │
│  │                                                                        │  │
│  │  ┌──────────────┐  ┌────────────────┐  ┌────────────────────────┐   │  │
│  │  │ anthropic.ts │  │ openai-chat.ts │  │ openai-responses.ts    │   │  │
│  │  └──────────────┘  └────────────────┘  └────────────────────────┘   │  │
│  │                                                                        │  │
│  │  ┌──────────────────┐  ┌────────────────────────────────────────┐    │  │
│  │  │ index.ts         │  │ (共享类型: BackendConfig, StreamState)  │    │  │
│  │  └──────────────────┘  └────────────────────────────────────────┘    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                        utils/ (工具层)                                │  │
│  │                                                                        │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────────┐   │  │
│  │  │ config.ts│  │  url.ts  │  │  id.ts   │  │    index.ts        │   │  │
│  │  │(配置编解码)│  │(URL 工具)│  │(ID 生成) │  │(JSON 解析/深拷贝) │   │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘

请求处理流程:

  Claude Code SDK (Anthropic 格式)
       │
       ▼
  POST /v1/messages (Express 路由)
       │
       ├── 拦截器 (interceptors/)
       │     ├── warmup.ts  → 返回 mock 响应
       │     └── preflight.ts → 返回 mock 响应（CC SDK 内部调用）
       │
       ├── 解码后端配置 (x-api-key → base64 JSON)
       │
       ├── API 类型检测 (api-type.ts)
       │     └── URL 路径 → Chat Completions / Responses API
       │
       ├── 请求队列 (request-queue.ts)
       │     └── 按 backendUrl + apiKey 前缀排队
       │
       ├── Provider 适配 (provider-adapters.ts)
       │     └── Groq/OpenRouter/DeepSeek 特殊处理
       │
       ├── 协议转换 (converters/)
       │     ├── Anthropic → OpenAI Chat/Responses 请求
       │     └── OpenAI Chat/Responses → Anthropic 响应
       │
       ├── 流式处理 (stream/)
       │     └── SSE 事件实时转换
       │
       └── 转发到后端 LLM 提供商
             (OpenAI / Groq / DeepSeek / OpenRouter / ...)

外部依赖:
  → Claude Code SDK (通过 Anthropic 格式 API 接入)
  → sdk-config.ts (构建 baseUrl + encoded apiKey)
  → mcp-manager.ts (确保路由器运行)
  → health-checker (通过 getRouterInfo 健康检查)
  → remote-agent-proxy (远程 Agent 也使用路由器)
```

## 对外接口

| 方法 | 输入 | 输出 | 说明 |
|------|------|------|------|
| ensureOpenAICompatRouter | 无 | `Promise<{ port: number, url: string }>` | 确保 HTTP 服务已启动，返回监听地址 |
| stopOpenAICompatRouter | 无 | `Promise<void>` | 停止 HTTP 服务 |
| getRouterInfo | 无 | `{ port: number, url: string } \| null` | 获取路由器当前信息（未启动返回 null） |
| encodeBackendConfig | `{ url, key, model?, apiType? }` | `string` | 将后端配置编码为 base64 字符串（用作 x-api-key） |
| decodeBackendConfig | `string` | `BackendConfig` | 解码 base64 后端配置 |
| detectApiType | `string` (URL) | `ApiType` | 基于 URL 路径检测 API 类型 |
| normalizeUrl | `string` (URL) | `string` | URL 规范化处理 |

## 内部组件

| 组件 | 职责 | 文件 |
|------|------|------|
| server-index | HTTP 服务生命周期管理（启动/停止/状态查询），监听 127.0.0.1 随机端口 | `openai-compat-router/server/index.ts` |
| router | Express 应用，定义 POST /v1/messages、POST /v1/messages/count_tokens、GET /health 路由 | `openai-compat-router/server/router.ts` |
| request-handler | 请求处理核心，支持 OpenAI 转换模式和 Anthropic 直通模式（含 429 重试） | `openai-compat-router/server/request-handler.ts` |
| request-queue | 请求排队，按 backendUrl + apiKey 前缀防止同一提供商并发请求（解决 429 限流） | `openai-compat-router/server/request-queue.ts` |
| provider-adapters | Provider 特定适配（Groq temperature 修正、OpenRouter 归属头、DeepSeek reasoning_content） | `openai-compat-router/server/provider-adapters.ts` |
| api-type | 基于 URL 路径检测 API 类型（Chat Completions vs Responses），URL 为唯一真相源 | `openai-compat-router/server/api-type.ts` |
| request-converter-chat | Anthropic Messages API → OpenAI Chat Completions 请求格式转换 | `openai-compat-router/converters/request/anthropic-to-openai-chat.ts` |
| request-converter-responses | Anthropic Messages API → OpenAI Responses API 请求格式转换 | `openai-compat-router/converters/request/anthropic-to-openai-responses.ts` |
| response-converter-chat | OpenAI Chat Completions → Anthropic Messages API 响应格式转换 | `openai-compat-router/converters/response/openai-chat-to-anthropic.ts` |
| response-converter-responses | OpenAI Responses API → Anthropic Messages API 响应格式转换 | `openai-compat-router/converters/response/openai-responses-to-anthropic.ts` |
| content-blocks | 内容块转换（text、image、thinking、tool_use、tool_result） | `openai-compat-router/converters/content-blocks.ts` |
| messages | 消息格式转换（角色映射、内容结构适配） | `openai-compat-router/converters/messages.ts` |
| tools | 工具/函数调用 Schema 转换（tool_use ↔ function_call） | `openai-compat-router/converters/tools.ts` |
| sse-writer | SSE 事件格式化写入工具 | `openai-compat-router/stream/sse-writer.ts` |
| base-stream-handler | 流处理基类，管理流状态和内容块生命周期 | `openai-compat-router/stream/base-stream-handler.ts` |
| openai-chat-stream | OpenAI Chat Completions 流式 SSE → Anthropic SSE 事件转换 | `openai-compat-router/stream/openai-chat-stream.ts` |
| openai-responses-stream | OpenAI Responses API 流式 SSE → Anthropic SSE 事件转换 | `openai-compat-router/stream/openai-responses-stream.ts` |
| warmup-interceptor | 拦截 CC CLI "Warmup" 请求，返回 mock 响应 | `openai-compat-router/interceptors/warmup.ts` |
| preflight-interceptor | 拦截 CC SDK 内部 LLM 调用（bash_extract_prefix 安全分析等），指纹检测：tools=0 + system prompt 子串匹配 | `openai-compat-router/interceptors/preflight.ts` |
| interceptor-types | RequestInterceptor 接口、InterceptorContext、InterceptorResult 定义 | `openai-compat-router/interceptors/types.ts` |
| anthropic-types | Anthropic Messages API 完整类型定义 | `openai-compat-router/types/anthropic.ts` |
| openai-chat-types | OpenAI Chat Completions API 类型定义 | `openai-compat-router/types/openai-chat.ts` |
| openai-responses-types | OpenAI Responses API 类型定义 | `openai-compat-router/types/openai-responses.ts` |
| shared-types | 共享类型（BackendConfig、RouterServerInfo、StreamState 等） | `openai-compat-router/types/index.ts` |
| config-utils | 后端配置编解码（base64 JSON → x-api-key） | `openai-compat-router/utils/config.ts` |
| url-utils | URL 规范化辅助函数 | `openai-compat-router/utils/url.ts` |
| id-utils | ID 生成（message ID、tool use ID） | `openai-compat-router/utils/id.ts` |
| general-utils | safeJsonParse、deepClone 等通用工具函数 | `openai-compat-router/utils/index.ts` |

## 功能列表

| 功能 | 状态 | 文档 |
|------|------|------|
| protocol-conversion | 已完成 | features/protocol-conversion/design.md |
| stream-pipeline | 已完成 | features/stream-pipeline/design.md |
| request-routing | 已完成 | features/request-routing/design.md |
| interceptors | 已完成 | features/interceptors/design.md |

## 绑定的 API

- 无（通过内部 HTTP 服务和函数调用暴露接口，不通过 IPC 通道）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-17 | 初始模块文档 | @StyleAIPro |
