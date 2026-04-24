# PRD [Bug 修复级] — 远程模式子 Agent 不可见 + 重试对话报错 "Cannot send to closed session"

> 版本：bugfix-remote-subagent-v1
> 日期：2026-04-20
> 状态：draft
> 指令人：@misakamikoto
> 归属模块：modules/agent, modules/remote-agent
> 严重程度：Critical

## 问题描述

### Bug 1：远程模式下子 Agent 不可见

- **期望行为**：远程模式下，当 Claude 使用 Agent 工具生成子 Agent 时，子 Agent 的思考过程应像本地模式一样在前端 NestedWorkerTimeline 中正确展示
- **实际行为**：远程模式下子 Agent 的 thought 事件到达前端后，`handleAgentThought` 无法将其路由到 worker session，导致子 Agent 的思考过程完全不可见
- **复现步骤**：
  1. 连接到远程空间
  2. 发送一条会触发 Claude 使用 Agent 工具的消息
  3. 观察前端 — 子 Agent 的 NestedWorkerTimeline 不出现

### Bug 2：重试对话报错 "Claude stream error: Cannot send to closed session"

- **期望行为**：用户点击停止后，再次发送消息应正常工作
- **实际行为**：用户点击停止后再发送消息，收到错误 "Claude stream error: Cannot send to closed session"
- **复现步骤**：
  1. 连接到远程空间
  2. 发送消息，等待 Agent 开始响应
  3. 点击停止按钮
  4. 立即再次发送消息
  5. 收到 "Cannot send to closed session" 错误

## 根因分析

### Bug 1 根因：远程模式 thought 事件缺少顶层 agentId

**文件**：`src/main/services/agent/send-message.ts`（第 1285 行）

**本地模式（正确）**：`stream-processor.ts` 中的 `workerEmit` 会将 `agentId`/`agentName` 展开到发送给渲染器的数据对象顶层：

```typescript
// stream-processor.ts line 291-292
const workerEmit = (channel: string, data: Record<string, unknown>): void => {
  sendToRenderer(channel, spaceId, rendererConvId, { ...data, agentId, agentName });
};
// 因此发送的数据格式为: { thought, agentId, agentName }
```

**远程模式（错误）**：`send-message.ts` 转发 thought 事件时，`agentId`/`agentName` 只嵌套在 `thought` 对象内部，不在数据对象顶层：

```typescript
// send-message.ts line 1285 — 修复前
sendToRenderer('agent:thought', spaceId, conversationId, { thought: thoughtData });
```

前端 `chat.store.ts` 的 `handleAgentThought`（第 2070 行）从数据对象顶层解构 `agentId`：

```typescript
const { conversationId, agentId, thought } = data;
```

当 `agentId` 为 `undefined` 时，`handleAgentThought` 无法将 thought 路由到 worker session（子 Agent 的独立状态容器），导致子 Agent 的思考过程被丢弃。

### Bug 2 根因：竞态条件 — close:session 与 streamChat 并发执行

涉及三个文件的交互时序：

1. 用户点击停止 → `remote-ws-client.ts` 的 `interrupt()` 同时发送 `claude:interrupt` 和 `close:session` 消息
2. `server.ts` 第 162 行的 `ws.on('message')` 回调调用 `this.handleMessage(ws, message)` 但**没有 `await`**，所以 `close:session` 消息与正在运行的 `handleClaudeChat` 并发处理
3. `close:session` 调用 `claudeManager.removeSession(sid)`，其中 `session.close()` 设置了 `session.closed = true`
4. 但 `streamChat()` 已经持有这个 session 对象的引用，在后续 `session.send()` 调用时抛出 "Cannot send to closed session"

**关键问题**：
- `getOrCreateSession()` 可能在 `removeSession()` 之后返回已关闭的旧 session
- `streamChat()` 中 `session.send()` 前没有对 `session.closed` 的防御性检查
- `server.ts` 的 catch 块缺少对 closed session 错误的针对性处理

## 修复方案

### 改动 1：send-message.ts — 将 agentId/agentName 展开到顶层（Bug 1）

**文件**：`src/main/services/agent/send-message.ts`（第 1285-1290 行）

从 `thoughtData` 中提取 `agentId`/`agentName`，展开到 `sendToRenderer` 的数据对象顶层，与本地模式的 `workerEmit` 格式对齐：

```typescript
sendToRenderer('agent:thought', spaceId, conversationId, {
  thought: thoughtData,
  ...(thoughtData.agentId && { agentId: thoughtData.agentId }),
  ...(thoughtData.agentName && { agentName: thoughtData.agentName }),
});
```

**说明**：使用可选展开（`...`）而非直接解构，是因为普通 thinking block 的 `thoughtData` 不包含 `agentId`（只有子 Agent 的才包含）。需要同时确认 `thought:delta` 事件是否也需要同样处理。

### 改动 2：claude-manager.ts — session.closed 防御性检查 + 自动重建（Bug 2）

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

**2a. `getOrCreateSession()` — 增加 `session.closed` 检查（约第 1254 行）**

在已有的 transport ready 检查之后，增加 SDK `closed` 标志检查，防止已关闭的 session 被复用：

```typescript
} else if ((existing.session as any).closed) {
  console.log(`[ClaudeManager][${conversationId}] Session closed flag set, recreating...`)
  this.cleanupSession(conversationId, 'session closed')
  // Fall through to create new session (without resume — closed sessions can't resume)
}
```

**2b. `streamChat()` — session.send() 前防御性检查 + 自动重建（约第 1842 行）**

在 `session.send()` 之前检查 `session.closed`，如果已关闭则清理旧 session、创建新 session 并继续发送：

```typescript
if ((session as any).closed) {
  console.warn(`[ClaudeManager][${sessionId}] Session closed before send (race condition), rebuilding...`)
  this.cleanupSession(sessionId, 'session closed before send (race)')
  const freshSession = await this.getOrCreateSession(
    sessionId, options.workDir, undefined, /* 不 resume 已关闭的 session */
    options.maxThinkingTokens, hyperSpaceMcpServer, options.system,
    aicoBotMcpServer, options.contextWindow, clientCredentials,
    askUserQuestionCanUseTool, newMcpToolSignature
  )
  session = freshSession
  // 重新应用 thinking tokens 配置到新 session
}
await session.send(lastMessage.content)
```

### 改动 3：session-manager.ts — getOrCreateV2Session 增加 session.closed 检查（Bug 2）

**文件**：`src/main/services/agent/session-manager.ts`（约第 610 行）

与远程代理侧保持一致，在本地 V2 session 创建/复用逻辑中增加 `closed` 标志检查：

```typescript
} else if ((existing.session as any).closed) {
  console.log(`[Agent][${conversationId}] Session closed flag set, recreating...`);
  closeV2SessionForRebuild(conversationId);
  // Fall through to create new session
}
```

### 改动 4：server.ts — catch 块处理 closed session 错误（Bug 2）

**文件**：`packages/remote-agent-proxy/src/server.ts`（handleClaudeChat 的 catch 块，约第 913 行）

在 catch 块中识别 "Cannot send to closed session" 错误，触发 `forceSessionRebuild()` 并允许重试一次，而非直接向客户端报错：

```typescript
} else if (errorMessage.includes('Cannot send to closed session') && !wasInterrupted && !needsClosedSessionRetry) {
  // Race condition: close:session arrived concurrently and closed the SDK session
  // before/during session.send(). Rebuild session and retry once.
  console.warn(`[RemoteAgentServer] Closed session race detected for session ${sessionId}, rebuilding and retrying...`)
  this.claudeManager.forceSessionRebuild(sessionId)
  needsClosedSessionRetry = true
  // Don't re-throw — let execution continue to interrupt check + complete below
}
```

## 影响范围

- [x] 涉及 API 变更 → 无
- [ ] 涉及数据结构变更 → 无
- [ ] 涉及功能设计变更 → 无

## 开发前必读

编码前必须阅读以下文档，建立上下文：

1. **模块设计**：`.project/modules/agent/agent-core-v1.md` — Agent 核心架构
2. **消息发送设计**：`.project/modules/agent/features/message-send/design.md` — 消息发送流程（含远程模式）
3. **Stream 处理设计**：`.project/modules/agent/features/stream-processing/design.md` — 事件流处理
4. **Worker 管理设计**：`.project/modules/agent/features/worker-management/design.md` — 子 Agent worker session 路由
5. **远程 Agent 模块**：`.project/modules/remote-agent/remote-agent-v1.md` — 远程代理架构
6. **WebSocket 客户端设计**：`.project/modules/remote-agent/features/websocket-client/design.md` — 消息收发流程
7. **SDK Session 设计**：`.project/modules/agent/features/sdk-session/design.md` — Session 生命周期管理
8. **功能 changelog**：
   - `.project/modules/agent/features/message-send/changelog.md`
   - `.project/modules/agent/features/stream-processing/changelog.md`
   - `.project/modules/agent/features/worker-management/changelog.md`
   - `.project/modules/remote-agent/features/websocket-client/changelog.md`
9. **功能 bugfix**：
   - `.project/modules/agent/features/message-send/bugfix.md`
   - `.project/modules/remote-agent/features/websocket-client/bugfix.md`
10. **相关 PRD**（竞态条件相关）：
    - `.project/prd/bugfix/agent/bugfix-stop-button-hangs-v1.md` — 停止按钮相关问题

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/send-message.ts` | 修改 | thought 事件添加顶层 agentId/agentName 展开 |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 修改 | getOrCreateSession 增加 closed 检查；streamChat 的 send() 前防御性检查 + 自动重建 |
| `packages/remote-agent-proxy/src/server.ts` | 修改 | handleClaudeChat catch 块处理 closed session 错误 + 重试 |
| `src/main/services/agent/session-manager.ts` | 修改 | getOrCreateV2Session 增加 session.closed 检查 |

## 验收标准

### Bug 1：远程模式子 Agent 可见

- [ ] 远程模式下，触发 Claude 使用 Agent 工具后，子 Agent 的 NestedWorkerTimeline 在前端正确展示
- [ ] 子 Agent 的 thinking content 在 NestedWorkerTimeline 中实时流式显示
- [ ] 子 Agent 的 tool use / tool result 在 NestedWorkerTimeline 中正确显示
- [ ] 多层嵌套子 Agent（子 Agent 再生成子 Agent）的场景也能正确展示
- [ ] 本地模式功能不受影响（回归测试）

### Bug 2：重试对话不报错

- [ ] 远程模式下，Agent 响应过程中点击停止 → 再次发送消息 → 不报 "Cannot send to closed session"
- [ ] 停止后立即发送消息（快速重试），消息正常发送并收到响应
- [ ] 停止后等待数秒再发送消息，功能正常
- [ ] 本地模式的停止 + 重发功能不受影响（回归测试）
- [ ] 远程模式下连续多次停止 + 重发不出现状态异常

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-20 | 初始 Bug 修复 PRD（双 Bug 合并） | @misakamikoto |
