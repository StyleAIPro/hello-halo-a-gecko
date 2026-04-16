# PRD [Bug 修复级] — AskUserQuestion 工具导致 Bot 卡死

> 版本：bugfix-ask-user-question-hang-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 严重程度：Critical
> 所属功能：modules/agent/features/permission-handling
> 涉及模块：agent、chat

## 问题描述

Agent 调用 `AskUserQuestion` 工具时，Bot 出现卡死现象——用户看到 Agent 在"思考中"但永远不继续，也无法看到问题卡片。用户只能通过手动点击"停止生成"来恢复。

## 复现路径

1. 用户发送消息，Agent 开始处理
2. Agent 判断需要用户输入，调用 `AskUserQuestion` 工具
3. SDK 调用 `canUseTool('AskUserQuestion', input)` → permission-handler 创建 pending promise
4. `sendToRenderer('agent:ask-question', ...)` 发送问题到渲染进程
5. **Bug**：渲染进程的 `handleAskQuestion` 因 `isGenerating` 守卫丢弃问题
6. permission-handler 的 promise 永远不会被 resolve 或 reject
7. SDK 子进程阻塞在 control_response 等待，整个 Agent 循环卡死

## 根因分析

### 根因 1：permission-handler 无超时保护（Critical）

**文件**：`src/main/services/agent/permission-handler.ts`

pending promise 没有超时机制。设计文档（`design.md`）规定了"权限请求默认 5 分钟超时"，但实际未实现。一旦问题被渲染进程丢弃，SDK 将永远等待。

```typescript
// 当前代码 — 无超时
const answersPromise = new Promise<Record<string, string>>((resolve, reject) => {
  pendingQuestions.set(id, { resolve, reject })
  // 仅注册了 abort 信号，无独立超时
})
```

### 根因 2：chat.store handleAskQuestion 的 isGenerating 守卫静默丢弃问题（Critical）

**文件**：`src/renderer/stores/chat.store.ts` 第 2180 行

```typescript
// 当前代码 — 静默丢弃
if (!session?.isGenerating || session?.isStopping) {
  console.log(`[ChatStore] Ignoring ask question - not generating or stopping`)
  return state  // 问题被丢弃，但 permission-handler 不知道
}
```

问题：
- 当 `isGenerating === false` 时（可能因状态竞态、页面刷新恢复等），问题被静默丢弃
- 没有任何机制通知主进程"问题已被丢弃"
- 主进程的 promise 永远 pending → SDK 卡死

### 根因 3：缺少 renderer → main 的 reject 通道（Major）

IPC 通道只有 `agent:answer-question`（回答），没有 `agent:reject-question`（拒绝）。当渲染进程因任何原因无法处理问题时，无法通知主进程。

## 修复方案

### 改动 1：permission-handler 增加 5 分钟超时

**文件**：`src/main/services/agent/permission-handler.ts`

- `PendingQuestionEntry` 增加 `timeoutId` 字段
- 创建 promise 时启动 `setTimeout(5 min)`，超时自动 reject
- resolve/reject 时清理 timeout

### 改动 2：chat.store 放宽 isGenerating 守卫

**文件**：`src/renderer/stores/chat.store.ts`

- 移除 `!session?.isGenerating` 检查 — 主进程已经验证 Agent 正在运行
- 保留 `session?.isStopping` 检查但改为 reject 而非静默忽略
- session 不存在时 reject 而非静默忽略

### 改动 3：增加 agent:reject-question IPC 通道

**文件**：
- `src/shared/constants/` — 新增 IPC 通道常量
- `src/main/ipc/agent.ts` — 注册 `agent:reject-question` handler，调用 `rejectQuestion()`
- `src/preload/index.ts` — 暴露 `rejectQuestion` 方法
- `src/renderer/api/index.ts` — 导出 `api.rejectQuestion`
- `src/renderer/api/transport.ts` — 添加到 methodMap（如需事件监听）

### 改动 4：rejectAllQuestions 在 stopGeneration 时调用

**文件**：`src/main/services/agent/control.ts`

在 `stopGeneration()` 中调用 `rejectAllQuestions()`，确保停止时所有 pending question 被清理。

## 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `src/main/services/agent/permission-handler.ts` | 修改 — 增加超时 |
| `src/renderer/stores/chat.store.ts` | 修改 — 放宽守卫 + reject 回调 |
| `src/main/ipc/agent.ts` | 修改 — 增加 reject handler |
| `src/main/services/agent/control.ts` | 修改 — 调用 rejectAllQuestions |
| `src/preload/index.ts` | 修改 — 暴露 rejectQuestion |
| `src/renderer/api/index.ts` | 修改 — 导出 rejectQuestion |
| `src/shared/constants/` | 修改 — 新增常量 |

## 测试验证

1. Agent 调用 AskUserQuestion → 问题卡片正常显示 → 用户回答 → Agent 继续
2. Agent 调用 AskUserQuestion → 不回答 → 5 分钟后自动超时 → Agent 收到 deny → 继续/报错
3. Agent 调用 AskUserQuestion → 用户点击"停止生成" → 问题取消 → Agent 停止
4. 页面刷新后 Agent 调用 AskUserQuestion → 问题仍能正常显示

## 风险评估

- **改动 1（超时）**：低风险，纯增量逻辑，不改变正常流程
- **改动 2（守卫）**：低风险，从"静默丢弃"改为"reject"，配合改动 3
- **改动 3（IPC 通道）**：低风险，新增通道不影响现有通道
- **改动 4（rejectAllQuestions）**：低风险，abort signal 已覆盖此场景，此为双重保障

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 Bug 修复 PRD | @moonseeker1 |
