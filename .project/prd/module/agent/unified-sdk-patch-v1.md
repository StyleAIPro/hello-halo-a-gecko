# PRD [模块级] — 统一 SDK Patch 与中途消息机制

> 版本：unified-sdk-patch-v1
> 日期：2026-04-16
> 指令人：@zhaoyinqi
> 归属模块：modules/agent（跨模块：agent + remote-agent）
> 关联模块：modules/remote-agent

## 背景

AICO-Bot 的本地（Electron 主进程）和远程（remote-agent-proxy）都通过运行时 patch 修改 `@anthropic-ai/claude-agent-sdk` 的 minified `sdk.mjs`，但当前存在三个严重问题：

### 问题一：Patch 逻辑分裂且不对齐

本地和远程各有一个独立的 patch 脚本，覆盖不同功能，且均未适配 SDK 0.2.104：

| | 本地 `sdk-turn-injection-patch.ts` | 远端 `patch-sdk.mjs` |
|---|---|---|
| 选项转发（cwd/systemPrompt/maxTurns 等） | 无 | 有，已适配 0.2.104 |
| 消息注入（turn-level injection） | 有，但适配的是旧版本且是死代码 | 无 |
| ENTRYPOINT 移除 | 无 | 有 |
| SDK_VERSION 移除 | 无 | 有 |
| pid getter | 无 | 有 |

**本地 `sdk-turn-injection-patch.ts` 是死代码**：没有任何模块 import 它，它注入的方法（`enableContinueConversation`、`hasPendingMessages`）也没有调用方。

**本地缺少选项转发 patch**：`session-manager.ts:682` 标注了 `// Requires SDK patch: native SDK ignores most sdkOptions parameters`，但本地没有执行任何选项转发 patch。传给 `unstable_v2_createSession` 的 `cwd`、`systemPrompt`、`maxTurns`、`includePartialMessages` 等被 SDK 静默忽略。

### 问题二：用户中途发消息的体验差

**本地当前流程**：
1. Agent 正在处理任务 A（可能几分钟）
2. 用户发现问题，发了纠正消息
3. 前端将消息存入 `session.pendingMessages` 队列，**不调 interrupt**
4. Agent 继续执行任务 A 直到完成
5. `handleAgentComplete` 检测到队列，才发送纠正消息

**问题**：用户要等 Agent 把整个错误任务跑完才能纠正，浪费时间。

**远端当前流程**：
1. Agent 正在处理任务 A
2. 用户发了新消息
3. **无排队机制**，新消息直接发送，与正在进行的 stream 产生竞态条件
4. 可能导致消息丢失、重复处理、SDK 状态损坏

### 问题三：本地和远端行为不一致

本地有排队但无 interrupt，远端有 interrupt 但无排队，两端行为完全不同。

## 需求

### 需求 1：统一 SDK Patch 脚本

创建一个统一的 SDK patch 脚本，合并本地和远端的所有 patch 功能。本地和远端都使用同一个脚本。

**Patch 功能清单（全部适配 SDK 0.2.104）：**

| # | 补丁名称 | 作用 | 来源 |
|---|---------|------|------|
| 1 | 移除 CLAUDE_CODE_ENTRYPOINT | 移除赋值，伪装为原生 CLI 进程 | 远端 patch-sdk.mjs |
| 2 | 转发 Tz 构造器选项到 ProcessTransport | 转发 cwd/stderr/extraArgs/maxTurns/maxBudgetUsd/sandbox 等 | 远端 patch-sdk.mjs |
| 3 | 传递 initConfig (systemPrompt) 到 Query | 解析 systemPrompt 构建 initConfig 传入 | 远端 patch-sdk.mjs |
| 4 | 添加 Tz 类运行时控制方法 | 补充 pid getter（0.2.104 已内置 interrupt/setModel/setMaxThinkingTokens/setPermissionMode） | 远端 patch-sdk.mjs |
| 5 | 移除 CLAUDE_AGENT_SDK_VERSION | 移除硬编码版本号 | 远端 patch-sdk.mjs |
| 6 | 添加 patch 标记 | `[PATCHED]` 防重复 | 远端 patch-sdk.mjs |
| 7 | 轮级消息注入 — Query 属性 | 在 Query 类添加 `_continueAfterResult`、`_pendingUserMessages` 跟踪属性 | 本地 sdk-turn-injection-patch.ts |
| 8 | 轮级消息注入 — readMessages 拦截 | 在 `result` 事件入队后检查排队消息，有则注入 | 本地 sdk-turn-injection-patch.ts |
| 9 | 轮级消息注入 — send 拦截 | result 后的新消息改为入队而非直接发送 | 本地 sdk-turn-injection-patch.ts |
| 10 | 轮级消息注入 — stream 持续迭代 | result 后若有排队消息则 continue 而非 return | 本地 sdk-turn-injection-patch.ts |
| 11 | 轮级消息注入 — 辅助方法 | Tz 类添加 `enableContinueConversation()`、`hasPendingMessages()`、`getPendingMessageCount()` | 本地 sdk-turn-injection-patch.ts |

**脚本位置**：`scripts/patch-sdk.mjs`（项目根目录，独立于 remote-agent-proxy）

**注意**：原始 `sdk-turn-injection-patch.ts` 中的匹配模式是非 minified 风格的（如 `pendingMcpResponses = new Map;`），在 0.2.104 的 minified 代码中无法匹配。新脚本必须使用 minified 变量名进行匹配（如 `sX`、`B1`、`B2` 等）。

### 需求 2：本地启动时执行 Patch

在 Electron 主进程启动阶段（bootstrap），在首次使用 SDK 之前执行 `scripts/patch-sdk.mjs`，确保本地 SDK 也被正确 patch。

执行时机：在 `src/main/bootstrap/` 的阶段一（Essential）中，在 agent 相关模块初始化之前。

### 需求 3：统一中途发消息流程

> **[2026-04-17 变更]** 回退中途发消息方案：移除立即 interrupt + SDK patch 消息注入机制，改为等待当前任务自然完成后处理排队消息。原因：SDK patch 的 turn-level injection 在 interrupt 后注入消息会导致 SDK 内部消息处理错误。

**目标行为（本地和远端统一）：**

1. Agent 正在处理任务 A
2. 用户发现问题，发了纠正消息
3. 前端将消息入队 `pendingMessages`，**不触发 interrupt**
4. Agent 继续执行任务 A 直到自然完成
5. `handleAgentComplete` 检测到队列中有排队消息，自动发送下一条消息作为新请求
6. Agent 处理纠正消息

**本地改造（`src/renderer/stores/chat.store.ts` + `src/main/services/agent/send-message.ts`）：**

- `sendMessage()` 中，当 `isGenerating === true` 时：
  1. 将消息入队 `pendingMessages`（保留现有逻辑）
  2. **不触发** `stopGeneration()` / `api.stopGeneration()`（不 interrupt）
- `handleAgentComplete` 中检测 `pendingMessages` 队列，有排队消息则自动发送下一条作为新请求（使用现有 pendingMessages 处理逻辑）

**远端改造（`packages/remote-agent-proxy/src/server.ts` + `claude-manager.ts`）：**

- `handleClaudeChat()` 中，当已有活跃 stream 时：
  1. 将消息入队
  2. **不触发** interrupt
- 新增消息队列管理机制
- 与本地一致，stream 完成后检测队列，有排队消息则发送下一条

**SDK Patch 补丁 7-11（轮级消息注入）说明：**

补丁 7-11（`_continueAfterResult`、`_pendingUserMessages`、readMessages/send 拦截、stream 持续迭代、辅助方法）仍然会应用到 SDK，但**不再用于中途发消息流程**。这些补丁保留在统一脚本中供未来其他场景使用。

### 需求 4：清理旧代码

- 删除 `src/main/services/agent/sdk-turn-injection-patch.ts`（被统一脚本替代）
- 删除 `packages/remote-agent-proxy/scripts/patch-sdk.mjs`（被统一脚本替代）
- 更新 `packages/remote-agent-proxy` 的部署流程，改为使用 `scripts/patch-sdk.mjs`
- 清理 `session-manager.ts` 中 `// Requires SDK patch` 相关的 `as any` 类型转换，改为正确的类型

### 需求 5：更新项目文档

- 更新 `.project/modules/agent/` 下的相关文档（agent-core-v1.md 内部组件表、功能列表等）
- 新增 `.project/modules/agent/features/sdk-patch/design.md`（SDK Patch 功能设计文档）
- 更新 `.project/modules/agent/features/sdk-session/design.md`（记录 patch 集成到 session 流程的变化）
- 更新 `.project/modules/agent/features/message-send/design.md`（记录中途消息流程的变化）
- 更新 `.project/modules/remote-agent/features/remote-deploy/design.md` 中的 SDK Patch 机制章节
- 更新 `.project/modules/remote-agent/features/websocket-client/design.md`（记录远端消息排队机制）
- 更新各受影响功能的 `changelog.md`

## 功能规划

| # | 功能 | 优先级 | 归属模块 | 功能设计 |
|---|------|--------|---------|---------|
| 1 | SDK Patch 脚本 | P0 | agent | modules/agent/features/sdk-patch/design.md（新增） |
| 2 | 本地 Patch 启动集成 | P0 | agent | modules/agent/features/sdk-session/design.md |
| 3 | 中途消息统一流程 | P0 | agent | modules/agent/features/message-send/design.md |
| 4 | 远端消息排队 | P0 | remote-agent | modules/remote-agent/features/websocket-client/design.md |
| 5 | 旧代码清理 | P1 | agent + remote-agent | 本 PRD 需求 4 |

## 变更范围

| 操作 | 文件/路径 |
|------|-----------|
| 新增 | `scripts/patch-sdk.mjs`（统一 SDK patch 脚本） |
| 修改 | `src/main/bootstrap/` 阶段一（添加本地 patch 执行） |
| 修改 | `src/renderer/stores/chat.store.ts`（sendMessage 中 isGenerating 时仅入队不触发 interrupt） |
| 修改 | `src/main/services/agent/send-message.ts`（handleAgentComplete 处理排队消息） |
| 修改 | `packages/remote-agent-proxy/src/server.ts`（添加消息排队，不自动 interrupt） |
| 修改 | `packages/remote-agent-proxy/src/claude-manager.ts`（stream 完成后处理排队消息） |
| 修改 | `src/main/services/agent/session-manager.ts`（清理 as any 类型转换） |
| 修改 | `packages/remote-agent-proxy/package.json`（部署流程更新） |
| 删除 | `src/main/services/agent/sdk-turn-injection-patch.ts` |
| 删除 | `packages/remote-agent-proxy/scripts/patch-sdk.mjs` |
| 修改 | `.project/modules/agent/agent-core-v1.md` |
| 新增 | `.project/modules/agent/features/sdk-patch/design.md` |
| 修改 | `.project/modules/agent/features/sdk-patch/changelog.md`（新增） |
| 修改 | `.project/modules/agent/features/sdk-session/design.md` |
| 修改 | `.project/modules/agent/features/sdk-session/changelog.md` |
| 修改 | `.project/modules/agent/features/message-send/design.md` |
| 修改 | `.project/modules/agent/features/message-send/changelog.md` |
| 修改 | `.project/modules/remote-agent/features/remote-deploy/design.md` |
| 修改 | `.project/modules/remote-agent/features/remote-deploy/changelog.md` |
| 修改 | `.project/modules/remote-agent/features/websocket-client/design.md` |
| 修改 | `.project/modules/remote-agent/features/websocket-client/changelog.md` |
| 修改 | `.project/changelog/CHANGELOG.md` |

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 PRD | @zhaoyinqi |
| 2026-04-16 | 实施完成：5 个需求全部落地，远端中途消息改用 SDK patch 注入方案（非队列+新请求模式） | @zhaoyinqi |
| 2026-04-17 | 回退需求 3 中途发消息方案：移除立即 interrupt + SDK patch 消息注入，改为排队等待自然完成后发送下一条。原因：SDK patch turn-level injection 在 interrupt 后注入消息导致 SDK 内部消息处理错误 | @zhaoyinqi |
