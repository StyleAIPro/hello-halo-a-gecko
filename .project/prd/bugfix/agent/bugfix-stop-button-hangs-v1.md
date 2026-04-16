# PRD [Bug 修复级] — 停止生成按钮导致无限加载

> 版本：bugfix-stop-button-hangs-v1
> 日期：2026-04-16
> 指令人：@zhaoyinqi
> 反馈人：@zhaoyinqi
> 归属模块：modules/agent
> 严重程度：Critical

## 问题描述

- **期望行为**：用户在 Agent 响应过程中点击停止按钮（聊天输入区或左侧会话标签页），Agent 应立即停止生成，UI 恢复到可交互状态
- **实际行为**：点击停止按钮后，UI 进入无限加载/旋转状态（`isStopping: true`），Agent 卡住无法停止，用户必须重启应用才能恢复
- **复现步骤**：
  1. 发送消息给 Agent，等待 Agent 开始响应
  2. 点击聊天输入区的停止按钮或左侧会话标签页的停止按钮
  3. 观察到 UI 显示"停止中"状态，但永远不恢复
  4. 无法发送新消息，无法停止，只能重启应用

## 根因分析

存在两个独立但叠加的问题：

### 根因 1：drain 循环窃取 stream processor 的消息（本地会话）

**文件**：`src/main/services/agent/control.ts`（第 70-74 行）

`stopGeneration()` 函数执行以下操作：
1. 调用 `abortController.abort()`（第 43 行）
2. 调用 `v2Session.session.interrupt()` 停止 SDK（第 66 行）
3. **通过第二个 `for await` 循环排空剩余消息**（第 70-74 行）

```typescript
// control.ts 中的 drain 循环
for await (const msg of v2Session.session.stream()) {
  console.log(`[Agent] Drained: ${msg.type}`);
  if (msg.type === 'result') break;
}
```

**问题**：`stream-processor.ts`（第 713 行）中也有一个 `for await` 循环遍历同一个 SDK stream。V2 SDK 的 `stream()` 方法（`() => AsyncIterable<any>`）返回的迭代器共享同一个底层子进程 stdout。当 `control.ts` 中的 drain 循环消费了剩余消息（包括 `result` 消息）时，stream processor 的 `for await` 循环永远收不到这些消息而永久挂起。`agent:complete` 事件永远不会发送到前端，导致 chat store 一直停留在 `isStopping: true`。

### 根因 2：前端缺少安全超时机制（所有会话类型）

**文件**：`src/renderer/stores/chat.store.ts`（第 1443-1474 行）

`stopGeneration` action 设置 `isStopping: true` 并向后端发送停止请求。它完全依赖从后端接收 `agent:complete` 或 `agent:error` 事件来清除 `isStopping`。如果这些事件因任何原因（drain 循环窃取、SDK 无响应、远程会话网络问题）永远不到达，前端将永远卡在停止状态。

```typescript
// chat.store.ts — 仅设置 isStopping，没有超时保护
set((state) => {
  const session = newSessions.get(targetId);
  if (session && session.isGenerating) {
    newSessions.set(targetId, {
      ...session,
      isStopping: true,
    });
  }
  return { sessions: newSessions };
});
```

## 修复方案

### 改动 1：移除 control.ts 中的 drain 循环

**文件**：`src/main/services/agent/control.ts`

移除第 69-74 行的 drain 循环。保留 `interrupt()` 调用和 5 秒超时。

**理由**：
- `stopGeneration` 从 IPC handler 角度是 fire-and-forget 的
- `interrupt()` 调用后，SDK 会刷新剩余消息到 stdout
- stream processor 的 `for await` 循环会自然接收到这些消息
- stream processor 第 718 行的 abort 检查会在收到消息时 break 循环
- drain 循环不仅没有用处，反而会与 stream processor 竞争同一个迭代器，导致消息丢失

```typescript
// 修复后 — 仅 interrupt，不 drain
await Promise.race([
  (async () => {
    await (v2Session.session as any).interrupt();
    console.log(`[Agent] V2 session interrupted`);
  })(),
  new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error('V2 interrupt timed out')),
      INTERRUPT_TIMEOUT,
    ),
  ),
]);
```

### 改动 2：前端 stopGeneration 增加 10 秒安全超时

**文件**：`src/renderer/stores/chat.store.ts`

在 `stopGeneration` action 中增加 10 秒安全超时。如果超时后 `isStopping` 仍为 true，强制清除并尝试从后端重新加载对话。

**理由**：
- 这是针对 `agent:complete` 不到达的通用安全网
- 覆盖所有会话类型（本地 + 远程）
- 防止前端永久卡在停止状态

```typescript
// 在 stopGeneration 中增加安全超时
const SAFETY_TIMEOUT = 10_000;
const safetyTimer = setTimeout(() => {
  const state = get();
  const session = state.sessions.get(targetId);
  if (session?.isStopping) {
    console.warn(`[ChatStore] Stop safety timeout (${SAFETY_TIMEOUT}ms) reached, force-clearing`);
    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.set(targetId, {
        ...session,
        isGenerating: false,
        isStopping: false,
      });
      return { sessions: newSessions };
    });
    // 尝试重新加载对话以同步最新状态
    api.loadConversation(targetId).catch(() => {});
  }
}, SAFETY_TIMEOUT);
```

## 影响范围

- [x] 涉及 API 变更 → 无
- [ ] 涉及数据结构变更 → 无
- [ ] 涉及功能设计变更 → 无

## 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `src/main/services/agent/control.ts` | 修改 — 移除 drain 循环 |
| `src/renderer/stores/chat.store.ts` | 修改 — 增加 10 秒安全超时 |

## 验证方式

1. 本地会话：发送消息 → Agent 开始响应 → 点击停止 → UI 应在数秒内恢复到可交互状态
2. 远程会话：同上测试远程空间的停止功能
3. 快速停止：连续多次点击停止按钮 → 不应出现状态异常
4. SDK 无响应场景：模拟后端不发送 `agent:complete` → 前端应在 10 秒后自动恢复
5. 停止后发送新消息：停止完成后 → 应能正常发送新消息

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 Bug 修复 PRD | @zhaoyinqi |
