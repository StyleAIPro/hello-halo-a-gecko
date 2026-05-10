# PRD [Bug 修复级] — Worker 内部 SDK 子 Agent 产生多余 Worker Tab

> 版本：bugfix-excessive-subagents-v2
> 日期：2026-04-22
> 状态：in-progress
> 指令人：@misakamikoto
> 归属模块：modules/agent
> 严重程度：Medium
> 前序 PRD：`.project/prd/bugfix/agent/bugfix-excessive-subagents-v1.md`（已 done）

## 问题描述

### 期望行为

v1 修复后，Leader 不再创建多余子 Agent。Hyper Space Worker 在执行复杂任务时，可以使用 SDK 内置 Agent/Task 工具拆分子任务，但这些内部子 agent 的事件应正常路由到当前 Worker Tab 内，**不应在前端创建额外的 Worker Tab**。

### 实际行为

Worker 使用 SDK 内置 Agent/Task 工具时，SDK 发出 `task_started` 系统消息，`stream-processor.ts` 将其转发为 `worker:started` 事件发送到前端。前端 `handleWorkerStarted` 不区分 Hyper Space Worker 和 SDK 内部子 agent，统一创建新 Worker Tab，导致 Tab 栏中出现多余的 Tab。

### 复现步骤

1. 启用 Hyper Space 团队模式（包含 Leader + Worker）
2. 发送一个需要 Worker 内部拆分子任务的复杂任务
3. Worker 在执行过程中使用 SDK 内置 Agent/Task 工具拆分子任务
4. 观察前端 Tab 栏 — 出现额外的 Worker Tab（SDK 内部子 agent 被误显示为独立 Worker）

### 影响范围

- **本地模式**：会出现
- **远程模式**：也会出现
- **非 Hyper Space 模式**：不受影响
- **Leader**：不受影响（v1 修复已禁用 Leader 的 Agent/Task 工具）

## 根因分析

v1 修复仅在 Leader 层面禁用了 SDK 内置 Agent/Task 工具，Worker 仍可自由使用这些工具。当 Worker 使用 Agent/Task 工具时，事件处理链路存在问题。

### worker:started 的三条发送路径

| 路径 | 触发来源 | 事件性质 | 预期行为 |
|------|---------|---------|---------|
| 路径 A | `orchestrator.ts:2041` Orchestrator subtask | Hyper Space Worker | 正确，应创建 Tab |
| 路径 B | `send-message.ts:245` @mention Worker | Hyper Space Worker | 正确，应创建 Tab |
| 路径 C | `stream-processor.ts:1408` SDK `task_started` | SDK 内部子 agent | **错误，不应创建 Tab** |

### 问题根因

`stream-processor.ts` 第 1387-1414 行：当 SDK 发出 `task_started` 系统消息时，无论当前 `processStream` 是 Leader 还是 Worker 运行，都会创建 `SubagentState` 并发送 `worker:started` 事件到前端。

具体流程：

1. Worker 的 `processStream()` 接收到 SDK 的 `task_started` 系统消息
2. `task_started` 处理逻辑（第 1387-1437 行）创建 `SubagentState`，发送 `worker:started` 事件
3. 前端 `chat.store.ts` 的 `handleWorkerStarted` 收到事件，将 SDK 内部子 agent 放入 `workerSessions` Map
4. `useWorkerTabs` hook 遍历所有 `workerSessions` 生成 Tab，不区分来源

### 关键上下文

- `processStream` 函数签名中有 `workerInfo?: WorkerStreamInfo` 参数。当 Worker 执行时此参数有值，可据此判断当前是 Worker 运行
- SDK 子 agent 的事件通过 `parent_tool_use_id` 路由到 `handleSubagentStreamEvent`，与 Worker 自身的事件路由是独立的
- SDK 子 agent 的 thinking/text 等事件仍应正常路由（只是不创建新 Tab）

## 修复方案

在 `stream-processor.ts` 的 `task_started` 处理逻辑中，增加 `workerInfo` 判断。当 `processStream` 已在 Worker 运行时（即 `workerInfo` 存在），SDK 内部子 agent 的 `task_started` 事件不发送 `worker:started` 到前端，但仍创建 `SubagentState` 以保证事件正常路由。

### 改动 1：修改 task_started 处理逻辑

**文件**：`src/main/services/agent/stream-processor.ts`

在 `task_started` 系统消息处理块中（第 1387-1414 行），当 `workerInfo` 存在时，跳过发送 `worker:started` 事件，但仍创建 `SubagentState` 以支持 SDK 子 agent 的事件路由。

```typescript
// 在 task_started 处理中，创建 SubagentState 后：
if (workerInfo) {
  // Worker 内部 SDK 子 agent — 不发送 worker:started 到前端
  // 仅创建 SubagentState 用于事件路由，不创建新的前端 Tab
} else {
  // 非 Worker 场景（Leader 或普通对话）— 正常发送 worker:started
  sendEvent('worker:started', { ... });
}
```

### 改动说明

- **不修改** Worker 的 `additionalDisallowedTools`：Worker 仍可使用 SDK 内置 Agent/Task 工具拆分子任务，这是合理的能力
- **不修改**前端 `handleWorkerStarted` 或 `useWorkerTabs`：后端源头过滤更简洁，避免前端需要额外判断逻辑
- **不修改** SDK 子 agent 的事件路由：thinking/text 等事件通过 `handleSubagentStreamEvent` 独立路由，不受此改动影响

## 影响范围

- [ ] 涉及 API 变更 -> 无（仅修改后端事件发送条件）
- [ ] 涉及数据结构变更 -> 无
- [ ] 涉及功能设计变更 -> 无（仅修复 Worker 内部子 agent 的 Tab 创建策略）

## 开发前必读

编码前必须阅读以下文档，建立上下文：

1. **模块设计**：`.project/modules/agent/agent-core-v1.md` -- Agent 核心架构、processStream 流程
2. **流式处理设计**：`.project/modules/agent/features/stream-processing/design.md` -- stream-processor 事件处理机制、SubagentState 管理
3. **Worker 管理设计**：`.project/modules/agent/features/worker-management/design.md` -- Worker 生命周期、workerSessions Map
4. **功能 changelog**：
   - `.project/modules/agent/features/stream-processing/changelog.md`
   - `.project/modules/agent/features/tool-orchestration/changelog.md`
   - `.project/modules/agent/features/worker-management/changelog.md`
5. **相关 PRD**（前序修复）：
   - `.project/prd/bugfix/agent/bugfix-excessive-subagents-v1.md` -- Leader 多余子 Agent 修复（已 done）
   - `.project/prd/bugfix/agent/bugfix-remote-duplicate-subagent-v1.md` -- 远程模式重复子 Agent 修复（已 done）
6. **关键代码**：
   - `src/main/services/agent/stream-processor.ts` 第 1387-1437 行 -- `task_started` 处理逻辑
   - `src/main/services/agent/stream-processor.ts` -- `processStream` 函数签名及 `workerInfo` 参数
   - `src/main/services/agent/orchestrator.ts` 第 2041 行 -- 路径 A worker:started 发送
   - `src/main/services/agent/send-message.ts` 第 245 行 -- 路径 B worker:started 发送

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/stream-processor.ts` | 修改 | `task_started` 处理逻辑增加 `workerInfo` 判断，Worker 内部子 agent 不发送 `worker:started`（第 1387-1414 行） |
| `.project/modules/agent/features/tool-orchestration/changelog.md` | 追加 | 记录本次变更 |
| `.project/modules/agent/features/stream-processing/changelog.md` | 追加 | 记录本次变更 |
| `.project/prd/bugfix/agent/bugfix-excessive-subagents-v2.md` | 新建 | 本 PRD |

## 验收标准

### 核心功能

- [x] Worker 使用 SDK Agent/Task 工具时，不再产生额外的 Worker Tab
- [x] Hyper Space Worker（spawn_subagent 创建）仍然正常显示 Tab（路径 A、路径 B 不受影响）
- [x] Worker 内部 SDK 子 agent 的 thinking/text 事件仍正常路由，只是不创建新 Tab
- [x] Leader 的修复不受影响（v1 修复仍然生效，Leader 禁用了 Agent/Task 工具）

### 回归测试

- [x] 简单任务（Worker 不使用 Agent 工具）不受影响（workerTag 为 undefined 时走原逻辑）
- [x] 普通对话（非 Hyper Space）不受影响（无 workerTag，走原逻辑）
- [ ] 本地模式正常（需人工功能验证）
- [ ] 远程模式正常（需人工功能验证）

### 代码质量

- [x] `npm run typecheck` 通过（预存错误，本次改动无新增）
- [x] `npm run lint` 通过（预存 warning/error，本次改动无新增）
- [x] `npm run build` 通过

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-22 | 初始 Bug 修复 PRD（Worker 内部 SDK 子 agent 不再创建多余 Worker Tab） | @misakamikoto |
