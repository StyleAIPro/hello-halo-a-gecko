# PRD [Bug 修复级] — 远程 Proxy 中途发消息取消 interrupt，改为排队等待自然完成

> 版本：bugfix-remote-queue-interrupt-v1
> 日期：2026-04-16
> 指令人：@zhaoyinqi
> 反馈人：@zhaoyinqi
> 归属模块：modules/remote-agent
> 严重程度：Major

## 问题描述
- **期望行为**：远程 Proxy 在收到中途消息时，应仅将消息存入待处理队列，等待当前 stream 自然完成后，再以新消息启动下一轮 streamChat。这与本地前端的行为一致。
- **实际行为**：远程 Proxy 在收到中途消息时，调用 `queueMessage()` 通过 SDK patch 的 `session.send()` 注入消息并调用 `interrupt()` 强制中断当前 turn，导致 SDK 内部消息处理错误。
- **复现步骤**：
  1. 通过远程空间发送一条消息，等待 Agent 开始处理（stream 活跃中）
  2. 在 Agent 回复完成之前，发送第二条消息
  3. 观察 Proxy 日志 — 出现 SDK 内部消息处理错误（interrupt + SDK 注入导致的竞态或状态不一致）

## 根因分析

本地前端已修复此问题（PRD: `prd/module/agent/unified-sdk-patch-v1`），将中途发消息从"interrupt + SDK 注入"改为"排队等待自然完成"。但远程 Proxy（`packages/remote-agent-proxy/`）尚未同步此修复。

当前远程 Proxy 的 `queueMessage()` 流程：
1. `server.ts` 第 711-717 行：检测到活跃 stream 时，调用 `claudeManager.queueMessage(sessionId, content, options)`
2. `claude-manager.ts` 第 1434-1462 行 `queueMessage()`：
   - 调用 `session.send(content)` — 通过 SDK patch 的 send 拦截（Patch 8）将消息注入 SDK 内部队列
   - 调用 `(session as any).interrupt()` — 强制中断当前 turn，使 SDK 产生 result 事件
   - 期望 patched stream()（Patch 9）在 result 之后继续处理注入的消息

问题：这种"interrupt + SDK 注入"方式依赖 SDK patch 的内部状态机，但 SDK 内部消息处理在 interrupt 后出现状态不一致，导致错误。

## 修复方案

### 核心思路
将 `queueMessage()` 从"interrupt + SDK 注入"改为"纯队列存储"，在 `streamChat` 循环自然结束后检查队列并启动新一轮 streamChat。

### 文件变更

#### 1. `packages/remote-agent-proxy/src/claude-manager.ts`

**新增数据结构：**
```typescript
// 待处理消息队列：sessionId -> [{content, options}]
private pendingMessages: Map<string, Array<{content: string, options?: any}>> = new Map()
```

**修改 `queueMessage()` 方法（第 1434-1462 行）：**
- 移除 `session.send(content)` 调用
- 移除 `(session as any).interrupt()` 调用
- 仅将消息存入 `pendingMessages` Map
- 返回 `true` 表示消息已入队

```typescript
async queueMessage(conversationId: string, content: string, options?: any): Promise<boolean> {
  if (!this.activeSessions.has(conversationId)) return false

  if (!this.pendingMessages.has(conversationId)) {
    this.pendingMessages.set(conversationId, [])
  }
  this.pendingMessages.get(conversationId)!.push({ content, options })
  console.log(`[ClaudeManager][${conversationId}] Message queued (pending: ${this.pendingMessages.get(conversationId)!.length})`)
  return true
}
```

**新增 `consumePendingMessages()` 方法：**
```typescript
consumePendingMessages(sessionId: string): Array<{content: string, options?: any}> | null {
  const pending = this.pendingMessages.get(sessionId)
  if (!pending || pending.length === 0) return null
  this.pendingMessages.delete(sessionId)
  return pending
}
```

**新增 `hasPendingMessages()` 方法：**
```typescript
hasPendingMessages(sessionId: string): boolean {
  const pending = this.pendingMessages.get(sessionId)
  return !!pending && pending.length > 0
}
```

#### 2. `packages/remote-agent-proxy/src/server.ts`

**修改 `claude:chat` 消息处理逻辑（第 711-809 行）：**

将 streamChat 逻辑包裹在外层循环中，在每次 streamChat 自然完成后检查是否有待处理消息：

```typescript
// 外层循环：处理排队消息
let chatMessages = messages  // 初始消息
let chatOptions = resolvedOptions  // 初始选项
let currentSdkSessionId = sdkSessionIdToUse

while (true) {
  // 内层 do-while：auth retry 循环（保持不变）
  do {
    needsAuthRetry = false

    for await (const chunk of this.claudeManager.streamChat(
      sessionId, chatMessages, chatOptions,
      authRetries > 0 ? undefined : currentSdkSessionId,
      onToolCall, onTerminalOutput, onThought, onThoughtDelta,
      onMcpStatus, onCompact, hyperSpaceToolExecutor,
      aicoBotMcpToolExecutor, aicoBotMcpToolDefs, onAskUserQuestion
    )) {
      // ... 现有 chunk 处理逻辑不变 ...
    }

    // ... auth retry 处理逻辑不变 ...
  } while (needsAuthRetry && authRetries < MAX_AUTH_RETRIES)

  // streamChat 自然完成后，检查待处理消息队列
  const pending = this.claudeManager.consumePendingMessages(sessionId)
  if (!pending || pending.length === 0) break

  // 有排队消息 — 构造新消息并启动下一轮 streamChat
  console.log(`[RemoteAgentServer] Processing ${pending.length} pending message(s) for session ${sessionId}`)
  const lastPending = pending[pending.length - 1]  // 取最后一条（与本地行为一致）
  chatMessages = [{ role: 'user', content: lastPending.content }]
  chatOptions = lastPending.options || resolvedOptions
  currentSdkSessionId = undefined  // 使用已有 session，不 resume
  authRetries = 0  // 重置 auth retry 计数
}
```

**注意：** 原有的第 714-718 行 `isActive` 检查 + `queueMessage` 调用保留不变，但 `queueMessage` 的行为从"注入+中断"变为"纯入队"。入队后 `return` 仍然有效，因为 streamChat 循环会在自然结束后自动消费队列。

### 消息流对比

**修复前：**
```
用户中途发消息 → queueMessage() → session.send() + interrupt() → SDK 内部错误
```

**修复后：**
```
用户中途发消息 → queueMessage() → 仅存入 pendingMessages Map
                                       ↓
当前 streamChat 自然完成 → consumePendingMessages() → 启动新一轮 streamChat
```

## 影响范围
- [ ] 涉及 API 变更 → 无，WebSocket 协议不变
- [ ] 涉及数据结构变更 → 无，仅内存状态
- [ ] 涉及功能设计变更 → modules/remote-agent/features/websocket-client/design.md

## 验证方式
1. 通过远程空间发送消息，在 Agent 回复完成前发送第二条消息
2. 确认第二条消息不会触发 interrupt，无 SDK 内部错误
3. 确认 Agent 在完成第一条消息的回复后，自动处理第二条消息
4. 连续发送多条消息，确认全部按顺序处理
5. 确认 auth retry 场景下排队消息仍然正常消费
6. 确认 stream 中断/异常退出时，已入队的消息不会泄漏（下一个 chat 请求不受影响）

## 变更
| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 PRD | @zhaoyinqi |
