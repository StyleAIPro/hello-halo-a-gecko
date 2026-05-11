# PRD [Bug 修复级] — 用户要求开子 Agent 时模型忽略请求

> 版本：bugfix-subagent-ignored-v1
> 日期：2026-05-10
> 状态：done
> 指令人：@misakamikoto
> 归属模块：modules/agent
> 严重程度：Critical

## 问题描述

### 期望行为

用户在聊天对话中要求 Claude 模型开启子 Agent 执行任务时，模型应尊重用户请求，使用 Task/Agent 工具创建子 Agent 来执行任务。用户简单提及"开子 Agent"即可生效，无需反复强调。

### 实际行为

模型完全忽略用户要求使用子 Agent 的请求，直接自己执行任务。用户必须在输入后明确强调"必须开子 Agent"才偶尔生效，体验极差。

### 复现步骤

1. 打开任意工作空间（本地模式）
2. 发送包含要求使用子 Agent 的消息，例如：
   - "帮我重构这个模块，开个子 agent 来做"
   - "用子 agent 执行这个任务"
   - "请用 Task 工具来完成这个搜索任务"
3. 观察到模型完全忽略子 Agent 请求，直接用内置工具自行执行

### 影响范围

- **本地模式**：受影响
- **远程模式**：受影响（远程代理的 fallback 系统提示包含相同的禁令）
- **Hyper Space Leader**：不受影响（Leader 通过 `disallowedTools` 硬禁用，设计正确）
- **Hyper Space Worker**：不受影响（Worker 允许使用子 Agent）
- **普通对话模式**：受影响（主要影响场景）

## 根因分析

### 直接原因：系统提示词使用绝对禁令措辞

**文件**: `src/main/services/agent/system-prompt.ts`，第 182 行

```typescript
- NEVER spawn a sub-agent (Task/Agent tool). Always perform all tasks directly using the available tools (Read, Write, Edit, Grep, Glob, Bash, Skill). No task is too complex for direct execution — including search, codebase exploration, analysis, verification, review, compilation, testing, linting, and any other operations.
```

该提示词来自前序修复 PRD `bugfix-excessive-subagents-v4`，目的是防止模型在普通对话中过度创建子 Agent。但使用了"NEVER"绝对禁令 + "No task is too complex" 的极端措辞，导致模型**无条件拒绝**使用子 Agent，即使明确被用户要求也是如此。

模型在面对系统提示词的"NEVER"指令和用户的"请开子 Agent"请求时，会优先遵循系统提示词（因为系统提示词的优先级在 LLM 对齐中被视为更高），从而忽略用户意图。

### 远程代理的相同问题

**文件**: `packages/remote-agent-proxy/src/claude-manager.ts`，第 449 行

```typescript
- NEVER spawn a sub-agent (Task/Agent tool). Always perform all tasks directly using the available tools (Read, Write, Edit, Grep, Glob, Bash, Skill). No task is too complex for direct execution.
```

远程代理的 fallback 系统提示包含相同的绝对禁令，远程模式同样受影响。

### 为什么不是 disallowedTools 的问题

普通对话的 SDK 配置中，`disallowedTools` 仅包含 `['WebFetch', 'WebSearch']`（`sdk-config.ts` 第 719 行），**并未**禁用 `Agent` 和 `Task` 工具。因此 Agent/Task 工具在 SDK 层面是完全可用的，问题纯粹出在系统提示词层面。

对比：Hyper Space Leader 通过 `orchestrator.ts` 第 469 行传入 `additionalDisallowedTools: ['Agent', 'Task']` 来硬禁用（SDK 层面拒绝），这是正确的设计。Leader 不应使用子 Agent（所有任务通过 `spawn_subagent` MCP 分派），而普通对话应该允许用户在需要时使用。

### 核心矛盾

| 场景 | 期望行为 | 当前行为 | 原因 |
|------|----------|----------|------|
| 用户未要求子 Agent | 直接执行（不创建子 Agent） | 直接执行 | 系统提示词禁令生效 |
| 用户明确要求子 Agent | 创建子 Agent 执行 | 仍直接执行 | "NEVER" 禁令覆盖用户请求 |

问题在于系统提示词缺乏条件判断：它应该**默认禁止**但**允许用户显式请求时使用**。

## 修复方案

### 策略：默认禁止 + 用户显式请求时允许

将系统提示词中的子 Agent 规则从"绝对禁止"改为"默认不使用，但用户明确要求时必须使用"。措辞原则：
- 默认行为：直接执行，不创建子 Agent
- 例外条件：用户在消息中明确要求使用子 Agent / Task 工具
- 不使用"NEVER"等绝对禁令词

### Change 1：修改主系统提示词（核心修复）

**文件**: `src/main/services/agent/system-prompt.ts`
**位置**: 第 182 行
**变更**: 将绝对禁令替换为条件规则

```typescript
// 替换前：
- NEVER spawn a sub-agent (Task/Agent tool). Always perform all tasks directly using the available tools (Read, Write, Edit, Grep, Glob, Bash, Skill). No task is too complex for direct execution — including search, codebase exploration, analysis, verification, review, compilation, testing, linting, and any other operations.

// 替换后：
- Do NOT proactively spawn a sub-agent (Task/Agent tool). Always perform tasks directly using the available tools (Read, Write, Edit, Grep, Glob, Bash, Skill) unless the user explicitly requests you to use a sub-agent or the Task tool. When the user explicitly asks to use a sub-agent, you MUST use the Task/Agent tool to delegate the task.
```

**效果**:
- 默认行为不变：模型不主动创建子 Agent（解决 v4 修复的过度创建问题）
- 用户显式请求时：模型必须使用 Task/Agent 工具（解决本次 bug）
- 不使用"NEVER"绝对禁令，使用"Do NOT proactively"条件规则

### Change 2：修改远程代理 fallback 系统提示词

**文件**: `packages/remote-agent-proxy/src/claude-manager.ts`
**位置**: 第 449 行
**变更**: 与主系统提示词保持一致

```typescript
// 替换前：
-- NEVER spawn a sub-agent (Task/Agent tool). Always perform all tasks directly using the available tools (Read, Write, Edit, Grep, Glob, Bash, Skill). No task is too complex for direct execution.

// 替换后：
-- Do NOT proactively spawn a sub-agent (Task/Agent tool). Always perform tasks directly using the available tools (Read, Write, Edit, Grep, Glob, Bash, Skill) unless the user explicitly requests you to use a sub-agent or the Task tool. When the user explicitly asks to use a sub-agent, you MUST use the Task/Agent tool to delegate the task.
```

### Change 3：远程代理 streamChat/streamChatForApp 的 disallowedTools 移除 Agent/Task

**文件**: `packages/remote-agent-proxy/src/claude-manager.ts`
**位置**: 第 928 行和第 3008 行
**变更**: 从 `disallowedTools` 中移除 `'Agent'` 和 `'Task'`

```typescript
// 替换前（第 928 行）：
disallowedTools: ['WebFetch', 'WebSearch', 'Agent', 'Task'],

// 替换后：
disallowedTools: ['WebFetch', 'WebSearch'],

// 替换前（第 3008 行）：
disallowedTools: ['WebFetch', 'WebSearch', 'Agent', 'Task'],

// 替换后：
disallowedTools: ['WebFetch', 'WebSearch'],
```

**说明**: 远程代理的 `streamChat` 和 `streamChatForApp` 当前通过 `disallowedTools` 硬禁用了 Agent/Task，这意味着即使修改了系统提示词，远程模式下 Task 工具仍然不可用。需要移除此硬禁用，改为依赖系统提示词的条件规则。

**风险评估**: 远程代理的 `streamChat` 对应普通对话场景，与本地模式的 `sendMessage` 对等，应该允许用户显式请求子 Agent。`streamChatForApp` 是 App Runtime 场景，App 运行时的自动化任务确实不需要子 Agent，但 App Runtime 有自己的独立系统提示词（`prompt.ts`），不再包含子 Agent 相关指令（已在 v4 中清理），因此即使工具可用，模型也不会主动使用。

## 影响范围评估

| 场景 | 修复前 | 修复后 | 影响 |
|------|--------|--------|------|
| 普通对话（本地）- 无子 Agent 请求 | 直接执行 | 直接执行（不变） | 无变化 |
| 普通对话（本地）- 用户要求子 Agent | 直接执行（bug） | 创建子 Agent | 修复 bug |
| 普通对话（远程）- 无子 Agent 请求 | 直接执行 | 直接执行（不变） | 无变化 |
| 普通对话（远程）- 用户要求子 Agent | 工具被硬禁用，无法创建 | 创建子 Agent | 修复 bug |
| Hyper Space Leader | SDK 硬禁用 Agent/Task | SDK 硬禁用 Agent/Task（不变） | 无变化 |
| Hyper Space Worker | 可创建子 Agent | 可创建子 Agent（不变） | 无变化 |
| App Runtime | SDK 硬禁用 Agent/Task | 工具可用但无提示词鼓励 | 极低风险 — App 有独立系统提示词 |

**风险评估**:
- **风险低**: 仅修改系统提示词措辞和移除远程代理的硬禁用，不涉及逻辑变更
- **默认行为不变**: 模型仍然默认不创建子 Agent，仅当用户显式请求时才使用
- **Leader 不受影响**: Leader 通过 `disallowedTools` 硬禁用，不受系统提示词修改影响
- **Worker 不受影响**: Worker 未禁用 Agent/Task，行为不变

## 开发前必读

| 类别 | 文件路径 | 阅读目的 |
|------|----------|----------|
| 模块设计 | `.project/modules/agent/agent-core-v1.md` | 理解 Agent 模块整体架构 |
| 功能设计 | `.project/modules/agent/features/message-send/design.md` | 理解消息发送流程和 SDK 选项构建 |
| 功能设计 | `.project/modules/agent/features/tool-orchestration/design.md` | 理解 disallowedTools 传递链路 |
| 功能变更日志 | `.project/modules/agent/features/message-send/changelog.md` | 了解消息发送最近变更 |
| 前序 PRD | `.project/prd/bugfix/agent/bugfix-excessive-subagents-v4.md` | 理解 v4 全面禁令的设计背景和修改内容 |
| 前序 PRD | `.project/prd/bugfix/agent/bugfix-excessive-subagents-v1.md` | 理解 v1 Leader 硬禁用的设计背景 |
| 源码文件 | `src/main/services/agent/system-prompt.ts` | 修改系统提示词中的子 Agent 规则（第 182 行） |
| 源码文件 | `src/main/services/agent/sdk-config.ts` | 确认普通对话的 disallowedTools 配置（无需修改） |
| 源码文件 | `src/main/services/agent/send-message-local.ts` | 确认 buildBaseSdkOptions 调用参数（无需修改） |
| 源码文件 | `src/main/services/agent/orchestrator.ts` | 确认 Leader 的 additionalDisallowedTools 不受影响（无需修改） |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts` | 修改 fallback 系统提示词（第 449 行）+ 移除 disallowedTools 中的 Agent/Task（第 928、3008 行） |
| 编码规范 | `docs/Development-Standards-Guide.md` | 遵循 TypeScript strict、命名规范等 |

## 涉及文件

| 文件 | 变更类型 | 变更描述 |
|------|----------|----------|
| `src/main/services/agent/system-prompt.ts` | 修改 | 第 182 行：将"NEVER spawn a sub-agent"绝对禁令替换为"Do NOT proactively"条件规则 |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 修改 | 第 449 行：同步修改 fallback 系统提示词；第 928 行和第 3008 行：从 disallowedTools 中移除 'Agent' 和 'Task' |

## 验收标准

- [x] **普通对话不主动创建子 Agent**：发送搜索、检查、分析等任务指令（不提及子 Agent），确认模型直接使用 Read/Grep/Glob/Bash 等工具执行
- [x] **用户要求开子 Agent 时生效**：发送"帮我搜索项目中所有使用 useState 的文件，开个子 agent 来做"或"请用 Task 工具来完成"，确认模型使用 Task/Agent 工具创建子 Agent
- [x] **用户简单提及即可生效**：仅说"开子 agent"或"用子 agent 执行"，不需要反复强调
- [x] **Hyper Space Leader 不受影响**：确认 Leader 仍通过 disallowedTools 硬禁用 Agent/Task
- [x] **Hyper Space Worker 不受影响**：确认 Worker 仍可正常使用子 Agent
- [x] **远程模式用户请求子 Agent 生效**：在远程工作空间中要求使用子 Agent，确认 Task 工具可用且模型会使用
- [x] **类型检查通过**：`npm run typecheck`
- [x] **构建通过**：`npm run build`

## 变更

| 日期 | 变更内容 |
|------|----------|
| 2026-05-10 | 初稿创建 |
