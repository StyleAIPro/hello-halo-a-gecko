# 功能 -- 请求路由

> 日期：2026-04-17
> 指令人：@StyleAIPro
> 来源 PRD：无（从现有代码逆向生成）
> 所属模块：modules/openai-compat-router

## 描述

请求路由子系统，管理 OpenAI 兼容路由器的 HTTP 服务生命周期和请求分发。包括 Express 路由定义、请求处理核心（支持 OpenAI 转换和 Anthropic 直通两种模式）、按提供商的请求排队限流、Provider 特定适配和 API 类型检测。

该子系统是路由器的入口层，负责接收 Claude Code SDK 发出的 Anthropic 格式请求，解码后端配置，选择处理模式，并协调协议转换、流处理和后端转发。

## 依赖

- `converters/` -- 协议格式转换器
- `stream/` -- 流式响应处理
- `interceptors/` -- 请求拦截器
- `utils/config.ts` -- 后端配置编解码
- `utils/url.ts` -- URL 规范化

## 实现逻辑

### 正常流程

1. **服务启动**（`server/index.ts`）：
   a. `ensureOpenAICompatRouter()` 检查是否已启动
   b. 未启动则创建 Express 应用，绑定随机端口（127.0.0.1）
   c. 返回 `{ port, url }` 供 SDK 配置使用

2. **路由匹配**（`server/router.ts`）：
   - `POST /v1/messages` -- 主消息处理路由
   - `POST /v1/messages/count_tokens` -- Token 计数路由
   - `GET /health` -- 健康检查路由

3. **请求处理**（`server/request-handler.ts`）：
   a. 从 `x-api-key` header 解码后端配置（base64 JSON：`{url, key, model?, apiType?}`）
   b. 判断处理模式：
      - **OpenAI 转换模式**：调用协议转换器 → 转发到后端 → 转换响应 → 返回
      - **Anthropic 直通模式**：直接转发原始请求体，零转换
   c. 直通模式特性：
      - 429 状态码自动重试一次
      - 原始请求体透传
      - 响应 header 透传

4. **请求排队**（`server/request-queue.ts`）：
   a. 以 `backendUrl + apiKey 前缀` 为 key 建立请求队列
   b. 同一提供商的请求串行执行，防止并发触发 429 限流
   c. 队列请求按 FIFO 顺序执行

5. **Provider 适配**（`server/provider-adapters.ts`）：
   - Groq：temperature=0 自动修正为 0.01（Groq 不支持 0）
   - OpenRouter：添加 HTTP-Referer 和 X-Title 归属 header
   - DeepSeek：reasoning_content 处理（在流处理器中实现）

6. **API 类型检测**（`server/api-type.ts`）：
   a. 基于 URL 路径判断 API 类型
   b. `/chat/completions` → Chat Completions API
   c. 其他路径 → Responses API
   d. URL 是唯一真相源，优先级高于用户配置

### 异常流程

1. **服务启动失败**：端口被占用，尝试重新绑定
2. **配置解码失败**：x-api-key 格式错误，返回 400
3. **后端不可达**：请求超时或连接拒绝，返回 502
4. **429 限流**：直通模式下自动重试一次；转换模式下由请求队列避免
5. **后端返回错误**：透传错误状态码和消息

## 涉及 API

- `ensureOpenAICompatRouter()` -- 确保路由器服务已启动
- `stopOpenAICompatRouter()` -- 停止路由器服务
- `getRouterInfo()` -- 获取路由器状态信息
- `handleRequest(req, res)` -- 核心请求处理函数
- `enqueueRequest(queueKey, handler)` -- 将请求加入队列
- `adaptRequest(config, request)` -- Provider 特定请求适配
- `detectApiType(url)` -- 检测 API 类型

## 涉及数据

- `BackendConfig` -- 后端配置（url, key, model?, apiType?）
- `RouterServerInfo` -- 路由器服务信息（port, url）
- `RequestQueue` -- 请求队列（Map<queueKey, Promise chain>）

## 变更

-> changelog.md
