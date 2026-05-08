# PRD — Bugfix: 远程 Agent 断网重连后 UI 卡死"思考中"

> 版本：v1
> 日期：2026-05-08
> 状态：in-progress
> 指令人：@moonseeker
> 优先级：P0
> 影响范围：仅后端（`packages/remote-agent-proxy/`）

## 问题分析

### 现象

用户在远程 NPU 服务器上运行 aisbench（长时间工具调用），期间网络断开。重连后输入"继续"，UI 永久卡在"思考中"状态，无法恢复。

### 根因

这是一个**两层连锁故障**：

#### 第一层：WebSocket 断开时，服务端未中断活跃的 SDK 流

| 项目 | 详情 |
|------|------|
| 文件 | `packages/remote-agent-proxy/src/server.ts` WebSocket `close` handler |
| 原始行为 | 客户端断开时仅打印日志、删除 `clients` 映射，不中断正在运行的 `streamChat` |
| 问题 | `handleClaudeChat` 持有**会话处理锁**（`sessionProcessingLocks`），同时阻塞在 SDK `for await` 循环中（等待 aisbench 工具调用返回） |
| 后果 | 客户端重连后发送新消息 → `handleClaudeChat` 发现锁被占用 → 消息入队（`queueMessage`）→ 入队的消息**永远不会被消费**，因为旧的 `handleClaudeChat` 的响应发往已关闭的 WebSocket，且 SDK 流可能永远不会结束（或要等很久） |

```
时间线：
1. 客户端发送消息 → handleClaudeChat 获得锁 → session.send() → streamChat 进入 for await
2. SDK 执行工具调用（aisbench），流阻塞等待结果
3. 网络断开 → WebSocket close → 服务端仅清理 clients 映射
4. handleClaudeChat 仍在运行，持有锁，for await 等待 SDK 事件
5. 客户端重连 → 发送"继续" → handleClaudeChat 发现锁存在 → queueMessage → return
6. 旧 handler 的 SDK 流可能永远不结束 → 锁永不释放 → 排队的消息永不消费
7. UI 卡在"思考中" forever
```

#### 第二层：被中断的 SDK 会话可能已损坏

即使修复了第一层（断开时中断流），还存在**会话损坏**问题：

| 项目 | 详情 |
|------|------|
| 场景 | SDK 流被 `abort()` 中断时，可能正在执行工具调用（如 aisbench）|
| 问题 | 中断后的 SDK 会话内部状态可能不一致（`streamInput` 迭代器冲突），导致下次 `session.stream()` 直接挂起，不产生任何事件 |
| 后果 | 重用损坏会话 → `streamChat` 的 `for await` 永远收不到第一个事件 → 又一次卡死 |

### 原始修复方案的问题

第一版修复采用"被中断的会话直接销毁重建"策略，虽然解决了卡死问题，但导致了**上下文丢失**：
- 用户反馈："我没有找到之前任务的上下文"
- 原因：销毁 SDK 会话 = 丢失 AI 的对话历史，新会话从零开始

## 技术方案

### 设计原则

1. **断开时必须中断流**：释放会话锁，让重连后的消息能被处理
2. **尽量保留会话上下文**：不主动销毁被中断的会话
3. **安全兜底**：如果被中断的会话确实已损坏，用超时检测并自动重建

### Fix #1：WebSocket 断开时中断活跃流（server.ts）

**文件**：`packages/remote-agent-proxy/src/server.ts` — WebSocket `close` handler

**变更**：检测断开的客户端是否有正在运行的流（通过 `sessionProcessingLocks`），如果有：
1. 调用 `claudeManager.markAsInterrupted(sid)` — 标记会话为"已中断"
2. 调用 `claudeManager.forceAbortStreamIterator(sid)` — abort SDK 流，让 `for await` 退出

```
断开流程（修复后）：
1. 网络断开 → WebSocket close
2. 检测到 sid 在 sessionProcessingLocks 中
3. markAsInterrupted → 设置 interrupted flag
4. forceAbortStreamIterator → abortController.abort() → for await 抛出 "Stream aborted"
5. streamChat catch 块捕获 → wasAborted = true → return
6. handleClaudeChat finally → 释放锁
7. 客户端重连 → 发送"继续" → handleClaudeChat 获得锁 → 正常处理
```

### Fix #2：被中断会话的智能复用策略（claude-manager.ts）

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

#### 2a：`V2SessionInfo` 添加 `interrupted` 标志

```typescript
export interface V2SessionInfo {
  // ... 原有字段
  interrupted?: boolean  // 流被中断时设置 — 会话可能已损坏，复用时需安全检查
}
```

#### 2b：`markAsInterrupted()` 同时设置 sessionInfo.interrupted

```typescript
markAsInterrupted(conversationId: string): void {
  this.interruptedSessions.add(conversationId)
  const sessionInfo = this.sessions.get(conversationId)
  if (sessionInfo) {
    sessionInfo.interrupted = true
  }
}
```

#### 2c：`getOrCreateSession()` 三分支处理被中断会话

```
被中断会话的决策树：
├─ Transport 存活（进程未死、连接未关闭）
│   └─ 尝试复用，清除 interrupted 标志 → 交给 streamChat 的 first-event timeout 兜底
├─ Transport 死亡
│   └─ 销毁重建（无法复用）
└─ 未被中断
    └─ 走原有逻辑（resume 或新建）
```

**关键**：Transport 存活时选择"尝试复用"而非"直接销毁"，保留了 AI 对话上下文。

#### 2d：`streamChat()` first-event safety timeout

对被中断且被复用的会话，设置 **30 秒首事件超时**：

```
streamChat 流程（被中断会话）：
1. session.send("继续")
2. 启动 30 秒计时器
3. for await (event of session.stream())
   ├─ 30 秒内收到事件 → 取消计时器 → 正常流式输出 ✅
   └─ 30 秒内无事件 → 计时器触发 → abortController.abort()
        └─ catch 块检测到 sessionInfo.interrupted && eventCount === 0
            └─ 抛出 SESSION_CORRUPTED
                └─ server.ts 捕获 → forceSessionRebuild → 重试（不 resume）✅
```

### Fix #3：server.ts SESSION_CORRUPTED 重试机制

**文件**：`packages/remote-agent-proxy/src/server.ts` — `handleClaudeChat` catch 块

在已有的 `Cannot send to closed session` 重试逻辑旁，新增 `SESSION_CORRUPTED` 处理：

```typescript
} else if (errorMessage.includes('SESSION_CORRUPTED') && !needsClosedSessionRetry) {
  console.warn(`Session corrupted (first-event timeout), rebuilding and retrying...`)
  this.claudeManager.forceSessionRebuild(sessionId)
  needsClosedSessionRetry = true
}
```

重试时 `shouldSkipResume = true`，确保不尝试恢复损坏的 SDK 会话，而是创建全新会话。

## 完整数据流

```
═══════════════════════════════════════════════════════════════
场景 A：断网重连，会话健康（aisbench 未在执行）
═══════════════════════════════════════════════════════════════

1. 客户端断开 → markAsInterrupted + forceAbortStreamIterator
2. SDK 流被中断，streamChat 退出，锁释放
3. 客户端重连，发送"继续"
4. getOrCreateSession: interrupted=true, transport=alive → 复用会话
5. streamChat: first-event timeout=30s → session.send() → stream 开始
6. <1s 内收到第一个事件 → 超时取消 → 正常流式输出
7. 结果：上下文保留，继续执行 ✅

═══════════════════════════════════════════════════════════════
场景 B：断网重连，会话损坏（aisbench 执行中被中断）
═══════════════════════════════════════════════════════════════

1. 客户端断开 → markAsInterrupted + forceAbortStreamIterator
2. SDK 流被中断（可能 mid-tool-call），streamChat 退出，锁释放
3. 客户端重连，发送"继续"
4. getOrCreateSession: interrupted=true, transport=alive → 复用会话
5. streamChat: first-event timeout=30s → session.send() → stream 挂起
6. 30 秒无事件 → abort → catch: SESSION_CORRUPTED
7. server.ts: forceSessionRebuild → 重建全新会话（不 resume）→ 重试
8. 结果：上下文丢失，但不卡死，自动恢复 ✅

═══════════════════════════════════════════════════════════════
场景 C：断网重连，SDK 进程已死
═══════════════════════════════════════════════════════════════

1. 客户端断开 → markAsInterrupted + forceAbortStreamIterator
2. SDK 流被中断，streamChat 退出，锁释放
3. 客户端重连，发送"继续"
4. getOrCreateSession: interrupted=true, transport=dead → cleanupSession → 新建会话
5. 结果：上下文丢失（不可避免），但不卡死 ✅
```

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `packages/remote-agent-proxy/src/server.ts` | 修改 | WebSocket close handler 中断活跃流；handleClaudeChat 添加 SESSION_CORRUPTED 重试 |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 修改 | V2SessionInfo.interrupted 标志；markAsInterrupted 增强；getOrCreateSession 三分支策略；streamChat first-event timeout |

## 验收标准

- [ ] **断网不卡死**：运行 aisbench 时断网，重连后输入"继续"，UI 不再永久卡在"思考中"
- [ ] **上下文保留（会话健康时）**：断网时 SDK 未在执行工具调用，重连后 AI 能继续之前的对话上下文
- [ ] **自动恢复（会话损坏时）**：断网时 SDK 正在执行工具调用，重连后 30 秒内自动检测损坏并重建会话，UI 显示结果（可能丢失上下文）
- [ ] **锁释放验证**：断网后服务端日志显示 "aborting" 和锁释放，重连后新消息不被 queueMessage 拦截
- [ ] **正常流程不受影响**：无断网场景下，多轮对话、工具调用、子代理等正常工作
- [ ] **类型检查通过**：`npm run typecheck` 无错误
- [ ] **构建通过**：`npm run build` 无错误
