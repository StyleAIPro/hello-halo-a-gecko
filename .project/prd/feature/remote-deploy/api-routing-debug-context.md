# 远程 Agent API 路由问题 — 上下文文档

> 日期：2026-04-24
> 状态：已修复（待打包测试）

## 问题描述

本地 AICO-Bot 配置内部模型 URL（`http://IP:port` 格式），provider 为 `anthropic`，本地工作正常，但远程服务器返回 404。

用户临时 workaround：把 URL 改成 `http://IP:port/v1/chat/completions` 后远端能用。

## 根因

远端 proxy 的 `detectBackendType()` 只靠 URL 字符串推断后端类型，无法区分 Anthropic 兼容服务器和 OpenAI 兼容服务器。

### 本地 vs 远端的 URL 使用差异

| 路径 | URL 处理方式 | `http://IP:port` 的结果 |
|------|-------------|----------------------|
| 本地 Anthropic provider | SDK 自动拼 `/v1/messages` | `http://IP:port/v1/messages` → 正确 |
| 远端 openai_compat（误判） | Router 用 URL 原样 POST | `http://IP:port`（无路径）→ 404 |
| 远端 openai_compat + workaround | Router 用 URL 原样 POST | `http://IP:port/v1/chat/completions` → 能用 |

**核心差异**：Anthropic SDK 路径会自动在 baseUrl 后拼 `/v1/messages`；OpenAI Compat Router 直接用 URL 原样发请求，不拼任何路径。

### 关键代码路径

```
本地 AICO-Bot (send-message.ts)
  → WebSocket 发送 { apiKey, baseUrl, model }  （缺少 apiType）
    → 远端 proxy (server.ts) 直接透传 options
      → claude-manager.ts buildSdkOptions()
        → detectBackendType(baseUrl)  ← 只看 URL 字符串
          → IP:port 不含 api.anthropic.com 也不含 /anthropic
          → 误判为 openai_compat
            → 走 OpenAI Compat Router
              → 用 URL 原样 POST（不拼路径）
                → http://IP:port → 404
```

### detectBackendType 的问题代码

`packages/remote-agent-proxy/src/claude-manager.ts:715`

```typescript
private detectBackendType(baseUrl?: string): 'anthropic' | 'openai_compat' {
  if (process.env.REMOTE_AGENT_API_TYPE === 'anthropic_passthrough') return 'anthropic'
  if (!baseUrl) return 'anthropic'
  if (baseUrl.includes('api.anthropic.com')) return 'anthropic'
  if (baseUrl.includes('/anthropic')) return 'anthropic'
  return 'openai_compat'  // ← IP:port 必定走这里
}
```

## 已应用的修复

3 个文件，4 处改动：

### 1. send-message.ts — 传递 apiType 到远端

`src/main/services/agent/send-message.ts:1584`

```typescript
// WebSocket 选项新增 apiType
{
  apiKey,
  baseUrl: baseUrl || undefined,
  model,
  apiType: currentSource?.apiType,  // ← 新增
  ...
}
```

### 2. claude-manager.ts — detectBackendType 接收 apiType

```typescript
// 新增 apiType 参数，最高优先级判断
private detectBackendType(
  baseUrl?: string,
  apiType?: string,  // ← 新增
): 'anthropic' | 'openai_compat' {
  if (apiType === 'anthropic_passthrough') return 'anthropic'  // ← 新增
  if (process.env.REMOTE_AGENT_API_TYPE === 'anthropic_passthrough') return 'anthropic'
  if (!baseUrl) return 'anthropic'
  if (baseUrl.includes('api.anthropic.com')) return 'anthropic'
  if (baseUrl.includes('/anthropic')) return 'anthropic'
  return 'openai_compat'
}
```

### 3. claude-manager.ts — buildSdkOptions 透传 apiType

```typescript
// credentials 类型新增 apiType
credentials?: { apiKey?: string; baseUrl?: string; model?: string; apiType?: string }

// 调用时传入
const backendType = this.detectBackendType(effectiveBaseUrl, credentials?.apiType)
```

### 4. claude-manager.ts — clientCredentials 透传 apiType

```typescript
const clientCredentials = (options.apiKey || options.baseUrl || options.model || options.apiType)
  ? { apiKey: options.apiKey, baseUrl: options.baseUrl, model: options.model, apiType: options.apiType }
  : undefined
```

### 修复后的流程

```
本地 AICO-Bot
  → WebSocket 发送 { apiKey, baseUrl, model, apiType: 'anthropic_passthrough' }
    → 远端 proxy
      → detectBackendType(baseUrl, 'anthropic_passthrough')
        → 命中第一个条件 → 返回 'anthropic'
          → 走 Anthropic 直接透传路径
            → 设置 ANTHROPIC_BASE_URL=http://IP:port
              → SDK 自动拼 /v1/messages → 正确
```

## AISource 的 apiType 类型定义

`src/shared/types/ai-sources.ts:175`

```typescript
apiType?: 'chat_completions' | 'responses' | 'anthropic_passthrough'
```

当 AISource 的 `provider` 为 `anthropic` 时，本地 `sdk-config.ts` 的 `resolveAnthropicPassthrough()` 会使用 `apiType: 'anthropic_passthrough'`。

## 修改的文件清单

| 文件 | 改动说明 |
|------|---------|
| `src/main/services/agent/send-message.ts` | WebSocket 选项新增 `apiType` 字段 |
| `packages/remote-agent-proxy/src/claude-manager.ts` | `detectBackendType` 接收 apiType 参数；`buildSdkOptions` 透传；`clientCredentials` 透传 |

## 当前状态

- 代码已修改，lint 通过
- 未打包测试
- 未提交 git（之前离线部署功能的大量改动也未提交）
