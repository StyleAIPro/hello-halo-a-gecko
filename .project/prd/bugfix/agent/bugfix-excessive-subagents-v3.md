# PRD [Bug 修复级] — 模型为编译/测试任务创建多余子 Agent

> 版本：bugfix-excessive-subagents-v3
> 日期：2026-04-23
> 状态：in-progress
> 指令人：@misakamikoto
> 归属模块：modules/agent
> 严重程度：Medium
> 前序 PRD：
> - `.project/prd/bugfix/agent/bugfix-excessive-subagents-v1.md`（已 done — Leader 禁用 Agent/Task 工具）
> - `.project/prd/bugfix/agent/bugfix-excessive-subagents-v2.md`（已 done — Worker 内部子 Agent 不创建多余 Tab）

## 问题描述

### 期望行为

模型声明创建 N 个子 Agent 时，实际应只创建 N 个。编译、测试、lint 等命令应直接通过 Bash 工具执行，不应为此创建子 Agent。

### 实际行为

执行复杂任务时，模型声明创建 4 个子 Agent，实际创建了 6 个。多余的 2 个子 Agent 分配的任务是编译或测试。本地模式和远程模式均会出现此问题。

### 复现步骤

1. 发送一个需要多步骤处理的复杂任务（涉及代码改动 + 编译 + 测试）
2. 模型规划创建 N 个子 Agent 执行代码改动
3. 模型额外创建 2 个子 Agent，分别用于 `npm run build` 和 `npm test`
4. 实际子 Agent 数量 > 声明数量，多余子 Agent 浪费资源

### 影响范围

- **本地模式**：会出现
- **远程模式**：也会出现
- **Hyper Space 模式**：Worker 角色会出现（Leader 已被 v1 禁用 Agent/Task 工具）
- **非 Hyper Space 模式**：普通对话也会出现

## 根因分析

v1 和 v2 修复分别解决了 Leader 层面的 Agent/Task 工具禁用和 Worker 内部子 Agent 的 Tab 过滤，但**没有解决模型行为层面的根因**：系统提示词中没有明确禁止用子 Agent 执行编译/测试/lint 任务。

当模型执行复杂任务时，倾向于并行化以提高效率。在拆分任务时，编译和测试被视为独立的子任务，模型会使用 SDK 内置 Task 工具创建子 Agent 来执行这些命令。但这些命令（`npm run build`、`npm test`、`npm run lint` 等）具有以下特征：
- 执行时间短（通常 < 30 秒）
- 输出确定性高（同样的代码产生同样的结果）
- 不需要独立上下文或隔离环境
- 通过 Bash 直接执行即可，无需子 Agent 开销

此外，v2 修复中 `isWorkerTask` 字段虽然在远程代理的 `ChatOptions` 接口中定义，但从未在 `streamChat()` 中实际使用，导致远程模式下 Worker 内部子 Agent 仍会产生多余的 Worker Tab。

## 修复方案

采用"提示词禁令 + 远程防御"两层策略。

### 改动 1：系统提示词增加编译/测试禁令（主要修复）

**文件**：`src/main/services/agent/system-prompt.ts`

在 `## File and Code Operations` 部分中（约第 178 行后），插入新条目：

```
- NEVER spawn a sub-agent (Task tool) for compilation, testing, linting, or type-checking tasks (e.g., npm run build, npm test, npm run lint, cargo build, pytest, tsc --noEmit, etc.). Always run these commands directly via Bash. Build/test/lint commands are fast, deterministic, and do not benefit from sub-agent isolation.
```

此修改通过远程部署同步机制（`remote-deploy.service.ts`）自动传播到远程服务器。

### 改动 2：远程代理 fallback prompt 同步禁令

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

在 `buildSystemPrompt()` 的 fallback prompt 中（约第 447 行后），插入：

```
- NEVER spawn a sub-agent for build, test, lint, or type-check commands. Always run these directly via Bash (e.g., npm run build, npm test, cargo build).
```

### 改动 3：远程代理接入 isWorkerTask 过滤（防御性修复）

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

在 `streamChat()` 方法中：

1. 方法顶部提取 `const suppressWorkerEvents = !!options.isWorkerTask`
2. `task_started` 处理（~line 2230）：`worker:started` yield 用 `if (!suppressWorkerEvents)` 包裹
3. `task_notification` 处理（~line 2253）：`worker:completed` yield 用 `if (!suppressWorkerEvents)` 包裹
4. finally 块中断清理（~line 2528）：`wasAborted` 改为 `wasAborted && !suppressWorkerEvents`

## 影响范围

- [ ] 涉及 API 变更 → 无
- [ ] 涉及数据结构变更 → 无
- [ ] 涉及功能设计变更 → 无（仅修复子 Agent 创建策略 + 远程事件过滤）

## 开发前必读

1. **模块设计**：`.project/modules/agent/agent-core-v1.md` — Agent 核心架构
2. **流式处理设计**：`.project/modules/agent/features/stream-processing/design.md` — 事件处理机制、SubagentState
3. **功能 changelog**：
   - `.project/modules/agent/features/tool-orchestration/changelog.md`
   - `.project/modules/agent/features/stream-processing/changelog.md`
   - `.project/modules/agent/features/sdk-session/changelog.md`
4. **相关 PRD**：
   - `.project/prd/bugfix/agent/bugfix-excessive-subagents-v1.md` — Leader 禁用（已 done）
   - `.project/prd/bugfix/agent/bugfix-excessive-subagents-v2.md` — Worker Tab 过滤（已 done）
5. **关键代码**：
   - `src/main/services/agent/system-prompt.ts` 第 165-190 行 — Tool usage policy
   - `packages/remote-agent-proxy/src/claude-manager.ts` 第 180-193 行 — ChatOptions 接口
   - `packages/remote-agent-proxy/src/claude-manager.ts` 第 2213-2260 行 — 子 Agent 事件处理
   - `packages/remote-agent-proxy/src/claude-manager.ts` 第 2520-2538 行 — finally 清理

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/system-prompt.ts` | 修改 | 插入 build/test/lint 子 Agent 禁令（~line 178） |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 修改 | fallback prompt 禁令 + isWorkerTask 过滤 4 处（lines 447, 2230, 2253, 2528） |
| `.project/modules/agent/features/tool-orchestration/changelog.md` | 追加 | 记录提示词变更 |
| `.project/modules/agent/features/stream-processing/changelog.md` | 追加 | 记录远程事件过滤变更 |
| `.project/modules/agent/features/sdk-session/changelog.md` | 追加 | 记录 isWorkerTask 接入 |
| `.project/prd/bugfix/agent/bugfix-excessive-subagents-v3.md` | 新建 | 本 PRD |

## 验收标准

### 核心功能

- [ ] 执行复杂任务时，build/test/lint 命令通过 Bash 直接执行，不创建子 Agent
- [ ] 模型声明创建的子 Agent 数量与实际数量一致
- [ ] Hyper Space Worker 仍可使用 Agent/Task 工具执行非编译/测试的合理子任务
- [ ] 远程模式下 Worker 内部子 Agent 不产生多余 Worker Tab

### 回归测试

- [ ] 简单任务不受影响（无编译/测试时行为不变）
- [ ] 非 Hyper Space 模式正常
- [ ] 远程模式正常
- [ ] Leader 禁用不受影响（v1 修复仍然生效）

### 代码质量

- [ ] `npm run typecheck` 通过（预存错误，本次改动无新增）
- [ ] `npm run lint` 通过（预存 warning/error，本次改动无新增）
- [x] `npm run build` 通过

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-23 | 初始 Bug 修复 PRD（提示词禁令 + 远程 isWorkerTask 防御） | @misakamikoto |
