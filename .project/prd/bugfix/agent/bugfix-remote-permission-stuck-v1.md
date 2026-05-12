---
timestamp: 2026-05-12
status: in-progress
module: agent
type: bugfix
assignee: misakamikoto
priority: P0
---

# Bug 修复：远程 Agent 权限批准后卡死

## 问题描述

部分权限模式下，远程 Agent 执行破坏性命令时：
1. 本地 UI 正确弹出 `ToolPermissionCard`
2. 用户点击「允许」
3. 远程 Agent **卡死**，不再继续执行

## 根因分析

`agent.ts` IPC handler 发送权限响应时使用 `payload.id`：
```typescript
// src/main/ipc/agent.ts:204-208
remoteClient.send({
  type: data.approved ? 'tool:approve' : 'tool:reject',
  sessionId: data.conversationId,
  payload: { id: data.id, approved: data.approved },
});
```

但远程代理 `server.ts` 读取 `message.payload?.toolId`：
```typescript
// packages/remote-agent-proxy/src/server.ts:514
const toolId = message.payload?.toolId
if (!toolId) {
  console.log(`[${message.type}] Missing toolId in payload`)
  return  // ← 永远走到这里
}
```

**字段名不匹配**：本地发 `id`，远端读 `toolId`。`toolId` 始终为 `undefined`，直接返回。`pendingPermissions` Map 中的 promise 永远不会被 resolve，`canUseTool` 回调永久 await，SDK 子进程挂起。

## 技术方案

修改 `src/main/ipc/agent.ts` 的 payload 字段名，从 `id` 改为 `toolId`，与远程代理 `server.ts` 的 `tool:approve`/`tool:reject` handler 一致。

## 涉及文件

| 文件 | 修改内容 |
|------|---------|
| `src/main/ipc/agent.ts`（第 207 行） | `payload: { id: data.id, ... }` → `payload: { toolId: data.id, ... }` |

## 验收标准

- [ ] 远程 Agent 执行破坏性命令 → 本地弹出 ToolPermissionCard → 用户点击 Allow → 远程 Agent 继续执行（不再卡死）
- [ ] 用户点击 Deny → 远程 Agent 收到拒绝反馈并提供替代方案
- [ ] `npm run build` 通过
