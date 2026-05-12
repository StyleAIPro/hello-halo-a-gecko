---
timestamp: 2026-05-11
status: done
module: agent
type: bugfix
assignee: misakamikoto
priority: P0
---

# Bug 修复：远程 Agent 权限系统完全失效

## 问题描述

远程 Agent（通过 `remote-agent-proxy` 在远程服务器上运行）完全没有权限检查机制。Agent 可以在远程服务器上执行任意破坏性命令（删除文件、安装恶意软件、修改系统配置等），用户无法在本地 UI 中收到任何权限确认请求。

本地 Agent 的权限系统已通过三次迭代修复完成（`bugfix-permission-mode-v1`、`bugfix-permission-allowed-tools-v1`、`bugfix-permission-risk-tier-v1`），但远程代理（`packages/remote-agent-proxy/`）拥有完全独立且彻底失效的权限实现。

### 安全影响

远程 Agent 拥有对远程服务器的完全 Shell 权限，无任何用户确认环节。一旦 Agent 被提示词注入或模型产生危险行为，用户无法在操作执行前介入，可能导致：
- 远程服务器数据被删除
- 恶意软件被安装
- 系统配置被篡改
- 敏感文件被读取或上传

## 根因分析

### 三层防线全部失效

远程代理的权限系统存在以下问题：

#### 1. `permissionMode: 'bypassPermissions'` — SDK 权限模式被绕过

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts` 第 922 行

```typescript
permissionMode: 'bypassPermissions',
```

SDK 的所有内置权限检查被完全禁用，`canUseTool` 回调即使被调用也只是形式。

#### 2. `dangerously-skip-permissions` — CLI 层面显式跳过权限

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts` 第 923-925 行

```typescript
extraArgs: {
  'dangerously-skip-permissions': null
},
```

传递给 SDK CLI 子进程，从进程层面禁用权限检查。

#### 3. `canUseTool` 对非 AskUserQuestion 工具无条件放行

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts` 第 1728-1731 行

```typescript
const askUserQuestionCanUseTool = onAskUserQuestion ? async (toolName, input, opts) => {
  if (toolName !== 'AskUserQuestion') {
    return { behavior: 'allow' as const, updatedInput: input }  // 所有工具自动放行
  }
  // ... 仅处理 AskUserQuestion
} : undefined
```

`canUseTool` 回调只处理 `AskUserQuestion`，对 Bash、Write、Edit 等所有其他工具直接返回 `allow`。

#### 4. `allowedTools` 预授权了所有高风险工具

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts` 第 337-346 行

```typescript
const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'Skill', 'Task'
]
```

Bash、Write、Edit 等高风险工具被列入 SDK 的 `allowedTools`（第 926 行），SDK 将这些工具视为已获用户批准，根本不触发 `canUseTool` 回调。

#### 5. 权限请求无法转发到本地 UI

远程代理没有实现 `permission:request` / `permission:response` 的 WebSocket 消息协议。`ws-types.ts` 的 `ServerMessage` 和 `ClientMessage` 类型中没有权限相关的消息类型。

#### 6. `requiresApproval: false` 硬编码

**文件**：`src/main/services/agent/send-message-remote.ts` 第 390 行

```typescript
requiresApproval: false,
```

即使远程代理发送了权限请求，本地客户端在转发工具调用事件时也硬编码 `requiresApproval: false`，前端不会展示权限确认 UI。

### 与本地 Agent 修复的对比

| 修复项 | 本地 Agent | 远程 Agent |
|--------|-----------|-----------|
| `permissionMode` | `'default'` (已修复) | `'bypassPermissions'` (未修复) |
| `dangerously-skip-permissions` | 已移除 | 仍存在 |
| `allowedTools` | `PRE_APPROVED_TOOLS` (仅安全工具) | 全部工具 (含 Bash/Write/Edit) |
| `canUseTool` 回调 | 智能分级 (破坏性 Bash 检测) | 无条件放行 |
| 权限请求转发 | 直接调用 `sendToRenderer` | 无转发机制 |
| UI 权限确认 | `ToolPermissionCard` + `chat.store` | 不展示 |

## 技术方案

### 方案概述

参照本地 Agent 的权限系统实现，对远程代理进行对等修复。核心思路：

1. **远程代理**：启用 SDK 权限检查 + 实现破坏性 Bash 命令检测 + 通过 WebSocket 转发权限请求
2. **本地客户端**：接收远程代理的权限请求 → 转发到前端 UI → 用户确认后将结果回传
3. **WebSocket 协议**：新增 `permission:request` / `permission:response` 消息类型

### 步骤 1：修改远程代理 SDK 配置

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

#### 1.1 修改 `permissionMode`（第 922 行）

```typescript
// Before
permissionMode: 'bypassPermissions',

// After
permissionMode: 'default',
```

#### 1.2 移除 `dangerously-skip-permissions`（第 923-925 行）

```typescript
// Before
extraArgs: {
  'dangerously-skip-permissions': null
},

// After
extraArgs: {},
```

#### 1.3 拆分 `DEFAULT_ALLOWED_TOOLS`（第 337-346 行）

参照本地 `system-prompt.ts` 的 `PRE_APPROVED_TOOLS` 语义，将远程代理的工具列表拆分为：

```typescript
/** 预授权工具（SDK allowedTools）— 仅安全/只读工具 */
const PRE_APPROVED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  // 文件操作工具 — 在 git 工作区内可撤销
  'Write',
  'Edit',
  'Create',
  'MultiEdit',
  'NotebookEdit',
  // 任务管理 — 不涉及文件系统变更
  'TodoWrite',
]

/** 可用工具列表（用于日志和验证） */
const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'Skill', 'Task'
]
```

修改 SDK 配置（第 926 行）：

```typescript
// Before
allowedTools: [...DEFAULT_ALLOWED_TOOLS],

// After
allowedTools: [...PRE_APPROVED_TOOLS],
```

### 步骤 2：在远程代理中实现破坏性 Bash 检测

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

将本地 `permission-handler.ts` 中的 `DESTRUCTIVE_COMMANDS`、`DESTRUCTIVE_SUBCOMMANDS`、`isDestructiveBashCommand()` 复制到远程代理（远程代理是独立进程，无法 import 本地模块）。实现必须保持与本地完全一致的检测逻辑。

### 步骤 3：扩展 `canUseTool` 回调

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`（第 1728-1760 行）

当前 `askUserQuestionCanUseTool` 仅处理 `AskUserQuestion`，需要扩展为同时处理权限请求。修改函数名和签名：

```typescript
// Before: 只处理 AskUserQuestion
const askUserQuestionCanUseTool = onAskUserQuestion ? async (toolName, input, opts) => {
  if (toolName !== 'AskUserQuestion') {
    return { behavior: 'allow', updatedInput: input }
  }
  // ... handle AskUserQuestion
} : undefined

// After: 同时处理权限请求和 AskUserQuestion
const toolPermissionCanUseTool = onAskUserQuestion ? async (
  toolName: string,
  input: Record<string, unknown>,
  opts: { signal: AbortSignal }
) => {
  // 1. AskUserQuestion：复用已有逻辑
  if (toolName === 'AskUserQuestion') {
    // ... 保留现有 AskUserQuestion 处理逻辑不变
  }

  // 2. Bash：智能检测破坏性命令
  if (toolName === 'Bash') {
    const command = String(input.command || '');
    if (!isDestructiveBashCommand(command)) {
      // 非破坏性命令自动放行
      return { behavior: 'allow', updatedInput: input }
    }
    // 破坏性命令 → 发送权限请求到本地 UI
    const id = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const approved = await onPermissionRequest(id, toolName, input)
    return approved
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', updatedInput: { ...input, _permissionDenied: true } }
  }

  // 3. MCP 工具：自动放行
  if (toolName.startsWith('mcp__')) {
    return { behavior: 'allow', updatedInput: input }
  }

  // 4. 其他所有工具：自动放行
  return { behavior: 'allow', updatedInput: input }
} : undefined
```

其中 `onPermissionRequest` 是新增的回调函数（与 `onAskUserQuestion` 并列，由 `server.ts` 提供），用于通过 WebSocket 转发权限请求并等待用户响应。

### 步骤 4：新增 WebSocket 权限消息协议

**文件**：`packages/remote-agent-proxy/src/server.ts`

参照 `ask:question` / `ask:answer` 模式（第 526-541 行、第 790-807 行），新增权限请求/响应处理。

#### 4.1 新增 `pendingPermissions` 注册表

```typescript
private pendingPermissions = new Map<string, {
  resolve: (approved: boolean) => void;
  reject: (reason?: unknown) => void;
}>();
```

#### 4.2 新增 `permission:response` handler（接收本地 UI 的审批结果）

```typescript
} else if (message.type === 'permission:response') {
  const permissionId = message.payload?.id
  const approved = message.payload?.approved
  if (!permissionId) {
    console.log('[permission:response] Missing id in payload')
    return
  }
  const pending = this.pendingPermissions.get(permissionId)
  if (pending) {
    this.pendingPermissions.delete(permissionId)
    console.log(`[permission:response] Resolving permission ${permissionId}: ${approved ? 'APPROVED' : 'DENIED'}`)
    pending.resolve(approved)
  } else {
    console.log(`[permission:response] No pending permission found for id: ${permissionId}`)
  }
}
```

#### 4.3 新增 `onPermissionRequest` 回调（发送权限请求到本地 UI）

在 `handleClaudeChat` 中，与 `onAskUserQuestion`（第 790-807 行）并列新增：

```typescript
// Permission request handler — forward to AICO-Bot client, wait for user response
const onPermissionRequest = (id: string, toolName: string, input: Record<string, unknown>) => {
  return new Promise<boolean>((resolve, reject) => {
    this.pendingPermissions.set(id, { resolve, reject })
    // Send permission request to AICO-Bot client
    this.sendMessage(ws, {
      type: 'permission:request',
      sessionId,
      data: { id, toolName, toolInput: input }
    })
    // 10 minute timeout (matches AskUserQuestion timeout)
    setTimeout(() => {
      if (this.pendingPermissions.has(id)) {
        this.pendingPermissions.delete(id)
        reject(new Error('Permission request timeout'))
      }
    }, 10 * 60 * 1000)
  })
}
```

#### 4.4 将 `onPermissionRequest` 传递给 `claude-manager`

修改 `claude-manager.ts` 的 `startConversation` 方法签名，新增 `onPermissionRequest` 参数，并将其传入 `canUseTool` 回调构建逻辑。

#### 4.5 清理断连时的 pending 权限请求

在已有的断连清理逻辑中（参照第 995-998 行 `pendingAskQuestions` 清理），新增 `pendingPermissions` 清理：

```typescript
for (const [id, pending] of this.pendingPermissions) {
  pending.reject(new Error('Client disconnected'))
}
this.pendingPermissions.clear()
```

### 步骤 5：更新 WebSocket 消息类型

**文件**：`src/main/services/remote/ws/ws-types.ts`

#### 5.1 `ClientMessage` 类型新增 `permission:response`

```typescript
export interface ClientMessage {
  type:
    | 'auth'
    | 'claude:chat'
    // ... existing types
    | 'ask:answer'
    | 'permission:response'  // 新增
    | 'task:list'
    // ...
}
```

#### 5.2 `ServerMessage` 类型新增 `permission:request`

```typescript
export interface ServerMessage {
  type:
    | 'auth:success'
    | 'auth:failed'
    // ... existing types
    | 'ask:question'
    | 'permission:request'  // 新增
    | 'task:update'
    // ...
}
```

### 步骤 6：本地客户端接收并转发权限请求

**文件**：`src/main/services/agent/send-message-remote.ts`

参照 `ask:question` 的处理模式（第 622-630 行），新增 `permission:request` handler：

```typescript
// Permission request forwarding — remote agent asks user for tool permission
addHandler('permission:request', (data) => {
  if (data.sessionId === effectiveSessionId) {
    log.debug(
      `Permission request: id=${data.data.id}, tool=${data.data.toolName}`,
    );
    sendToRenderer('agent:permission-request', spaceId, conversationId, {
      id: data.data.id,
      toolName: data.data.toolName,
      toolInput: data.data.toolInput,
      timestamp: Date.now(),
    });
  }
});
```

**无需额外修改**：本地 UI 的权限确认流程（`chat.store.ts` → `ToolPermissionCard.tsx` → IPC `agent:resolve-permission`）已在本地 Agent 修复中完成。`agent.ts` 第 197-223 行的 `agent:resolve-permission` handler 已支持远程会话的 WebSocket 转发（通过 `tool:approve` 消息类型），但远程代理当前不处理 `tool:approve` 消息。

### 步骤 7：远程代理处理权限审批结果

**文件**：`packages/remote-agent-proxy/src/server.ts`

当前 `tool:approve` handler（约第 500-525 行）仅处理 `HyperSpace` 工具的审批。需要确保 `permission:response` 处理器（步骤 4.2）正确接收本地 UI 通过 `tool:approve` 消息类型发回的审批结果。

**备选方案**：如果 `tool:approve` 的 payload 格式与 `permission:response` 不兼容，可以在 `server.ts` 中将 `tool:approve` 也路由到 `pendingPermissions` 的 resolve 逻辑。具体取决于本地 `agent.ts` 第 204-208 行发送的 payload 格式：

```typescript
// agent.ts 发送格式
remoteClient.send({
  type: 'tool:approve',
  sessionId: data.conversationId,
  payload: { id: data.id, approved: data.approved },
});
```

建议将远程代理的 `tool:approve` handler 扩展为同时检查 `pendingPermissions`：

```typescript
// 在现有 tool:approve handler 的 "No pending tool found" 分支之前新增：
} else {
  // Check if this is a permission request response
  const permissionPending = this.pendingPermissions.get(toolId);
  if (permissionPending) {
    this.pendingPermissions.delete(toolId);
    console.log(`[tool:approve] Resolving permission ${toolId}: approved=${message.payload?.approved}`);
    permissionPending.resolve(message.payload?.approved);
  } else {
    console.log(`[${message.type}] No pending tool or permission found for ID: ${toolId}`);
  }
}
```

### 步骤 8：修复 `requiresApproval` 硬编码

**文件**：`src/main/services/agent/send-message-remote.ts` 第 390 行

```typescript
// Before
requiresApproval: false,

// After
requiresApproval: data.data?.requiresApproval ?? false,
```

当远程代理发送工具调用时附带 `requiresApproval` 标记（例如对破坏性 Bash 命令），本地客户端应正确传递该标记。但由于权限请求现在通过独立的 `permission:request` WebSocket 消息发送，`requiresApproval` 字段可作为辅助信息传递，非必须。

## 涉及文件

### 实际修改

| 文件 | 修改内容 |
|------|---------|
| `packages/remote-agent-proxy/src/claude-manager.ts` | `permissionMode` 改 `'default'`；移除 `dangerously-skip-permissions`；拆分 `DEFAULT_ALLOWED_TOOLS` 为 `PRE_APPROVED_TOOLS`；新增 `isDestructiveBashCommand()`；扩展 `canUseTool` 回调支持 Bash 智能检测和权限请求转发 |
| `packages/remote-agent-proxy/src/server.ts` | 新增 `pendingPermissions` 注册表；新增 `permission:response` handler；新增 `onPermissionRequest` 回调；扩展现有 `tool:approve` handler 支持 `pendingPermissions`；断连清理逻辑增加 `pendingPermissions` |
| `src/main/services/remote/ws/ws-types.ts` | `ClientMessage` 新增 `'permission:response'`；`ServerMessage` 新增 `'permission:request'` |
| `src/main/services/agent/send-message-remote.ts` | 新增 `permission:request` 事件 handler → 转发到渲染进程 |
| `packages/remote-agent-proxy/src/types.ts` | `ServerMessage` 新增 `'permission:request'` |

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 前次 PRD | `.project/prd/bugfix/agent/bugfix-permission-risk-tier-v1.md` | 理解本地 Agent 权限系统的最终实现（智能 Bash 检测、三级风险模型） |
| 前次 PRD | `.project/prd/bugfix/agent/bugfix-permission-allowed-tools-v1.md` | 理解 PRE_APPROVED_TOOLS 拆分逻辑和远程转发修复 |
| 模块设计文档 | `.project/modules/agent/features/permission-handling/design.md` | 理解权限处理架构、pending request 机制 |
| 功能 changelog | `.project/modules/agent/features/permission-handling/changelog.md` | 了解权限系统最近变更 |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts`（第 337-346、910-931、1728-1760 行） | 远程代理当前权限配置和 canUseTool 实现 |
| 源码文件 | `packages/remote-agent-proxy/src/server.ts`（第 45-50、520-541、790-807、990-1000 行） | WebSocket 服务端：pending 注册表、ask:question/ask:answer 模式、断连清理 |
| 源码文件 | `src/main/services/agent/permission-handler.ts` | 本地权限处理实现：`isDestructiveBashCommand()`、`createCanUseTool()`、pending 权限注册表 |
| 源码文件 | `src/main/services/remote/ws/ws-types.ts` | WebSocket 消息类型定义（ServerMessage、ClientMessage） |
| 源码文件 | `src/main/services/agent/send-message-remote.ts`（第 380-400、620-630 行） | 本地客户端远程消息转发、ask:question handler 模式 |
| 源码文件 | `src/main/ipc/agent.ts`（第 195-224 行） | IPC 权限解析 handler（已支持远程 WebSocket 转发） |
| 源码文件 | `src/main/services/agent/sdk-config.ts`（第 710-730 行） | 本地 SDK 配置参考（PRE_APPROVED_TOOLS 用法） |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript 规范、IPC 通道规范 |

## 验收标准

### 破坏性命令权限确认

- [ ] 远程 Agent 执行 `rm` 命令时，本地 UI 弹出权限确认弹窗
- [ ] 远程 Agent 执行 `sudo` 命令时，本地 UI 弹出权限确认弹窗
- [ ] 远程 Agent 执行 `git push --force` 时，本地 UI 弹出权限确认弹窗
- [ ] 远程 Agent 执行 `git clean` 时，本地 UI 弹出权限确认弹窗
- [ ] 远程 Agent 执行 `chmod` / `chown` 时，本地 UI 弹出权限确认弹窗
- [ ] 远程 Agent 执行 `npm uninstall` 时，本地 UI 弹出权限确认弹窗

### 非破坏性命令自动放行

- [ ] 远程 Agent 执行 `npm run build` 不触发权限确认弹窗
- [ ] 远程 Agent 执行 `git status` 不触发权限确认弹窗
- [ ] 远程 Agent 执行 `git add` / `git commit` 不触发权限确认弹窗
- [ ] 远程 Agent 执行 `ls` / `cat` / `echo` 不触发权限确认弹窗
- [ ] 远程 Agent 执行 `node` / `npx` / `tsc` 不触发权限确认弹窗

### 文件操作自动放行

- [ ] 远程 Agent Write 工具不触发权限确认弹窗
- [ ] 远程 Agent Edit 工具不触发权限确认弹窗

### 权限确认交互

- [ ] 用户点击"Allow"后，远程命令正常执行
- [ ] 用户点击"Deny"后，远程命令被阻断，Agent 收到拒绝反馈并调整行为
- [ ] 权限请求超时后自动拒绝（10 分钟），Agent 不会永久挂起
- [ ] 用户停止生成时，远程代理的待处理权限请求被正确清理

### 已有功能不受影响

- [ ] 远程 Agent 的 AskUserQuestion 功能正常
- [ ] 本地 Agent 的权限确认系统不受影响（无回归）
- [ ] 本地 Agent 的破坏性 Bash 检测不受影响
- [ ] 远程 MCP 工具调用正常（自动放行）
- [ ] 远程文件系统操作（fs:*）正常
- [ ] 远程任务管理（task:*）正常

### 构建验证

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] `npm run build:offline-bundle` 通过（远程代理独立构建）
