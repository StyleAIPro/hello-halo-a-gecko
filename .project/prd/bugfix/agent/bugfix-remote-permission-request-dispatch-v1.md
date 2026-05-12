---
timestamp: 2026-05-12
status: in-progress
module: agent
type: bugfix
assignee: misakamikoto
priority: P0
---

# Bug 修复：远程 Agent 权限请求消息未被本地 WebSocket 客户端分发

## 问题描述

部分权限模式下，远程 Agent 执行破坏性命令时，本应弹出权限确认弹窗让用户选择 Allow/Deny。但实际上模型在发送权限请求后直接卡死，用户看不到任何权限弹窗，pending promise 直到 10 分钟超时。

## 根因分析

`remote-ws-client.ts` 的 `handleMessage()` 方法使用 `switch(message.type)` 分发 WebSocket 消息到 EventEmitter。`permission:request` 类型**完全缺失**于 switch 语句中：

```typescript
// remote-ws-client.ts:289-429 — 缺少 permission:request case
switch (message.type) {
  case 'auth:success': ...
  case 'ask:question': ...
  // ← permission:request 不在这里!
  default:
    log.warn(`Unknown message type:`, message.type);  // ← 命中这里
}
```

远程代理发送的 `permission:request` 消息到达本地客户端后，命中 `default` 分支，被当作未知消息丢弃。`send-message-remote.ts` 中注册的 `addHandler('permission:request', ...)` 监听器永远不会被触发，整个链路断裂。

## 技术方案

在 `remote-ws-client.ts` 的 switch 语句中添加 `permission:request` case，emit 事件使 `send-message-remote.ts` 的 handler 生效：

```typescript
case 'permission:request':
  this.emit('permission:request', { sessionId: message.sessionId, data: message.data });
  break;
```

## 涉及文件

| 文件 | 修改内容 |
|------|---------|
| `src/main/services/remote/ws/remote-ws-client.ts`（第 425 行后） | switch 语句添加 `case 'permission:request'` |

## 验收标准

- [ ] 远程 Agent 执行破坏性命令 → 本地 UI 弹出 `ToolPermissionCard`
- [ ] 用户点击 Allow → 远程 Agent 继续执行
- [ ] 用户点击 Deny → 远程 Agent 收到拒绝反馈并提供替代方案
- [ ] `npm run build` 通过
