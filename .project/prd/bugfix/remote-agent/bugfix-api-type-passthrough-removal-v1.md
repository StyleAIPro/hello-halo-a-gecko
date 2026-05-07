# Bugfix: 移除 apiType 前端透传，远端代理自动检测 + URL 归一化

**版本**: v1
**模块**: remote-agent
**功能**: 远端 Agent 代理路由
**日期**: 2026-04-25
**状态**: done
**指令人**: MoonSeeker

## 问题描述

远端 Agent 代理（`remote-agent-proxy`）的后端 API 类型（`apiType`）由前端 AICO-Bot 桌面端通过 WebSocket `claude:chat` 消息的 `options.apiType` 字段传递到远端。当使用裸主机 URL（如 `http://IP:port`）作为 API 地址时，远端代理无法正确归一化 URL，导致请求路由失败。

## 问题根因

### 1. 不必要的前后端耦合

前端将 AISource 配置中的 `apiType`（`chat_completions` / `responses` / `anthropic_passthrough`）通过 WebSocket 传递到远端代理，让远端据此判断后端类型。这违反了"远端应独立判断后端类型"的设计原则，增加了前后端协议的耦合度。

传递链路：
```
AISource.apiType (前端配置)
  → send-message.ts (executeRemoteMessage)
    → WebSocket chatOptions.apiType
      → remote-agent-proxy server.ts (接收)
        → ClaudeManager.buildSdkOptions(credentials.apiType)
          → ClaudeManager.detectBackendType(baseUrl, apiType)
```

### 2. URL 归一化缺失

远端 `buildSdkOptions()` 在 `openai_compat` 路由分支中直接将 `effectiveBaseUrl` 传给 `encodeBackendConfig()` 和 `getApiTypeFromUrl()`，没有先做 URL 归一化。当用户配置裸主机 URL（如 `http://192.168.1.100:8080`）时：

- `getApiTypeFromUrl()` 无法从 URL 后缀判断 API 类型，始终 fallback 到 `chat_completions`
- `encodeBackendConfig()` 将未归一化的裸 URL 直接编码进 API Key，导致后续请求发送到错误端点（如 `http://192.168.1.100:8080/` 而非 `http://192.168.1.100:8080/v1/chat/completions`）

本地区别于远程：本地 `sdk-config.ts` 在编码前已调用 `normalizeApiUrl()`，但远端代理缺少这一步。

## 修复方案

### 核心改动

移除 `apiType` 从前端到远端的整个传递链，改为远端完全自主检测 + URL 归一化。

### 改动细节

#### 1. `packages/remote-agent-proxy/src/types.ts`
- 从 `ChatOptions` 接口移除 `apiType` 字段

#### 2. `packages/remote-agent-proxy/src/claude-manager.ts`
- **`detectBackendType()`**: 移除 `apiType` 参数，仅基于 URL 模式和环境变量自动检测（保留 `REMOTE_AGENT_API_TYPE` 环境变量作为特殊场景覆盖）
- **`buildSdkOptions()`**: `credentials` 参数类型移除 `apiType` 字段
- **`buildSdkOptions()` openai_compat 分支**: 新增 `normalizeApiUrl()` 调用，对 `effectiveBaseUrl` 进行归一化后再传给 `getApiTypeFromUrl()` 和 `encodeBackendConfig()`。这确保裸主机 URL（如 `http://IP:port`）自动追加 `/v1/chat/completions`
- **`getOrCreateSession()` 调用处**: `clientCredentials` 构建逻辑移除 `apiType` 的读取和传递

#### 3. `src/main/services/agent/send-message.ts`
- `executeRemoteMessage()` 的 `sendChatWithStream()` 调用中，从 chatOptions 移除 `apiType: currentSource?.apiType`

### 检测逻辑（修复后）

远端代理的后端类型检测完全基于 URL 自动判断：

```typescript
detectBackendType(baseUrl?: string): 'anthropic' | 'openai_compat' {
  if (process.env.REMOTE_AGENT_API_TYPE === 'anthropic_passthrough') return 'anthropic'
  if (!baseUrl) return 'anthropic'  // 无自定义 URL = 默认 Anthropic
  if (baseUrl.includes('api.anthropic.com')) return 'anthropic'
  if (baseUrl.includes('/anthropic')) return 'anthropic'
  return 'openai_compat'  // 其余视为 OpenAI 兼容
}
```

API 子类型（`chat_completions` vs `responses`）由 `getApiTypeFromUrl()` 根据归一化后的 URL 后缀判断。

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `packages/remote-agent-proxy/src/types.ts` | 接口修改 | `ChatOptions` 移除 `apiType` 字段 |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 逻辑修改 | 移除 `apiType` 参数传递 + 新增 `normalizeApiUrl()` 调用 |
| `src/main/services/agent/send-message.ts` | 逻辑修改 | 远端消息发送移除 `apiType` 透传 |

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计文档 | `.project/modules/remote-agent/remote-agent-v1.md` | 理解远端代理模块的架构、WebSocket 消息流、OpenAI Compat Router 的角色 |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts` | 理解 `detectBackendType()` 检测逻辑和 `buildSdkOptions()` 路由分支 |
| 源码文件 | `packages/remote-agent-proxy/src/types.ts` | 理解 `ChatOptions` 接口定义和 WebSocket 消息结构 |
| 源码文件 | `packages/remote-agent-proxy/src/openai-compat-router/utils/url.ts` | 理解 `normalizeApiUrl()` 的归一化规则 |
| 源码文件 | `packages/remote-agent-proxy/src/openai-compat-router/server/api-type.ts` | 理解 `getApiTypeFromUrl()` 的 URL 后缀判断逻辑 |
| 源码文件 | `src/main/services/agent/send-message.ts` | 理解 `executeRemoteMessage()` 中 chatOptions 的构建和 WebSocket 发送流程 |
| 编码规范 | `docs/Development-Standards-Guide.md` | 遵循 TypeScript strict、接口命名等规范 |

## 验收标准

- [x] `ChatOptions` 接口（`types.ts`）不含 `apiType` 字段
- [x] `ClaudeManager.detectBackendType()` 仅接受 `baseUrl` 参数，不含 `apiType` 参数
- [x] `buildSdkOptions()` 的 `credentials` 参数类型不含 `apiType`
- [x] `buildSdkOptions()` openai_compat 分支在编码前调用 `normalizeApiUrl()` 归一化 URL
- [x] `getOrCreateSession()` 调用处 `clientCredentials` 不包含 `apiType`
- [x] `send-message.ts` 的 `executeRemoteMessage()` 不传递 `apiType` 到远端
- [x] 裸主机 URL（如 `http://IP:port`）能被正确归一化为 `http://IP:port/v1/chat/completions`
- [x] 含完整路径的 URL（如 `http://IP:port/v1/responses`）保持不变，API 类型正确识别
- [x] Anthropic 原生 URL（含 `api.anthropic.com` 或 `/anthropic`）仍走直连通道

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-25 | 初始 PRD（代码已完成，状态直接设为 done） | MoonSeeker |
