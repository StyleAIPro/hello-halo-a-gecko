---
timestamp: 2026-05-12
status: in-progress
module: agent
type: bugfix
assignee: misakamikoto
priority: P0
---

# Bug 修复：远程 Agent 权限请求 UI 展示与 Deny 逻辑

## 问题描述

远程 Agent 的破坏性命令权限请求无法在本地 AICO-Bot UI 中正确展示为用户可操作的权限确认卡片（Allow/Deny）。本地 Agent 的权限系统（`ToolPermissionCard` + `chat.store.handlePermissionRequest`）已完全正常工作，但远程 Agent 的权限请求在以下两个层面存在问题：

1. **Deny 按钮永远不生效**：用户点击 Deny 后，远程代理仍然收到 `approved=true`，命令照常执行
2. **UI 展示链路可能在部署/会话复用场景下断裂**：前次修复（`bugfix-remote-permission-bypass-v1`、`bugfix-remote-permission-not-working-v1`）已完成源码层面的完整权限链路改造和诊断日志，但根因尚未通过日志确认排除

## 根因分析

### 全链路追踪

远程 Agent 权限请求的完整链路如下：

```
远程 SDK canUseTool 回调
  (claude-manager.ts:1824-1845)
  │ 检测到破坏性 Bash 命令
  ▼
onPermissionRequest(id, toolName, toolInput)
  (server.ts:827-846)
  │ 存入 pendingPermissions Map
  │ 发送 WebSocket 消息: type='permission:request'
  ▼
WebSocket → 本地客户端
  (send-message-remote.ts:633-647)
  │ addHandler('permission:request', ...)
  │ 调用 sendToRenderer('agent:permission-request', ...)
  ▼
渲染进程 IPC 事件
  (preload/index.ts:853 → transport.ts:300 → api/index.ts:968)
  │ api.onAgentPermissionRequest(callback)
  ▼
App.tsx 事件订阅
  (App.tsx:327-337)
  │ 调用 handlePermissionRequest(data)
  ▼
chat.store.ts handlePermissionRequest
  (chat.store.ts:2498-2542)
  │ 设置 session.pendingToolPermission = { id, toolName, toolInput, status: 'active' }
  ▼
MessageList.tsx 渲染
  (MessageList.tsx:383-388)
  │ 条件: pendingToolPermission.status === 'active' && onResolveToolPermission
  │ 渲染 <ToolPermissionCard permission={...} onResolve={...} />
  ▼
ToolPermissionCard.tsx
  (ToolPermissionCard.tsx:48-52, 162-176)
  │ 用户点击 Allow → onResolve(true)
  │ 用户点击 Deny → onResolve(false)
  ▼
chat.store.ts resolveToolPermission
  (chat.store.ts:2546-2574)
  │ 调用 api.resolveAgentPermission({ id, approved, conversationId })
  ▼
IPC: agent:resolve-permission
  (agent.ts:196-224)
  │ 远程会话检测 → remoteClient.send({ type: 'tool:approve', payload: { id, approved } })
  ▼
远程代理 server.ts tool:approve handler
  (server.ts:530-537)
  │ ★ BUG: const approved = message.type === 'tool:approve'  → 永远为 true
  │ pendingPermissions.resolve(approved)  → 永远 resolve(true)
  ▼
claude-manager.ts canUseTool 继续
  │ 收到 approved=true → { behavior: 'allow' }
  │ 命令被执行
```

### 已确认的代码 Bug

#### Bug 1（确定）：远程代理 `tool:approve` handler 忽略 payload.approved

**文件**：`packages/remote-agent-proxy/src/server.ts` 第 534 行

```typescript
const approved = message.type === 'tool:approve'
```

本地客户端的 `agent:resolve-permission` handler（`agent.ts` 第 204-208 行）**始终**发送 `type: 'tool:approve'`，无论用户是点击了 Allow 还是 Deny。`approved` 的值放在 `payload.approved` 中（true 或 false）。

但远程代理的 `tool:approve` handler 只检查 `message.type === 'tool:approve'`（永远为 true），完全忽略 `payload.approved`。结果：

- 用户点击 Allow → `approved: true` → 远程收到 `true` → 命令执行（正确）
- 用户点击 Deny → `approved: false` → 远程收到 `true` → **命令仍然执行**（Bug！）

**修复方案**：改为读取 `payload.approved`：

```typescript
// Before (line 534)
const approved = message.type === 'tool:approve'

// After
const approved = message.payload?.approved !== false
```

#### Bug 2（确定）：本地 IPC handler 未发送 `tool:reject` 消息

**文件**：`src/main/ipc/agent.ts` 第 196-210 行

当用户点击 Deny（`approved: false`）时，本地 handler 仍然发送 `type: 'tool:approve'`。虽然远程代理的 `pendingPermissions` 路由也能匹配到（它检查 `pendingPermissions.get(toolId)`），但消息类型语义错误，且与 HyperSpace 工具的 `tool:approve` / `tool:reject` 约定不一致。

**修复方案**：当 `approved === false` 时发送 `type: 'tool:reject'`：

```typescript
// Before (line 204-208)
remoteClient.send({
  type: 'tool:approve',
  sessionId: data.conversationId,
  payload: { id: data.id, approved: data.approved },
});

// After
remoteClient.send({
  type: data.approved ? 'tool:approve' : 'tool:reject',
  sessionId: data.conversationId,
  payload: { id: data.id, approved: data.approved },
});
```

### 可能存在的链路断裂点（需通过诊断日志确认）

以下问题已被前次 PRD（`bugfix-remote-permission-not-working-v1`）列为假设并添加了诊断日志，但尚未收到用户反馈的日志结论：

1. **部署缓存**（假设 1）：`buildTimestamp` 未变化导致旧代码运行，权限系统源码修复未部署到远程服务器
2. **会话复用**（假设 2）：`needsSessionRebuild` 不检查 `permissionMode`，旧会话可能复用了 `bypassPermissions` 模式
3. **SDK 子进程**（假设 3）：`canUseTool` 根本未被 SDK 调用（SDK 子进程内部 `checkPermissions` 直接返回 `allow`）
4. **canUseTool 传递链路**（假设 4）：会话复用时 `canUseTool` 未被注入到已有会话

本 PRD 的代码修复（Bug 1 + Bug 2）确保即使权限请求成功到达前端并得到用户响应，Deny 操作也能正确生效。部署/会话/SDK 层面的问题需通过诊断日志定位，属于 `bugfix-remote-permission-not-working-v1` 的 Phase 2 范畴。

## 技术方案

### 修复 1：远程代理 `tool:approve` handler 读取 payload.approved

**文件**：`packages/remote-agent-proxy/src/server.ts`

将第 534 行的硬编码改为从 payload 读取实际审批结果：

```typescript
// Line 534: Before
const approved = message.type === 'tool:approve'

// Line 534: After
const approved = message.payload?.approved !== false
```

使用 `!== false` 而非 `=== true` 是为了兼容旧版客户端（可能未发送 `approved` 字段，此时默认允许）。

### 修复 2：本地 IPC handler 发送正确的消息类型

**文件**：`src/main/ipc/agent.ts`

在 `agent:resolve-permission` handler 中，根据 `approved` 值发送 `tool:approve` 或 `tool:reject`：

```typescript
// Line 204-208: Before
remoteClient.send({
  type: 'tool:approve',
  sessionId: data.conversationId,
  payload: { id: data.id, approved: data.approved },
});

// Line 204-209: After
remoteClient.send({
  type: data.approved ? 'tool:approve' : 'tool:reject',
  sessionId: data.conversationId,
  payload: { id: data.id, approved: data.approved },
});
```

### 不需要修改的部分

以下部分经审查已正确实现，无需修改：

| 组件 | 状态 | 说明 |
|------|------|------|
| 远程代理 `permissionMode: 'default'` | 已修复 | `claude-manager.ts:980` |
| 远程代理 `PRE_APPROVED_TOOLS` 拆分 | 已修复 | `claude-manager.ts:338-358` |
| 远程代理 `isDestructiveBashCommand()` | 已修复 | `claude-manager.ts:379-410` |
| 远程代理 `canUseTool` 回调 | 已修复 | `claude-manager.ts:1796-1850` |
| 远程代理 `onPermissionRequest` 发送 | 已修复 | `server.ts:827-846` |
| 远程代理 `pendingPermissions` Map | 已修复 | `server.ts:51-54` |
| WebSocket `permission:request` 消息类型 | 已定义 | `ws-types.ts:76`, `types.ts:93` |
| `send-message-remote.ts` 权限转发 | 已修复 | `send-message-remote.ts:633-647` |
| `sendToRenderer` 包含 conversationId | 正确 | `helpers.ts:396-417` |
| preload `onAgentPermissionRequest` | 已暴露 | `preload/index.ts:853` |
| transport `onEvent` 映射 | 已配置 | `transport.ts:300` |
| api `onAgentPermissionRequest` | 已导出 | `api/index.ts:968` |
| `App.tsx` 事件订阅 → `handlePermissionRequest` | 已连接 | `App.tsx:327-337` |
| `chat.store.ts handlePermissionRequest` | 正确设置 `pendingToolPermission` | `chat.store.ts:2498-2542` |
| `MessageList.tsx` 渲染 `ToolPermissionCard` | 正确条件渲染 | `MessageList.tsx:383-388` |
| `ChatView.tsx` 传递 `pendingToolPermission` | 正确传递 | `ChatView.tsx:354-358` |
| `ToolPermissionCard.tsx` Allow/Deny 按钮 | 正确回调 `onResolve` | `ToolPermissionCard.tsx:162-176` |
| `chat.store.ts resolveToolPermission` | 正确调用 API | `chat.store.ts:2546-2574` |
| `agent.ts` 远程会话检测和 WebSocket 转发 | 已实现（有 Bug 2） | `agent.ts:200-210` |

## 涉及文件

| 文件 | 修改内容 |
|------|---------|
| `packages/remote-agent-proxy/src/server.ts`（第 534 行） | `tool:approve` handler 改为读取 `payload.approved` 而非硬编码 `true` |
| `src/main/ipc/agent.ts`（第 204-208 行） | `agent:resolve-permission` handler 根据 `approved` 值发送 `tool:approve` 或 `tool:reject` |

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 前次 PRD | `.project/prd/bugfix/agent/bugfix-remote-permission-bypass-v1.md` | 理解远程权限系统的完整改造方案（三层防线修复、WebSocket 协议） |
| 前次 PRD | `.project/prd/bugfix/agent/bugfix-remote-permission-not-working-v1.md` | 理解诊断日志的设计和四种假设（部署缓存、会话复用、SDK 子进程、回调传递） |
| 模块设计文档 | `.project/modules/agent/features/permission-handling/design.md` | 理解权限处理架构（pending request 机制、超时、拒绝流程） |
| 功能 changelog | `.project/modules/agent/features/permission-handling/changelog.md` | 了解权限系统四次迭代的变更历史（BUG-001 到 BUG-004） |
| 源码文件 | `packages/remote-agent-proxy/src/server.ts`（第 515-541 行） | `tool:approve` / `tool:reject` handler 的完整逻辑，理解 pendingPermissions 和 pendingHyperSpaceTools 的路由 |
| 源码文件 | `src/main/ipc/agent.ts`（第 195-224 行） | `agent:resolve-permission` handler 的远程 WebSocket 转发逻辑 |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts`（第 1824-1850 行） | 远程 `canUseTool` 回调中破坏性 Bash 检测和 `onPermissionRequest` 调用 |
| 源码文件 | `src/main/services/agent/send-message-remote.ts`（第 633-647 行） | 远程权限请求到渲染进程的转发逻辑 |
| 源码文件 | `src/renderer/stores/chat.store.ts`（第 2497-2574 行） | 前端 `handlePermissionRequest` 和 `resolveToolPermission` 的完整实现 |
| 源码文件 | `src/renderer/components/chat/ToolPermissionCard.tsx` | 权限确认卡片的 UI 组件（Allow/Deny 按钮和键盘快捷键） |
| 源码文件 | `src/renderer/components/chat/MessageList.tsx`（第 383-388 行） | `ToolPermissionCard` 的条件渲染逻辑 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript 规范 |

## 验收标准

### Deny 功能修复

- [ ] 远程 Agent 执行破坏性命令（如 `rm -rf /tmp/test.txt`）时，本地 UI 弹出 `ToolPermissionCard`
- [ ] `ToolPermissionCard` 显示工具名称（Bash）和命令预览
- [ ] 用户点击 **Deny** 后，远程命令被阻断，Agent 收到拒绝反馈
- [ ] 用户点击 **Allow** 后，远程命令正常执行（回归测试，确保不受影响）

### UI 展示一致性

- [ ] 远程权限确认卡片与本地权限确认卡片外观完全一致（使用同一个 `ToolPermissionCard` 组件）
- [ ] 卡片显示时间戳
- [ ] Allow 按钮显示 "Allow (Y)"，Deny 按钮显示 "Deny (N)"
- [ ] 键盘快捷键 Y/N 正常工作
- [ ] 用户点击后卡片状态更新为 "Approved" 或 "Denied"
- [ ] 用户停止生成时，权限请求被正确清理

### 已有功能不受影响

- [ ] 本地 Agent 权限确认系统不受影响（无回归）
- [ ] 远程 Agent AskUserQuestion 功能正常
- [ ] 远程 HyperSpace 工具审批正常（`pendingHyperSpaceTools` 路由不受影响）
- [ ] 非破坏性命令（`git status`、`npm run build`）不触发权限弹窗

### 构建验证

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
