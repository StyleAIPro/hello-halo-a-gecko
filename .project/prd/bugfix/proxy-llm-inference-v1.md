# PRD [Bug 修复级] — LLM 推理请求未走用户配置的网络代理

> 版本：proxy-llm-inference-v1
> 日期：2026-05-10
> 指令人：moonseeker
> 归属模块：modules/main/services (proxy + openai-compat-router)
> 严重程度：High（内网用户无法使用 AI 模型推理）
> 影响范围：仅后端
> 状态：done

## 问题描述

### 期望行为

当用户在「设置 > 系统 > 网络代理」中配置了代理后，**所有**外部 HTTP/HTTPS 请求都应通过该代理发出，包括 LLM 推理请求（即调用 OpenAI/Anthropic 等模型 API 的请求）。

### 实际行为

LLM 推理请求直接使用原生 `fetch()` 发出，完全绕过了用户配置的网络代理。导致：
- 内网用户配置了代理后，技能市场、GitHub 认证等功能正常，但 AI 对话无法使用
- 用户看到的错误信息是网络连接失败，误以为是模型 API 密钥或服务问题
- `error-classifier.ts` 提示用户前往代理设置，但即便用户已配置代理，LLM 推理仍然不走代理

### 复现步骤

1. 在内网环境（需要代理才能访问外网）启动 AICO-Bot
2. 打开设置 > 系统，配置网络代理（如 `http://127.0.0.1:7890`）
3. 验证代理已生效：点击「测试」按钮，或打开技能市场确认能加载
4. 创建/打开一个工作空间，使用 AI 模型发送消息
5. 观察错误：请求超时或网络连接失败，而非模型响应

### 影响范围

- **内网代理环境**：必现
- **外网直连环境**：不受影响
- **影响功能**：所有通过 OpenAI Compat Router 的 AI 模型推理（OpenAI Chat、OpenAI Responses、Anthropic Passthrough）

## 根因分析

### 根因：openai-compat-router 的上游请求函数使用原生 fetch()

`src/main/openai-compat-router/server/request-handler.ts` 中定义了两个私有函数 `fetchUpstream()` 和 `fetchAnthropicUpstream()`，它们直接调用原生 `fetch()` 发出请求，未使用项目统一的 `proxyFetch()`。

项目中所有其他外部 HTTP 请求（GitHub 认证、技能市场、API 验证、GitCode API、gh-search 等）均已使用 `proxyFetch()`，唯独 LLM 推理请求遗漏。

**调用链**：
```
SDK 请求 → Express Router (/v1/messages)
         → handleMessagesRequest()
         → handleAnthropicPassthrough() 或 handleOpenAIConversion()
         → fetchAnthropicUpstream() 或 fetchUpstream()   ← 此处使用原生 fetch()
```

### 遗漏原因分析

OpenAI Compat Router 是一个相对独立的模块（`src/main/openai-compat-router/`），不在 `src/main/services/` 目录下。在 `network-proxy-v1` PRD 中梳理需要适配的服务列表时，该模块未被识别。同时该模块作为协议转换层，其上游请求函数被设计为纯网络调用，未接入代理基础设施。

## 技术方案

### 方案概述

将 `fetchUpstream()` 和 `fetchAnthropicUpstream()` 中的原生 `fetch()` 替换为 `proxyFetch()`。需要先增强 `proxyFetch` 以支持 LLM 推理请求所需的特性（Buffer body、长超时、外部 AbortSignal）。

### 修改 1：增强 proxyFetch 支持 Buffer body 和外部 AbortSignal

**文件**：`src/main/services/proxy/proxy-fetch.ts`

#### 1a. Buffer body 支持

当前 `fetchViaProxy()` 和 `fetchViaCurl()` 在写入请求体时，对非 string 类型的 body 调用 `String()`：

```typescript
// 当前代码（line 305）
tlsReq.write(typeof init.body === 'string' ? init.body : String(init.body));
```

`String()` 对 `Buffer` 会返回 `"[object Buffer]"`，导致请求体损坏。需要增加 `Buffer` 类型的处理：

```typescript
// 修改后
if (init?.body) {
  const bodyData = Buffer.isBuffer(init.body) ? init.body
    : typeof init.body === 'string' ? init.body
    : String(init.body);
  tlsReq.write(bodyData);
}
```

同样需要修改 `fetchViaProxy()` 中的 HTTP 分支（line 329）和 `fetchViaCurl()` 中的 `-d` 参数（line 164）。

#### 1b. 外部 AbortSignal 传递

当前 `proxyFetch()` 不接受外部 `AbortSignal`。需要扩展 `RequestInit` 中 `signal` 的透传：

在 `fetchViaProxy()` 中，当外部 `init.signal` 存在时，监听其 `abort` 事件并触发连接销毁：

```typescript
// 在 fetchViaProxy 的 Promise 内部，proxyReq 创建后
if (init?.signal?.aborted) {
  clearTimeout(timeout);
  req.destroy();
  reject(new DOMException('The operation was aborted.', 'AbortError'));
  return;
}
const onExternalAbort = () => {
  clearTimeout(timeout);
  req.destroy();
  reject(new DOMException('The operation was aborted.', 'AbortError'));
};
init?.signal?.addEventListener('abort', onExternalAbort, { once: true });
```

在无代理的直连路径中，`proxyFetch` 已经将 `init.signal` 传入原生 `fetch`，但需确保外部 signal 与内部超时 signal 协调（任一触发即 abort）。

#### 1c. 超时参数传递

LLM 推理请求的默认超时为 30 分钟（`DEFAULT_TIMEOUT_MS = 30 * 60 * 1000`），而 `proxyFetch` 默认超时为 30 秒。调用方必须显式传入 `timeoutMs` 参数。

### 修改 2：替换 fetchUpstream 中的原生 fetch

**文件**：`src/main/openai-compat-router/server/request-handler.ts`

将 `fetchUpstream()` 函数中的原生 `fetch` 替换为 `proxyFetch`：

```typescript
import { proxyFetch } from '../../services/proxy';

async function fetchUpstream(
  targetUrl: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
  customHeaders?: Record<string, string>,
): Promise<globalThis.Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(customHeaders || {}),
  };
  if (!headers['Authorization']) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // 使用 proxyFetch 替代原生 fetch
  // proxyFetch 内部已处理超时（通过 timeoutMs 参数）
  // 外部 signal 通过 init.signal 传入
  return proxyFetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  }, timeoutMs);
}
```

注意：
- 删除函数内部的 `AbortController` + `setTimeout` 超时逻辑，因为 `proxyFetch` 已内置超时处理
- 如果调用方传入了外部 `signal`，通过 `init.signal` 传递给 `proxyFetch`（前提是修改 1b 完成后 `proxyFetch` 支持）

### 修改 3：替换 fetchAnthropicUpstream 中的原生 fetch

**文件**：`src/main/openai-compat-router/server/request-handler.ts`

将 `fetchAnthropicUpstream()` 函数中的原生 `fetch` 替换为 `proxyFetch`：

```typescript
async function fetchAnthropicUpstream(
  targetUrl: string,
  apiKey: string,
  bodyOrBuffer: Buffer | unknown,
  timeoutMs: number,
  sdkHeaders?: Record<string, string>,
  customHeaders?: Record<string, string>,
): Promise<globalThis.Response> {
  const headers: Record<string, string> = {
    ...(sdkHeaders || {}),
    ...(customHeaders || {}),
    'x-api-key': apiKey,
  };

  const body = Buffer.isBuffer(bodyOrBuffer) ? bodyOrBuffer : JSON.stringify(bodyOrBuffer);

  // 使用 proxyFetch 替代原生 fetch
  return proxyFetch(targetUrl, {
    method: 'POST',
    headers,
    body,
  }, timeoutMs);
}
```

注意：
- 此函数接受 `Buffer | unknown` 类型的 body。当 `canUseRawBody` 为 true 时传入原始 `Buffer`（零拷贝转发），此时 `proxyFetch` 必须正确处理 Buffer body（修改 1a）
- 删除函数内部的 `AbortController` + `setTimeout` 超时逻辑

### 修改 4：proxyFetch 无代理回退路径的 AbortSignal 支持

**文件**：`src/main/services/proxy/proxy-fetch.ts`

当前无代理回退路径已经支持 `init.signal`，但存在超时信号与外部信号的协调问题：

```typescript
// 当前代码
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeout);
const response = await fetch(url, {
  ...init,
  signal: controller.signal,  // 外部 signal 被覆盖
});
```

需要改为同时监听外部 signal 和内部超时：

```typescript
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeout);

// 如果外部 signal 已经 aborted
if (init?.signal?.aborted) {
  clearTimeout(timer);
  throw new DOMException('The operation was aborted.', 'AbortError');
}

// 监听外部 signal
const onExternalAbort = () => controller.abort();
init?.signal?.addEventListener('abort', onExternalAbort, { once: true });

try {
  const response = await fetch(url, {
    ...init,
    signal: controller.signal,
  });
  return response;
} catch (error: unknown) {
  if (error instanceof Error && error.name === 'AbortError') {
    throw new Error(`Request timed out after ${timeout / 1000}s: ${url}`, { cause: error });
  }
  throw error;
} finally {
  clearTimeout(timer);
  init?.signal?.removeEventListener('abort', onExternalAbort);
}
```

### 修改 5：fetchViaCurl 的 Buffer body 支持

**文件**：`src/main/services/proxy/proxy-fetch.ts`

`fetchViaCurl()` 中，curl 的 `-d` 参数需要 string。对 Buffer body 需转为 string：

```typescript
// 当前代码
if (init?.body) {
  args.push('-d', typeof init.body === 'string' ? init.body : String(init.body));
}

// 修改后
if (init?.body) {
  const bodyStr = Buffer.isBuffer(init.body) ? init.body.toString('utf-8')
    : typeof init.body === 'string' ? init.body
    : String(init.body);
  args.push('-d', bodyStr);
}
```

### 修改 6：请求日志增强（可选但建议）

**文件**：`src/main/openai-compat-router/server/request-handler.ts`

在 `fetchUpstream` 和 `fetchAnthropicUpstream` 中添加代理状态日志，便于排查：

```typescript
import { getEffectiveProxyUrl } from '../../services/proxy';

// 在 fetch 函数中
const proxyUrl = getEffectiveProxyUrl();
console.log(`[RequestHandler] Fetch via ${proxyUrl ? `proxy (${proxyUrl})` : 'direct'}: ${targetUrl}`);
```

### 不需要修改的部分

- **`router.ts`**：仅负责路由转发，不涉及上游请求
- **`server/index.ts`**：仅负责服务器启停
- **stream 处理**：`upstreamResp.body` 是 `ReadableStream`，`proxyFetch` 的 `convertNodeResponse` 已返回 `ReadableStream`，SSE 流式转发无需修改
- **错误处理**：两个函数外部的错误处理逻辑不变，`AbortError` 仍会被正确捕获

## 风险评估

### 风险 1：Buffer body 在 proxyFetch 中的处理（中风险）

`fetchAnthropicUpstream` 的 `rawBody` 模式会将原始 `Buffer` 直接作为 fetch body 发送。`proxyFetch` 当前的 body 处理逻辑会破坏 Buffer。

**缓解**：修改 1a 和 1b 精确处理 Buffer 类型。修改后可通过现有 server.test.ts 验证非 Buffer 场景回归，手动测试 Buffer 场景。

### 风险 2：双重超时冲突（低风险）

`fetchUpstream`/`fetchAnthropicUpstream` 内部已有 30 分钟超时，`proxyFetch` 也有自己的超时逻辑。替换后需确保不会出现双重超时导致的不一致。

**缓解**：替换方案直接删除上游函数的内部超时逻辑，统一使用 `proxyFetch` 的 `timeoutMs` 参数，避免双重超时。

### 风险 3：proxyFetch 的 convertNodeResponse 返回的 ReadableStream 与原生 fetch 的差异（低风险）

`convertNodeResponse` 返回的 `Response` 对象使用手动构建的 `ReadableStream`，而原生 `fetch` 返回的 `Response` 底层可能是不同的实现。SSE 流式转发依赖 `upstreamResp.body.getReader().read()` 循环，两种实现都应兼容。

**缓解**：`ReadableStream` 是 Web API 标准，`getReader().read()` 接口一致。实际风险极低，但需手动测试 SSE 流式响应。

### 风险 4：fetchViaCurl fallback 路径的 body 处理（低风险）

当代理需要 SSPI 认证时，请求会回退到 `fetchViaCurl`（curl.exe 子进程）。curl 的 `-d` 参数只接受 string，Buffer body 需要正确转换。

**缓解**：修改 5 中已处理此问题，`Buffer.toString('utf-8')` 可正确转换。

## 开发前必读

| 类型 | 文件 | 阅读目的 |
|------|------|---------|
| 源码文件 | `src/main/services/proxy/proxy-fetch.ts` | 理解 `proxyFetch` 的完整实现、CONNECT 隧道机制、curl fallback、body 处理、超时逻辑 |
| 源码文件 | `src/main/services/proxy/proxy-agent.ts` | 理解 `getEffectiveProxyUrl()` 的配置优先级（用户配置 > 环境变量 > 直连） |
| 源码文件 | `src/main/openai-compat-router/server/request-handler.ts` | 理解 `fetchUpstream` 和 `fetchAnthropicUpstream` 的签名、参数、调用方、Buffer body 使用方式、超时处理 |
| 源码文件 | `src/main/openai-compat-router/server/router.ts` | 理解 Express 路由如何提取 rawBody、sdkHeaders 并传递给 handler |
| 源码文件 | `src/main/openai-compat-router/server/index.ts` | 理解 Router 服务启停机制 |
| 关联 PRD | `.project/prd/feature/network-proxy/network-proxy-v1.md` | 理解代理系统的整体架构和设计意图 |
| 关联 PRD | `.project/prd/bugfix/github/github-auth-proxy-fix-v1.md` | 理解 proxyFetch 最近一次修复（环境变量支持、curl SSL），避免回归 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、IPC 常量化等编码规范 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/proxy/proxy-fetch.ts` | 修改 | 增强 Buffer body 支持（fetchViaProxy + fetchViaCurl）；增强外部 AbortSignal 透传（代理路径 + 直连路径）；清理超时信号协调 |
| `src/main/openai-compat-router/server/request-handler.ts` | 修改 | `fetchUpstream()` 和 `fetchAnthropicUpstream()` 改用 `proxyFetch()`；删除内部超时逻辑；添加代理状态日志 |

## 验收标准

### 核心功能

- [ ] 配置代理后，LLM 推理请求（OpenAI Chat Completions / Responses / Anthropic Passthrough）通过代理发出
- [ ] 未配置代理时，LLM 推理请求直连，功能不受影响（回归验证）
- [ ] Anthropic Passthrough 模式的 `rawBody`（Buffer）转发正常，SSE 流式响应正常
- [ ] OpenAI Chat 模式的请求和响应正常，SSE 流式翻译正常
- [ ] 超时机制正常：30 分钟默认超时仍生效
- [ ] 外部 AbortSignal（客户端断开连接）仍能正确中断请求

### 代理兼容性

- [ ] 普通 HTTP 代理（如 Clash、V2Ray HTTP 模式）正常工作
- [ ] 需要认证的代理正常工作（Basic Auth）
- [ ] 需要 SSPI/Negotiate 认证的代理正常工作（curl fallback 路径）
- [ ] 环境变量代理（`HTTPS_PROXY` / `HTTP_PROXY`）仍生效

### 代码质量

- [ ] TypeScript 类型检查通过（`npm run typecheck`）
- [ ] 构建通过（`npm run build`）
- [ ] `proxyFetch` 的 body 处理正确支持 `string`、`Buffer`、`unknown` 三种类型
- [ ] 无双重超时问题
- [ ] 无 `AbortError` 信号泄漏（`removeEventListener` 清理）
