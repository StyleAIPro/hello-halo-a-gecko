# PRD [Bug 修复级] — Hyper Space Leader 创建过多子 Agent

> 版本：bugfix-excessive-subagents-v1
> 日期：2026-04-22
> 状态：done
> 指令人：@misakamikoto
> 归属模块：modules/agent
> 严重程度：Medium

## 问题描述

### 期望行为

Hyper Space Leader 声明创建 N 个子 Agent 时，实际应只创建 N 个。所有子 Agent 通过 `spawn_subagent` MCP 工具创建，职责明确，无多余子 Agent。

### 实际行为

模型声明创建 4 个子 Agent，实际创建了 6 个。多余的 2 个子 Agent 由 SDK 内置 Agent 工具创建，与 `spawn_subagent` 创建的 Worker 子 Agent 职责重叠，毫无作用。本地模式和远程模式均会出现此问题。

### 复现步骤

1. 启用 Hyper Space 团队模式（包含 Leader + 多个 Worker）
2. 发送一个需要多步骤处理的任务（如"重构认证模块"）
3. 观察 NestedWorkerTimeline — Leader 声明创建 4 个 Worker 子任务，但实际出现 6 个子 Agent
4. 多余的子 Agent 输出与已有 Worker 重叠或为冗余分析

### 影响范围

- **本地模式**：会出现
- **远程模式**：也会出现（系统提示同步到远程服务器后生效）
- **非 Hyper Space 模式**：不受影响

## 根因分析

存在两个独立的子 Agent 创建机制同时活跃，导致 Leader 重复创建子 Agent。

### 机制 1：SDK 内置 Agent 工具

- 工具名：`Agent` / `Task`
- 来源：Claude Code SDK 内置
- 始终可用，基础系统提示（`system-prompt.ts`）中强烈鼓励使用：
  - 第 174 行：`"prefer to use the Task tool in order to reduce context usage"`
  - 第 175 行：`"You should proactively use the Task tool"`
  - 第 178 行：强制并行 Task 调用（`"MUST send a single message with multiple Task tool calls"`）
  - 第 180 行：`"VERY IMPORTANT... CRITICAL that you use the Task tool"`

### 机制 2：Hyper Space `spawn_subagent` MCP 工具

- 来源：Hyper Space MCP Server（`createHyperSpaceMcpServer()`）
- 专门用于团队协作，Leader 通过此工具向 Worker 分派任务
- Leader 系统提示（`buildLeaderSystemPrompt()`）描述了两条分派路径：
  - `spawn_subagent` — 向 Worker 分派（推荐路径）
  - SDK Agent 工具 — 仅限本地分析/规划场景（第 2985-2989 行）

### 冲突原因

LLM（Claude）在收到任务后：

1. 通过 `spawn_subagent` MCP 工具创建 N 个 Worker 子任务（符合设计意图）
2. 同时因为基础系统提示中 `"proactively use the Task tool"` 的强烈鼓励，又用 SDK 内置 Agent 工具创建额外子 Agent（多余）

Leader 系统提示虽然在规则中提到 "NEVER use Agent tool for tasks that belong to Workers"（第 3083 行），但同时又在第 2985-2989 行给出了 Agent 工具的使用场景（"purely analytical/planning work"），造成指令矛盾。LLM 倾向于遵循基础系统提示的强烈鼓励（`CRITICAL`、`VERY IMPORTANT` 等措辞），从而创建多余的子 Agent。

**核心矛盾**：
- 基础系统提示：全局鼓励积极使用 Task 工具（`system-prompt.ts`）
- Leader 系统提示：仅限制"属于 Worker 的任务"不能用 Agent 工具，但允许其他场景（`orchestrator.ts` 第 2985-2989 行）
- 实际效果：LLM 对"不属于 Worker"的解释过于宽松，大量创建冗余子 Agent

## 修复方案

采用"禁用 + 约束 + 弱化"三层防御策略，从工具可用性、Leader 提示词、基础提示词三个层面同时修复。

### 改动 1：Hyper Space Leader 禁用 SDK 内置 Agent 工具（硬约束）

在 SDK 配置层面，为 Leader 角色添加 `disallowedTools`，从根源上禁止 SDK 内置 Agent 工具。

**文件**：`src/main/services/agent/sdk-config.ts`

1. 在 `BaseSdkOptionsParams` 接口中（第 108 行之后）添加可选参数：
   ```typescript
   /** Additional tools to disallow (merged with default disallowedTools) */
   additionalDisallowedTools?: string[];
   ```

2. 在 `buildBaseSdkOptions()` 中（第 588 行），将 `additionalDisallowedTools` 合并到 `disallowedTools` 数组：
   ```typescript
   disallowedTools: ['WebFetch', 'WebSearch', ...(params.additionalDisallowedTools ?? [])],
   ```

**文件**：`src/main/services/agent/orchestrator.ts`

在 `executeAgentLocally()` 方法中（第 452 行 `buildBaseSdkOptions` 调用处），当 `agentRole === 'leader'` 时传入禁用参数：
```typescript
const sdkOptions = buildBaseSdkOptions({
  credentials: resolvedCredentials,
  workDir,
  electronPath,
  spaceId,
  conversationId: childConversationId,
  abortController,
  stderrHandler: ...,
  mcpServers,
  contextWindow: resolvedCredentials.contextWindow,
  // Leader 禁用 SDK 内置 Agent 工具，所有分派走 spawn_subagent
  ...(agentRole === 'leader' && { additionalDisallowedTools: ['Agent', 'Task'] }),
});
```

**效果**：Leader 的 SDK 会话在工具列表中直接移除 Agent 和 Task 工具，即使 LLM 尝试调用也会被 SDK 拒绝。

### 改动 2：强化 Leader 系统提示约束（软约束）

修改 `buildLeaderSystemPrompt()` 方法中的 Agent 工具相关描述，从"限制使用场景"改为"完全禁止"。

**文件**：`src/main/services/agent/orchestrator.ts`

1. **第 2974-2991 行**：重写 "CRITICAL: When to use spawn_subagent vs Agent Tool" 部分

   删除 Agent 工具的使用场景描述（第 2985-2989 行），将 RULE 改为完全禁止：
   ```
   ### CRITICAL: Task Delegation

   You have ONE way to delegate work:

   **`spawn_subagent` (MCP tool)** — Assigns a task to a **team Worker**. The worker
   executes the task in its own Claude Code session on its own machine.

   **RULE: NEVER use the built-in Agent/Task tool — all delegation MUST go through
   `spawn_subagent`. The Agent/Task tool is DISABLED for your session.**
   ```

2. **第 3082-3083 行**：将 "Important Rules" 第 1 条从条件禁止改为绝对禁止：
   ```
   1. **NEVER use the built-in Agent/Task tool** — These tools are DISABLED for your
      session. All task delegation MUST use `spawn_subagent` with the matching
      `targetAgentId`.
   ```

**效果**：即使改动 1 的 `disallowedTools` 未生效（如 SDK 版本差异），提示词约束仍能防止 LLM 尝试调用 Agent 工具。

### 改动 3：弱化基础系统提示对 Task 工具的过度鼓励（全局优化）

降低基础系统提示中 Task 工具的使用鼓励强度，避免在非 Hyper Space 场景下也过度创建子 Agent。

**文件**：`src/main/services/agent/system-prompt.ts`

1. **第 174 行**：
   - 原：`"prefer to use the Task tool in order to reduce context usage"`
   - 改：`"consider using the Task tool for codebase exploration"`

2. **第 175 行**：
   - 原：`"You should proactively use the Task tool with specialized agents when the task at hand matches the agent's description."`
   - 改：`"You may use the Task tool when appropriate. Use it sparingly — only when the subtask is truly independent and benefits from isolation."`

3. **第 178 行**：移除关于并行 Task 工具调用的强制要求（`"MUST send a single message with multiple Task tool calls"` 整行删除）

4. **第 180 行**：
   - 原：`"VERY IMPORTANT: When exploring the codebase to gather context... it is CRITICAL that you use the Task tool with subagent_type=Explore"`
   - 改：`"When exploring the codebase broadly, consider using the Task tool with subagent_type=Explore"`

**效果**：基础提示词从"强烈鼓励"降级为"适当使用"，减少非 Hyper Space 场景下的过度分派，同时不影响合理场景下的 Task 工具使用。

## 影响范围

- [x] 涉及 API 变更 → 无（`BaseSdkOptionsParams` 新增可选字段，向后兼容）
- [ ] 涉及数据结构变更 → 无
- [ ] 涉及功能设计变更 → 无（仅修复子 Agent 创建策略）

## 开发前必读

编码前必须阅读以下文档，建立上下文：

1. **模块设计**：`.project/modules/agent/agent-core-v1.md` — Agent 核心架构、executeAgentLocally 流程
2. **SDK 配置设计**：`.project/modules/agent/features/sdk-session/design.md` — SDK 选项构建、disallowedTools 机制
3. **工具编排设计**：`.project/modules/agent/features/tool-orchestration/design.md` — 工具可用性控制
4. **Worker 管理设计**：`.project/modules/agent/features/worker-management/design.md` — Hyper Space 子 Agent 生命周期
5. **功能 changelog**：
   - `.project/modules/agent/features/tool-orchestration/changelog.md`
   - `.project/modules/agent/features/worker-management/changelog.md`
   - `.project/modules/agent/features/sdk-session/changelog.md`
6. **相关 PRD**（前序修复）：
   - `.project/prd/bugfix/agent/bugfix-remote-duplicate-subagent-v1.md` — 远程模式重复子 Agent 修复（已 done）
   - `.project/prd/bugfix/agent/bugfix-remote-subagent-v1.md` — 远程子 Agent 可见性修复（已 done）

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/sdk-config.ts` | 修改 | `BaseSdkOptionsParams` 新增 `additionalDisallowedTools` 字段（第 111 行）；`buildBaseSdkOptions()` 合并到 `disallowedTools`（第 590 行） |
| `src/main/services/agent/orchestrator.ts` | 修改 | `executeAgentLocally()` Leader 角色传入 `additionalDisallowedTools`（第 454 行）；`buildLeaderSystemPrompt()` 重写 Agent 工具规则为完全禁止（第 2976-2992 行）；Important Rules 第 1 条强化（第 3080 行） |
| `src/main/services/agent/system-prompt.ts` | 修改 | 弱化基础提示词中 Task 工具的鼓励措辞（第 174、175、177、179 行） |

## 验收标准

### 核心功能

- [x] Hyper Space Leader 不再通过 SDK 内置 Agent 工具创建额外子 Agent — 实际子 Agent 数量与声明一致
- [x] Hyper Space Worker 不受影响 — Worker 仍可正常使用 SDK 内置 Agent 工具（仅禁用 Leader）
- [x] 普通对话（非 Hyper Space）中 Task 工具仍可使用 — 功能不受影响，只是鼓励程度降低

### 提示词一致性

- [x] Leader 系统提示中不再出现 Agent 工具的允许使用场景描述
- [x] Leader 系统提示中 "Important Rules" 第 1 条为绝对禁止 Agent 工具
- [x] 基础系统提示中不再包含 "CRITICAL"、"VERY IMPORTANT"、"proactively"、"MUST" 等 Task 工具强制使用措辞

### 模式兼容性

- [ ] 本地模式生效 — Leader 不创建多余子 Agent（需人工功能验证）
- [ ] 远程模式同步生效 — 系统提示修改会同步部署到远程服务器（需人工功能验证）
- [ ] 非 Hyper Space 模式回归测试通过 — 普通对话、单 Agent 场景不受影响（需人工功能验证）

### 代码质量

- [x] `npm run typecheck` 通过（预存错误，本次改动无新增）
- [x] `npm run lint` 通过（预存 warning/error，本次改动无新增）
- [x] `npm run build` 通过

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-22 | 初始 Bug 修复 PRD（三层防御：SDK 禁用 + Leader 提示强化 + 基础提示弱化） | @misakamikoto |
