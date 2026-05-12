# PRD [Bug 修复级] — 获取模型和测试连接的成功/失败判定不可靠

> 版本：bugfix-model-fetch-and-validate-v1
> 日期：2026-05-10
> 状态：done
> 指令人：@mi-saka
> 归属模块：modules/ai-sources
> 严重程度：Major
> 所属功能：features/source-provider

## 问题描述

- **期望行为**："获取模型"和"测试连接"功能能准确判定 API 调用成功或失败，给出正确反馈
- **实际行为**：在多种 OpenAI 兼容提供商场景下，出现以下误判：
  - 测试连接：API 实际报错（401 无效密钥、模型不存在、速率限制等）时仍显示"连接成功"
  - 获取模型：API 返回正常模型列表时因格式不兼容而报"格式无效"
  - 测试连接：冷启动或网络较慢时因超时过短而误报失败

## 根因分析

### Bug 1：测试连接误报成功（False Positive）

**文件**：`src/main/services/ai-sources/api-validator.service.ts` 第 213-234 行

`validateApiConnection()` 的 SDK stream 循环中，将**所有** `msg.type === 'result'` 消息视为成功，设置 `hasResponse = true`：

```typescript
} else if (msg.type === 'result') {
  hasResponse = true;  // BUG: 未检查 result 是否包含错误
  break;
}
```

SDK 的 `result` 消息在**所有**场景下都会发出，包括 API 报错。项目内其他模块（`message-utils.ts`、`process-stream.ts`）已正确处理此场景：通过 `msg.is_error`、`msg.subtype`、`msg.errors` 等字段判断是否为错误。但 `api-validator.service.ts` 未检查这些字段，导致 API 返回错误时仍报告"连接成功"。

SDK result 消息的错误判定模式（来自 `process-stream.ts:1213` 和 `message-utils.ts:311`）：
- `msg.is_error === true` — API 级别错误（认证失败、模型不存在等）
- `msg.subtype === 'error_during_execution'` — 执行中断
- `msg.subtype === 'error_max_turns'` — 达到最大轮次
- `msg.result` — 错误详情文本

### Bug 2：获取模型误报失败（False Negative）

**文件**：`src/main/services/ai-sources/api-validator.service.ts` 第 89-91 行

`fetchModelsFromApi()` 的响应格式检查过于严格，仅接受 OpenAI 标准格式 `{ data: [...] }`：

```typescript
if (!data.data || !Array.isArray(data.data)) {
  throw new Error('Invalid API response format');
}
```

许多 OpenAI 兼容提供商返回不同格式：
- 部分提供商返回 `{ models: [...] }` 或 `{ data: { models: [...] } }`
- Ollama 返回 `{ models: [...] }`（`/api/tags` 端点）
- 部分提供商直接返回数组 `[...]`

### Bug 3：URL 规范化逻辑不一致

**文件**：`api-validator.service.ts` 第 54-65 行 vs `src/main/openai-compat-router/utils/url.ts` 第 26-52 行

`fetchModelsFromApi()` 拥有独立的 URL 规范化逻辑，与 `validateApiConnection()` 使用的 `normalizeApiUrl()` 存在差异：

| URL 输入 | `fetchModelsFromApi` 处理结果 | `normalizeApiUrl` 处理结果 |
|----------|------------------------------|---------------------------|
| `https://api.example.com` | `https://api.example.com/v1/models` | `https://api.example.com/v1/chat/completions` |
| `https://api.example.com/v1/chat/completions` | `https://api.example.com/v1/models` | `https://api.example.com/v1/chat/completions` |
| `https://api.example.com/api/v1` | `https://api.example.com/api/v1/models` | `https://api.example.com/api/v1/chat/completions` |
| `https://api.example.com/api/paas` | `https://api.example.com/api/paas/v1/models` | `https://api.example.com/api/paas/chat/completions` |

两套逻辑对 `/v1` 的判断条件不同，可能导致同一 URL 在获取模型时正常但在测试连接时异常（或反之）。

### Bug 4：测试连接超时过短且错误模式覆盖不全

**文件**：`api-validator.service.ts` 第 172-175 行、第 262-294 行

- 超时设为 15 秒（第 173 行），对于某些冷启动场景（如首次请求、远端部署服务器）可能不足
- 错误模式匹配（第 273-287 行）仅覆盖部分 HTTP 状态码和网络错误，缺少以下常见场景：
  - SDK 内部错误消息格式（如 `model_not_found`、`permission denied`）
  - `assistant` 消息中包含错误指示文本的情况

### Bug 5：获取模型结果验证不足（False Positive 风险）

**文件**：`api-validator.service.ts` 第 93-94 行

模型过滤条件仅检查 `typeof m.id === 'string'`，未验证对象是否为合法的模型条目。当 API 返回 HTTP 200 但内容为错误对象数组（恰好含 `id` 字符串字段）时，可能将错误信息误判为模型列表。

## 技术方案

### 修复 1：测试连接正确判定 result 消息错误

在 stream 循环中，收到 `result` 消息时检查 SDK 错误字段（与 `process-stream.ts` 保持一致的模式）：

```typescript
} else if (msg.type === 'result') {
  const resultMsg = msg as any;
  const isError = resultMsg.is_error === true;
  const errorSubtype = resultMsg.subtype;
  const errorContent = resultMsg.result || resultMsg.message?.result || '';

  if (isError) {
    // API 级别错误，视为连接失败
    hasResponse = false;
    lastError = errorContent || 'API returned an error';
  } else if (errorSubtype === 'error_during_execution') {
    // 执行中断（网络问题等）
    hasResponse = false;
    lastError = 'Connection interrupted during execution';
  } else if (errorSubtype === 'error_max_turns') {
    // 达到最大轮次，视为成功（SDK 正常完成）
    hasResponse = true;
  } else {
    // 正常 result
    hasResponse = true;
  }
  break;
}
```

### 修复 2：获取模型支持多种响应格式

添加回退格式解析，兼容主流 OpenAI 兼容 API 的不同响应结构：

```typescript
let models: Array<{ id: string; name: string }>;

// 格式 1：OpenAI 标准 { data: [...] }
if (data.data && Array.isArray(data.data)) {
  models = data.data.filter((m: any) => typeof m.id === 'string')
    .map((m: any) => ({ id: m.id, name: m.owned_by || m.id }));
}
// 格式 2：{ models: [...] }（Ollama /api/tags 等）
else if (data.models && Array.isArray(data.models)) {
  models = data.models.filter((m: any) => typeof m.id === 'string' || typeof m.name === 'string')
    .map((m: any) => ({ id: m.id || m.name, name: m.name || m.id }));
}
// 格式 3：直接数组 [...]
else if (Array.isArray(data)) {
  models = data.filter((m: any) => typeof m.id === 'string')
    .map((m: any) => ({ id: m.id, name: m.owned_by || m.id }));
}
else {
  throw new Error('Invalid API response format');
}
```

### 修复 3：统一 URL 规范化逻辑

将 `fetchModelsFromApi()` 中的 URL 规范化逻辑提取为共享函数，与 `normalizeApiUrl()` 保持一致的基础 URL 提取逻辑：

```typescript
/**
 * 规范化模型列表 URL
 *
 * 与 normalizeApiUrl 共用基础 URL 提取逻辑，确保两个操作对同一输入 URL
 * 得到一致的基础路径（仅末尾路径不同：/models vs /chat/completions）
 */
export function normalizeModelsUrl(apiUrl: string): string {
  const trimSlash = (s: string) => s.replace(/\/+$/, '');
  let baseUrl = trimSlash(apiUrl);

  // 剥离已知的路径后缀（与 normalizeApiUrl 的逻辑对齐）
  const suffixes = ['/chat/completions', '/completions', '/responses', '/chat'];
  for (const suffix of suffixes) {
    if (baseUrl.endsWith(suffix)) {
      baseUrl = baseUrl.slice(0, -suffix.length);
      break;
    }
  }

  // 与 normalizeApiUrl 一致：仅对纯主机 URL 自动追加 /v1
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+$/.test(baseUrl)) {
    baseUrl = `${baseUrl}/v1`;
  }

  return `${baseUrl}/models`;
}
```

关键改动：将原来的 `/v1` 判断条件 `!baseUrl.includes('/v1')` 改为与 `normalizeApiUrl` 一致的纯主机 URL 正则检测，同时对齐后缀剥离列表。

### 修复 4：改善测试连接超时和错误处理

- 将超时从 15 秒增加到 20 秒，兼容冷启动场景
- 扩展错误模式匹配，覆盖更多场景：
  - `'model_not_found'` / `'invalid_model'` → "模型不存在"
  - `'permission denied'` / `'insufficient'` → "权限不足"
  - `'ENOTFOUND'` / `'ECONNREFUSED'` → "无法连接到服务器"

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计 | `.project/modules/ai-sources/ai-sources-v1.md` | 理解 AI 源管理模块的整体架构和对外接口 |
| 模块设计 | `.project/modules/ai-sources/features/source-provider/design.md` | 理解提供商接口和适配器设计 |
| 变更记录 | `.project/modules/ai-sources/features/source-provider/changelog.md` | 了解最近的变更 |
| Bug 记录 | `.project/modules/ai-sources/features/source-provider/bugfix.md` | 了解已知问题 |
| Bug 记录 | `.project/modules/ai-sources/features/source-manager/bugfix.md` | 了解相关模块已知问题 |
| 源码 | `src/main/services/ai-sources/api-validator.service.ts` | **核心修改文件**，理解当前 fetchModelsFromApi 和 validateApiConnection 实现 |
| 源码 | `src/main/openai-compat-router/utils/url.ts` | **核心修改文件**，理解 URL 规范化逻辑，提取共享函数 |
| 源码 | `src/main/services/agent/process-stream.ts`（第 1202-1232 行） | 参考 SDK result 消息的错误判定模式 |
| 源码 | `src/main/services/agent/message-utils.ts`（第 309-327 行） | 参考 SDK result 消息的解析模式 |
| 源码 | `src/main/ipc/config.ts`（第 55-86 行） | 理解 IPC 层调用 validator 的方式 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、IPC 模式等编码规范 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/ai-sources/api-validator.service.ts` | 修改 | 修复 Bug 1-4：result 错误判定、多格式解析、URL 规范化、超时与错误处理 |
| `src/main/openai-compat-router/utils/url.ts` | 修改 | 新增 `normalizeModelsUrl()` 共享函数（修复 Bug 3） |

## 验收标准

- [ ] **测试连接 False Positive**：使用无效 API Key（401）测试连接时，显示连接失败而非成功
- [ ] **测试连接 False Positive**：使用不存在的模型测试连接时，显示错误而非成功
- [ ] **获取模型 False Negative**：对返回 `{ models: [...] }` 格式的提供商（如 Ollama），能正常获取模型列表
- [ ] **获取模型 False Negative**：对返回直接数组格式的提供商，能正常获取模型列表
- [ ] **URL 一致性**：对同一 URL（如 `https://api.example.com`、`https://api.example.com/v1/chat/completions`），获取模型和测试连接使用一致的基础 URL 规范化
- [ ] **超时改善**：冷启动场景（首次请求、远端服务器）下不再因超时过短误报
- [ ] **错误提示**：常见错误（401/403/404/429/网络不可达）给出准确的用户友好提示
- [ ] **回归测试**：原有的 OpenAI 标准格式 `{ data: [...] }` 获取模型仍正常工作
- [ ] **回归测试**：原有的 Anthropic 直连测试连接仍正常工作
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-10 | 初始 Bug 修复 PRD | @moonseeker |
