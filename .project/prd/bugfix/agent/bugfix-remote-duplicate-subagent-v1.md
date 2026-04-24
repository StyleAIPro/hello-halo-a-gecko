# PRD [Bug 修复级] — 远程模式单消息重复生成子 Agent + 子 Agent 误报 "Stream interrupted"

> 版本：bugfix-remote-duplicate-subagent-v1
> 日期：2026-04-21
> 状态：done
> 指令人：@misakamikoto
> 归属模块：modules/agent, modules/remote-agent
> 严重程度：Major

## 问题描述

### Bug 1：远程模式单消息重复生成子 Agent

- **期望行为**：远程模式下，发送一条消息，Claude 只生成合理数量的子 Agent（通过 SDK Agent 工具），每个子 Agent 执行明确的任务
- **实际行为**：远程模式下，发送一条消息后，Claude 生成了多个子 Agent，其中部分是多余的。这些多余的子 Agent 都会收到 "Stream interrupted" 错误
- **复现步骤**：
  1. 连接到远程空间
  2. 发送一条会触发 Claude 使用 Agent 工具的消息
  3. 观察前端 NestedWorkerTimeline — 出现多个子 Agent，其中部分以 "Stream interrupted" 失败
- **用户确认**：子 Agent 互相不同（描述不同），不是完全重复，但部分是多余的

### Bug 2：正常完成的子 Agent 被误报 "Stream interrupted"

- **期望行为**：当父 stream 正常结束（非用户中断）时，已完成的子 Agent 应显示正确的完成状态，仍在运行的子 Agent 不应发送失败的 `worker:completed` 事件
- **实际行为**：父 stream 正常结束后，`finally` 块将所有未标记为 complete 的子 Agent 都发送 `worker:completed` failure 事件（错误信息为 "Stream interrupted"），即使这些子 Agent 正在正常执行或即将完成
- **触发条件**：SDK 不保证所有 `task_notification` 事件在父 `result` 事件之前到达。当父 stream 先于子 Agent 的 `task_notification` 结束时，子 Agent 被误判为失败

## 根因分析

### Bug 1 根因：handleClaudeChat 中 isActive() 检查与 registerActiveSession() 非原子（server.ts）

**文件**：`packages/remote-agent-proxy/src/server.ts`（第 162 行、第 794 行、第 1743 行）

**问题**：

1. `ws.on('message')` 回调调用 `this.handleMessage(ws, message)` 但**不 await**（fire-and-forget）：
   ```typescript
   // server.ts line 162
   this.handleMessage(ws, message)
   ```

2. `handleClaudeChat()` 在进入流式处理前检查 `isActive()`：
   ```typescript
   // server.ts line 794
   if (this.claudeManager.isActive(sessionId) && lastMessage?.role === 'user') {
     this.claudeManager.queueMessage(sessionId, lastMessage.content, currentOptions)
     return
   }
   ```

3. `streamChat()` 内部才调用 `registerActiveSession()`：
   ```typescript
   // claude-manager.ts line 1743
   this.registerActiveSession(sessionId, abortController)
   ```

**竞态窗口**：在 `isActive()` 检查（第 794 行）和 `registerActiveSession()` 调用（第 1743 行）之间存在时间窗口。如果两条 `claude:chat` 消息在这个窗口内到达：
- 两条消息都通过了 `isActive()` 检查（都返回 `false`）
- 两个 `streamChat()` 并发执行
- SDK 对同一消息处理两次，生成多余的子 Agent

**时序图**：

```
时间线 →

消息 A 到达                  消息 B 到达
  │                            │
  ▼                            ▼
isActive() → false            isActive() → false
  │                            │
  ▼                            ▼
streamChat() 开始             streamChat() 开始（并发！）
  │                            │
  ▼                            ▼
registerActiveSession()       registerActiveSession()
  │                            │
  ▼                            ▼
SDK 处理消息 A               SDK 处理消息 A（重复！）
  │                            │
  ▼                            ▼
子 Agent 1（正常）           子 Agent 2（多余）→ Stream interrupted
```

### Bug 2 根因：streamChat 的 finally 块过度清理子 Agent（claude-manager.ts）

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`（第 2520-2531 行）

**问题**：`finally` 块在**所有退出路径**上都将未完成的子 Agent 标记为失败：

```typescript
// claude-manager.ts lines 2520-2531
finally {
  for (const [taskId, state] of subagentStates) {
    if (!state.isComplete) {
      yield { type: 'worker:completed', data: {
        agentId: state.agentId, agentName: state.agentName, taskId,
        result: '', error: wasAborted ? 'Stopped by user' : 'Stream interrupted', status: 'failed'
      }}
      console.log(`[ClaudeManager] Subagent ${taskId} cleaned up (stream ended, aborted=${wasAborted})`)
    }
  }
}
```

这段代码在以下场景都会执行：
- **用户中断**（`wasAborted = true`）：应该标记失败 — 正确
- **正常完成**（`wasAborted = false`）：SDK 父 stream 正常结束（收到 `result` 事件），但某些子 Agent 的 `task_notification` 事件尚未到达 — **错误**地将子 Agent 标记为 "Stream interrupted"

SDK 的事件顺序不保证 `task_notification` 在父 `result` 之前到达。当父 stream 结束但子 Agent 异步事件还在传输中时，`subagentStates` 中的 `isComplete` 仍为 `false`，导致 finally 块发出错误的失败事件。

## 修复方案

### 改动 1：server.ts — 添加 per-session 处理锁

**文件**：`packages/remote-agent-proxy/src/server.ts`

在 `RemoteAgentServer` 类中添加 `Map<string, Promise<void>>` 类型的 `sessionProcessingLocks` 字段。在 `handleClaudeChat()` 的 `isActive()` 检查之前，获取 per-session 锁：

```typescript
// 新增字段
private sessionProcessingLocks = new Map<string, Promise<void>>()

// 在 handleClaudeChat() 中，isActive() 检查之前
const lockKey = sessionId
const existingLock = this.sessionProcessingLocks.get(lockKey)
if (existingLock) {
  // 已有 streamChat 在执行，排队消息
  const lastMessage = chatMessages[chatMessages.length - 1]
  if (lastMessage?.role === 'user') {
    this.claudeManager.queueMessage(sessionId, lastMessage.content, resolvedOptions)
  }
  return
}

// 创建锁 Promise
let resolveLock!: () => void
const lockPromise = new Promise<void>(resolve => { resolveLock = resolve })
this.sessionProcessingLocks.set(lockKey, lockPromise)

try {
  // ... 原有的 isActive() 检查 + streamChat() 逻辑 ...
} finally {
  this.sessionProcessingLocks.delete(lockKey)
  resolveLock()
}
```

**效果**：确保同一 session 同一时刻只有一个 `streamChat()` 在运行。后续到达的消息走排队路径（与现有 `isActive` 逻辑一致），消除竞态条件。

### 改动 2：claude-manager.ts — 改进 finally 块的子 Agent 清理逻辑

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`（第 2520-2531 行）

将 finally 块改为：仅在用户主动中断（`wasAborted === true`）时发送 `worker:completed` failure 事件。正常完成时（`wasAborted === false`），静默清理未完成的子 Agent，不发送失败事件：

```typescript
finally {
  // Clean up any active subagents that didn't complete
  for (const [taskId, state] of subagentStates) {
    if (!state.isComplete) {
      if (wasAborted) {
        // User explicitly stopped — send failure notification
        yield { type: 'worker:completed', data: {
          agentId: state.agentId, agentName: state.agentName, taskId,
          result: '', error: 'Stopped by user', status: 'failed'
        }}
        console.log(`[ClaudeManager] Subagent ${taskId} marked as stopped by user`)
      } else {
        // Normal completion — silently clean up.
        // SDK doesn't guarantee all task_notification events arrive before
        // the parent's result event. Sending a failure here would cause
        // false "Stream interrupted" errors on the frontend.
        console.log(`[ClaudeManager] Subagent ${taskId} silently cleaned up (normal stream end, may still complete asynchronously)`)
      }
    }
  }
  // ... rest of cleanup ...
}
```

**效果**：
- 用户点击停止 → 子 Agent 正确显示 "Stopped by user"
- 正常完成 → 不会误报 "Stream interrupted"，未完成的子 Agent 静默清理
- 如果子 Agent 的 `task_notification` 在 finally 之后才到达（理论上不会，因为 finally 在 yield 循环结束后），不影响正常完成的子 Agent

## 影响范围

- [x] 涉及 API 变更 → 无
- [ ] 涉及数据结构变更 → 无
- [ ] 涉及功能设计变更 → 无（仅修复竞态条件和清理逻辑）

## 开发前必读

编码前必须阅读以下文档，建立上下文：

1. **模块设计**：`.project/modules/agent/agent-core-v1.md` — Agent 核心架构
2. **Stream 处理设计**：`.project/modules/agent/features/stream-processing/design.md` — 事件流处理
3. **Worker 管理设计**：`.project/modules/agent/features/worker-management/design.md` — 子 Agent worker session 路由
4. **远程 Agent 模块**：`.project/modules/remote-agent/remote-agent-v1.md` — 远程代理架构
5. **WebSocket 客户端设计**：`.project/modules/remote-agent/features/websocket-client/design.md` — 消息收发流程
6. **SDK Session 设计**：`.project/modules/agent/features/sdk-session/design.md` — Session 生命周期管理
7. **功能 changelog**：
   - `.project/modules/agent/features/message-send/changelog.md`
   - `.project/modules/agent/features/stream-processing/changelog.md`
   - `.project/modules/agent/features/worker-management/changelog.md`
   - `.project/modules/remote-agent/features/websocket-client/changelog.md`
8. **相关 PRD**（前序修复，本 Bug 的直接前置）：
   - `.project/prd/bugfix/agent/bugfix-remote-subagent-v1.md` — 远程子 Agent 可见性 + 重试报错修复

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `packages/remote-agent-proxy/src/server.ts` | 修改 | 添加 per-session 处理锁，消除 isActive() 与 registerActiveSession() 之间的竞态窗口 |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 修改 | 改进 finally 块：正常完成时静默清理未完成子 Agent，不发送 false failure 事件 |

## 验收标准

### Bug 1：无多余子 Agent

- [ ] 远程模式下，发送单条消息不会生成多余的子 Agent
- [ ] 远程模式下，快速发送消息（停止后立即重发）不会导致额外子 Agent 生成
- [ ] 远程模式下，当 Claude 合理使用 Agent 工具多次时，所有子 Agent 正确执行

### Bug 2：无误报 "Stream interrupted"

- [ ] 远程模式下，正常完成的子 Agent 显示正确的完成状态（`status: 'completed'`），不会显示 "Stream interrupted"
- [ ] 远程模式下，父 stream 正常结束但部分子 Agent 尚未收到 `task_notification` 时，不会发送 false failure 事件

### 通用

- [ ] 远程模式下，用户点击停止按钮，子 Agent 仍然正确显示 "Stopped by user"
- [ ] 本地模式功能不受影响（回归测试）
- [ ] 正常的子 Agent 完成流程仍正确工作（`worker:completed` with `status: 'completed'`，当 `task_notification` 被正常接收时）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-21 | 初始 Bug 修复 PRD（双 Bug：竞态重复子 Agent + 误报 Stream interrupted） | @misakamikoto |
