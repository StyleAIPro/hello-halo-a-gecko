---
timestamp: 2026-05-12
status: in-progress
module: agent
type: bugfix
assignee: misakamikoto
priority: P0
---

# Bug 修复：远程 Agent 会话复用时权限回调丢失

## 问题描述

远程 Agent 在**首次创建会话**时，权限系统能正常工作（`canUseTool` 被设置，破坏性 Bash 命令触发权限请求，本地 UI 显示 `ToolPermissionCard`）。但当会话被**复用**（同一 conversationId 的后续消息）时，权限系统失效——SDK 子进程直接在远程服务器终端显示内置的权限确认提示，而不是将权限请求转发到本地 AICO-Bot UI。

用户被迫去远程服务器终端输入命令来批准/拒绝工具执行，完全违背了本地 UI 权限确认的设计初衷。

## 关联 PRD

| PRD | 关系 |
|-----|------|
| `bugfix-remote-permission-bypass-v1.md` | 前序修复：将远程代理从 `bypassPermissions` 改为 `default`，实现 `canUseTool` 回调和 WebSocket 权限协议（已完成，status: done） |
| `bugfix-remote-permission-not-working-v1.md` | 前序修复：添加诊断日志，发现会话复用时 `canUseTool` 被忽略（已完成，status: in-progress） |
| `bugfix-remote-permission-ui-v1.md` | 并行修复：修复 Deny 按钮不生效的 Bug（`server.ts` `tool:approve` handler 读取 `payload.approved`） |

本 PRD 聚焦于**会话复用**场景下权限回调丢失的问题，与 `bugfix-remote-permission-ui-v1.md` 互补。

## 根因分析

### 核心问题

`getOrCreateSession()` 方法在会话复用时，**直接返回已有 session 对象而不注入新的 `canUseTool` 回调**。`canUseTool` 仅在新会话创建时被设置到 `sdkOptions` 上（第 1430 行），复用路径（第 1401-1409 行）完全跳过了该逻辑。

### Bug 1：会话复用时 `canUseTool` 未注入

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts` 第 1401-1409 行

```typescript
} else {
  // Session is healthy and config matches, reuse it
  existing.config = requestConfig
  existing.configGeneration = this.configGeneration
  console.log(`[DIAG][${conversationId}] REUSING existing session...`)
  existing.lastUsedAt = Date.now()
  return existing.session  // ← canUseTool 完全被忽略
}
```

当 `streamChat()` 构建了新的 `canUseTool` 回调（第 1796-1850 行）并传入 `getOrCreateSession()` 时，如果会话被复用，该回调从未被设置到 SDK 会话上。SDK 子进程在 `canUseTool` 缺失时，回退到其内置的终端权限提示（`permissionMode: 'default'` 的默认行为）。

### Bug 2：`needsSessionRebuild()` 不检查 `permissionMode`

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts` 第 656-664 行

```typescript
function needsSessionRebuild(existing: V2SessionInfo, newConfig: SessionConfig): boolean {
  return (
    existing.config.model !== newConfig.model ||
    existing.config.workDir !== newConfig.workDir ||
    existing.config.apiKey !== newConfig.apiKey ||
    existing.config.baseUrl !== newConfig.baseUrl ||
    existing.config.contextWindow !== newConfig.contextWindow
    // ← permissionMode 未被检查
  )
}
```

如果会话是在 `permissionMode: 'bypassPermissions'` 的旧代码下创建的（部署新代码前），新代码的 `permissionMode: 'default'` 不会触发重建。`needsSessionRebuild` 返回 `false`，旧会话带着错误的权限模式被复用。

### Bug 3：`SessionConfig` 不包含 `permissionMode` 字段

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts` 第 300-306 行

```typescript
export interface SessionConfig {
  model?: string
  workDir?: string
  apiKey?: string
  baseUrl?: string
  contextWindow?: number
  // ← 缺少 permissionMode 字段
}
```

`storedConfig`（第 1557-1563 行）和 `requestConfig`（第 1372-1378 行）均未包含 `permissionMode`，因此即使 `needsSessionRebuild` 增加了 `permissionMode` 检查，两个值都会是 `undefined`，检查形同虚设。

## 技术方案

### 修复总览

三个 Bug 形成因果链：**Bug 3 导致 Bug 2 无效，Bug 2 导致 Bug 1 触发**。修复需按顺序进行：

```
Bug 3（SessionConfig 缺字段）
  → Bug 2（needsSessionRebuild 不检查）
    → Bug 1（会话复用不注入 canUseTool）
```

### 修复 1：`SessionConfig` 增加 `permissionMode` 字段

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts` 第 300-306 行

```typescript
// Before
export interface SessionConfig {
  model?: string
  workDir?: string
  apiKey?: string
  baseUrl?: string
  contextWindow?: number
}

// After
export interface SessionConfig {
  model?: string
  workDir?: string
  apiKey?: string
  baseUrl?: string
  contextWindow?: number
  permissionMode?: string  // 权限模式变化必须触发会话重建
}
```

### 修复 2：`needsSessionRebuild()` 增加 `permissionMode` 检查

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts` 第 656-664 行

```typescript
// Before
function needsSessionRebuild(existing: V2SessionInfo, newConfig: SessionConfig): boolean {
  return (
    existing.config.model !== newConfig.model ||
    existing.config.workDir !== newConfig.workDir ||
    existing.config.apiKey !== newConfig.apiKey ||
    existing.config.baseUrl !== newConfig.baseUrl ||
    existing.config.contextWindow !== newConfig.contextWindow
  )
}

// After
function needsSessionRebuild(existing: V2SessionInfo, newConfig: SessionConfig): boolean {
  return (
    existing.config.model !== newConfig.model ||
    existing.config.workDir !== newConfig.workDir ||
    existing.config.apiKey !== newConfig.apiKey ||
    existing.config.baseUrl !== newConfig.baseUrl ||
    existing.config.contextWindow !== newConfig.contextWindow ||
    existing.config.permissionMode !== newConfig.permissionMode  // 新增：权限模式变化触发重建
  )
}
```

### 修复 3：`storedConfig` / `requestConfig` 包含 `permissionMode`

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

需要在所有构建 `SessionConfig` 的位置添加 `permissionMode`：

#### 3a. 新建会话时的 `storedConfig`（第 1557-1563 行）

```typescript
// Before
const storedConfig: SessionConfig = {
  ...this.getCurrentConfig(),
  workDir: effectiveWorkDir,
  ...(credentials?.apiKey ? { apiKey: credentials.apiKey } : {}),
  ...(credentials?.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
  ...(credentials?.model ? { model: credentials.model } : {}),
}

// After
const storedConfig: SessionConfig = {
  ...this.getCurrentConfig(),
  workDir: effectiveWorkDir,
  ...(credentials?.apiKey ? { apiKey: credentials.apiKey } : {}),
  ...(credentials?.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
  ...(credentials?.model ? { model: credentials.model } : {}),
  permissionMode: sdkOptions.permissionMode,  // 存储 permissionMode
}
```

#### 3b. Resume 复用路径的 `storedConfig`（第 1351-1357 行）

```typescript
// Before
const storedConfig: SessionConfig = {
  ...this.getCurrentConfig(),
  workDir: effectiveWorkDir,
  ...(credentials?.apiKey ? { apiKey: credentials.apiKey } : {}),
  ...(credentials?.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
  ...(credentials?.model ? { model: credentials.model } : {}),
}

// After
const storedConfig: SessionConfig = {
  ...this.getCurrentConfig(),
  workDir: effectiveWorkDir,
  ...(credentials?.apiKey ? { apiKey: credentials.apiKey } : {}),
  ...(credentials?.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
  ...(credentials?.model ? { model: credentials.model } : {}),
  permissionMode: 'default',  // 当前版本始终使用 default
}
```

#### 3c. 常规复用路径的 `requestConfig`（第 1372-1378 行）

```typescript
// Before
const requestConfig: SessionConfig = {
  ...this.getCurrentConfig(),
  workDir: effectiveWorkDir,
  ...(credentials?.apiKey ? { apiKey: credentials.apiKey } : {}),
  ...(credentials?.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
  ...(credentials?.model ? { model: credentials.model } : {}),
}

// After
const requestConfig: SessionConfig = {
  ...this.getCurrentConfig(),
  workDir: effectiveWorkDir,
  ...(credentials?.apiKey ? { apiKey: credentials.apiKey } : {}),
  ...(credentials?.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
  ...(credentials?.model ? { model: credentials.model } : {}),
  permissionMode: 'default',  // 当前版本始终使用 default
}
```

### 修复 4：会话复用时强制重建（核心修复）

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts` 第 1401-1409 行

SDK V2 Session 对象在创建后不支持动态更新 `canUseTool`（会话内部通过 CLI 子进程通信，`canUseTool` 在创建时被序列化传递给子进程）。因此，当 `canUseTool` 被提供时，**必须重建会话**才能确保权限回调生效。

```typescript
// Before
} else {
  // Session is healthy and config matches, reuse it
  existing.config = requestConfig
  existing.configGeneration = this.configGeneration
  console.log(`[DIAG][${conversationId}] REUSING existing session...`)
  existing.lastUsedAt = Date.now()
  return existing.session
}

// After
} else {
  // Session is healthy and config matches, but check if canUseTool needs injection.
  // SDK V2 Session doesn't support dynamically updating canUseTool after creation —
  // the callback is serialized and passed to the CLI subprocess at session start.
  // If canUseTool is provided now but wasn't when the session was created (or vice versa),
  // we MUST rebuild to ensure the permission callback is active.
  if (canUseTool) {
    // Permission callback provided — force rebuild to inject it into the SDK subprocess.
    // This ensures destructive Bash detection and permission forwarding work on every request.
    if (this.activeSessions.has(conversationId)) {
      // Request in flight — defer rebuild (same logic as configChanged path)
      console.log(`[ClaudeManager][${conversationId}] canUseTool provided but request in flight, deferring rebuild`)
      existing.lastUsedAt = Date.now()
      return existing.session
    }
    console.log(`[ClaudeManager][${conversationId}] canUseTool provided, rebuilding session to inject permission callback`)
    this.cleanupSession(conversationId, 'canUseTool injection needed')
    // Fall through to create new session (with canUseTool)
  } else {
    // No canUseTool — safe to reuse (permission checks handled elsewhere or not needed)
    existing.config = requestConfig
    existing.configGeneration = this.configGeneration
    console.log(`[DIAG][${conversationId}] REUSING existing session (no canUseTool)`)
    existing.lastUsedAt = Date.now()
    return existing.session
  }
}
```

**设计决策说明**：

为什么选择"每次都重建"而不是"只在首次注入时重建"？

- `canUseTool` 是一个闭包，捕获了当前请求的 `onPermissionRequest` 和 `onAskUserQuestion`。这些回调的生命周期与单次 `streamChat()` 调用绑定。如果会话被多个请求共享（理论上不应，但代码中存在 `activeSessions` 防护），使用旧请求的闭包可能导致权限响应发送到错误的 WebSocket 连接。
- 每次重建的开销（进程退出等待 + 新进程启动 + MCP 初始化）通常在 1-3 秒内，对用户体验影响可接受。如果不重建，用户需要 SSH 到远程服务器手动输入权限确认，体验远差于多等几秒。
- `activeSessions` 防护确保请求进行中不会触发重建，避免中断正在执行的 SDK 流。

### 修复 5：Resume 路径也需要检查 `canUseTool`

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts` 第 1340-1365 行

Resume 路径在会话复用时也存在同样的问题——直接 `return existing.session` 而未检查 `canUseTool`。需要增加相同的检查逻辑：

```typescript
// Before (第 1340-1365 行)
} else if (effectiveResumeId) {
  console.log(`[ClaudeManager][${conversationId}] Resume requested, attempting session reuse...`)
  existing.lastUsedAt = Date.now()
  // ... update config ...
  return existing.session
}

// After
} else if (effectiveResumeId) {
  console.log(`[ClaudeManager][${conversationId}] Resume requested, attempting session reuse...`)
  // Check if canUseTool needs injection (same logic as non-resume reuse path)
  if (canUseTool) {
    if (this.activeSessions.has(conversationId)) {
      console.log(`[ClaudeManager][${conversationId}] Resume: canUseTool provided but request in flight, deferring rebuild`)
      existing.lastUsedAt = Date.now()
      return existing.session
    }
    console.log(`[ClaudeManager][${conversationId}] Resume: canUseTool provided, rebuilding session to inject permission callback`)
    this.cleanupSession(conversationId, 'canUseTool injection needed (resume)')
    // Fall through to create new session (without resume — old session is destroyed)
  } else {
    existing.lastUsedAt = Date.now()
    const storedConfig: SessionConfig = {
      ...this.getCurrentConfig(),
      workDir: effectiveWorkDir,
      ...(credentials?.apiKey ? { apiKey: credentials.apiKey } : {}),
      ...(credentials?.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
      ...(credentials?.model ? { model: credentials.model } : {}),
      permissionMode: 'default',
    }
    existing.config = storedConfig
    existing.configGeneration = this.configGeneration
    if (mcpToolSignature !== undefined) {
      existing.mcpToolSignature = mcpToolSignature
    }
    console.log(`[ClaudeManager][${conversationId}] Reusing existing V2 session for resume (will rebuild on failure)`)
    return existing.session
  }
}
```

## 涉及文件

| 文件 | 修改内容 |
|------|---------|
| `packages/remote-agent-proxy/src/claude-manager.ts`（第 300-306 行） | `SessionConfig` 接口增加 `permissionMode` 字段 |
| `packages/remote-agent-proxy/src/claude-manager.ts`（第 656-664 行） | `needsSessionRebuild()` 增加 `permissionMode` 比较条件 |
| `packages/remote-agent-proxy/src/claude-manager.ts`（第 1351-1365 行） | Resume 路径：`storedConfig` 增加 `permissionMode`；增加 `canUseTool` 检查 |
| `packages/remote-agent-proxy/src/claude-manager.ts`（第 1372-1378 行） | 常规复用路径：`requestConfig` 增加 `permissionMode` |
| `packages/remote-agent-proxy/src/claude-manager.ts`（第 1401-1409 行） | 常规复用路径：有 `canUseTool` 时强制重建会话 |
| `packages/remote-agent-proxy/src/claude-manager.ts`（第 1557-1563 行） | 新建会话路径：`storedConfig` 增加 `permissionMode` |

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 前序 PRD | `.project/prd/bugfix/agent/bugfix-remote-permission-bypass-v1.md` | 理解远程权限系统的完整改造方案（三层防线修复、WebSocket 协议） |
| 前序 PRD | `.project/prd/bugfix/agent/bugfix-remote-permission-not-working-v1.md` | 理解诊断日志设计和假设 2（会话复用未检查 permissionMode）的详细分析 |
| 前序 PRD | `.project/prd/bugfix/agent/bugfix-remote-permission-ui-v1.md` | 理解 Deny 按钮 Bug 修复（与本 PRD 并行，确保不冲突） |
| 模块设计文档 | `.project/modules/agent/features/permission-handling/design.md` | 理解本地权限处理架构（pending request 机制、超时、拒绝流程）作为参考 |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts`（第 300-306 行 `SessionConfig`；第 656-664 行 `needsSessionRebuild`；第 1282-1294 行 `getOrCreateSession` 签名；第 1340-1410 行会话复用路径；第 1557-1573 行 `storedConfig` 构建） | 理解会话复用判断逻辑、SessionConfig 类型定义、所有 config 构建位置 |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts`（第 1796-1855 行 `streamChat` 中 `canUseTool` 构建） | 理解 `canUseTool` 闭包如何捕获 `onPermissionRequest` 并传入 `getOrCreateSession` |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts`（第 970-987 行 `buildSdkOptions`） | 理解 `permissionMode: 'default'` 的设置位置和 `PRE_APPROVED_TOOLS` 的使用 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript 规范 |

## 验收标准

### Bug 1 修复：会话复用时 `canUseTool` 被正确注入

- [ ] 同一对话的**第二条消息**触发破坏性 Bash 命令时，本地 UI 弹出 `ToolPermissionCard`（而非在远程终端提示）
- [ ] 远程代理日志显示 `canUseTool provided, rebuilding session to inject permission callback`（确认走重建路径）
- [ ] 重建后日志显示 `SDK options: permissionMode=default, canUseTool=function, allowedTools=[...]`

### Bug 2 修复：`permissionMode` 变化触发会话重建

- [ ] 如果旧会话以 `permissionMode: 'bypassPermissions'` 创建，新请求以 `'default'` 发起时，`needsSessionRebuild` 返回 `true`，旧会话被清理
- [ ] 远程代理日志显示 `Config check - needsRebuild: true`，原因是 `permissionMode` 不匹配

### Bug 3 修复：`SessionConfig` 包含 `permissionMode`

- [ ] `SessionConfig` 类型定义包含 `permissionMode?: string`
- [ ] 新建会话后 `storedConfig` 包含 `permissionMode: 'default'`
- [ ] 常规复用路径 `requestConfig` 包含 `permissionMode: 'default'`

### Resume 路径修复

- [ ] Resume 复用时，如果 `canUseTool` 被提供，走重建路径而非直接复用
- [ ] Resume 重建路径日志显示 `Resume: canUseTool provided, rebuilding session to inject permission callback`

### 安全性回归测试

- [ ] 破坏性命令（`rm -rf`、`sudo`、`git push --force`）在会话复用时仍然触发权限请求
- [ ] 非破坏性命令（`git status`、`npm run build`）不触发权限弹窗
- [ ] 用户点击 Deny 后远程命令被阻断（依赖 `bugfix-remote-permission-ui-v1.md` 的修复）
- [ ] 用户点击 Allow 后远程命令正常执行

### 请求进行中防护

- [ ] 当有请求正在进行（`activeSessions` 中存在该 conversationId）时，不会触发重建
- [ ] 日志显示 `canUseTool provided but request in flight, deferring rebuild`
- [ ] 当前请求完成后，下一条消息会触发重建

### 已有功能不受影响

- [ ] 本地 Agent 权限确认系统不受影响（无回归）
- [ ] 远程 Agent AskUserQuestion 功能正常
- [ ] 非 `canUseTool` 场景（如 `canUseTool` 为 `undefined`）的会话复用行为不变
- [ ] 会话 resume（无 `canUseTool`）行为不变

### 构建验证

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
