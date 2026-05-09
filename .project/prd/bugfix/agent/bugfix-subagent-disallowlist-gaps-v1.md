---
时间: 2026-04-25
状态: in-progress
指令人: @moonseeker1
PRD 级别: bugfix
---

# Bugfix: 子 Agent 禁用遗漏 — 远程 App Runtime + 系统提示残留

## 需求分析

### 问题

上轮修复（`bugfix-default-subagent-suppression-v1`）在主要会话路径禁用了 Agent/Task 工具，但存在 3 个遗漏，导致子 Agent 仍被创建。

### 根因

| # | 问题 | 严重程度 | 位置 |
|---|------|---------|------|
| 1 | 远程 App Runtime（`streamChatForApp`）disallowedTools 仅有 `['WebFetch', 'WebSearch']`，缺少 `Agent`/`Task` | Critical | `packages/remote-agent-proxy/src/claude-manager.ts:2935` |
| 2 | App Runtime `prompt.ts` 的 `SUB_AGENT_INSTRUCTIONS` 仍然指导 Agent 使用 Task 工具做浏览器任务 | Critical | `src/main/apps/runtime/prompt.ts:87-102` |
| 3 | 系统提示的子 Agent 禁令仅覆盖 build/test/lint，未覆盖 search/check 等简单任务 | Major | `src/main/services/agent/system-prompt.ts:177` |

## 技术方案

### 1. 远程 App Runtime 补齐 disallowedTools

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts` line 2935

```typescript
// 改前
disallowedTools: ['WebFetch', 'WebSearch'],
// 改后
disallowedTools: ['WebFetch', 'WebSearch', 'Agent', 'Task'],
```

### 2. 删除 App Runtime 的 Task 工具引导

**文件**：`src/main/apps/runtime/prompt.ts`

删除 `SUB_AGENT_INSTRUCTIONS` 常量（line 87-102）及其引用（line 166-168）。App Runtime 的 `disallowedTools` 已包含 `Agent`/`Task`，引导 Agent 使用已禁用的工具会导致 SDK 报错。

### 3. 扩大系统提示子 Agent 禁令范围

**文件**：`src/main/services/agent/system-prompt.ts` line 177

将仅针对 build/test/lint 的禁令扩大为全面禁令：

```
改前：
- NEVER spawn a sub-agent (Task tool) for compilation, testing, linting, or type-checking tasks (...). Always run these commands directly via Bash.

改后：
- NEVER spawn a sub-agent (Task/Agent tool). Always perform all tasks directly using the available tools (Read, Write, Edit, Grep, Glob, Bash, Skill). No task is too complex for direct execution.
```

## 涉及文件

| # | 文件 | 说明 |
|---|------|------|
| 1 | `packages/remote-agent-proxy/src/claude-manager.ts` | `streamChatForApp` disallowedTools 补齐 |
| 2 | `src/main/apps/runtime/prompt.ts` | 删除 `SUB_AGENT_INSTRUCTIONS` 及引用 |
| 3 | `src/main/services/agent/system-prompt.ts` | 扩大子 Agent 禁令范围 |

## 验收标准

- [x] 远程 App Runtime 不再创建子 Agent
- [x] 本地 App Runtime 不再因 Task 引导导致报错
- [x] 普通对话中 search/check/test 任务不再委托给子 Agent
- [x] Hyper Space Worker 仍可创建子 Agent（`additionalAllowedTools: ['Task']` 不受影响）
- [x] `npm run build` 通过
