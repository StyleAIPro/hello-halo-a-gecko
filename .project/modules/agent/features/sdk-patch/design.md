# 功能 -- SDK Patch

> 日期：2026-04-16
> 指令人：@zhaoyinqi
> 来源 PRD：prd/module/agent/unified-sdk-patch-v1
> 所属模块：modules/agent

## 描述

通过运行时 patch 修改 `@anthropic-ai/claude-agent-sdk` 的 minified `sdk.mjs`，补齐 SDK 不支持但 AICO-Bot 需要的关键能力。统一脚本同时服务本地（Electron 主进程）和远程（remote-agent-proxy）两端。

## 依赖

- `@anthropic-ai/claude-agent-sdk` v0.2.104 — 被 patch 的目标
- `src/shared/constants/sdk.ts` — SDK 版本常量（`CLAUDE_AGENT_SDK_VERSION`）
- `src/main/bootstrap/essential.ts` — 本地启动时执行 patch
- `packages/remote-agent-proxy/scripts/build-with-timestamp.js` — 远端构建时执行 patch

## Patch 清单

### 选项转发（Patches 1-5）

| # | 名称 | 作用 | 目标类/方法 |
|---|------|------|------------|
| 1 | 移除 ENTRYPOINT | 移除 `CLAUDE_CODE_ENTRYPOINT` 赋值，伪装为原生 CLI 进程 | 全局 |
| 2 | ProcessTransport 选项转发 | 转发 cwd/stderr/extraArgs/maxTurns/maxBudgetUsd/fallbackModel/sandbox 等到 aX 构造器 | YW → aX |
| 3 | initConfig (systemPrompt) | 解析 systemPrompt 构建 initConfig 传入 sX 构造器 | YW → sX |
| 4 | 运行时控制方法 | 添加 interrupt/setModel/setMaxThinkingTokens/setPermissionMode/pid 到 Session | YW |
| 5 | 移除 SDK_VERSION | 移除硬编码 `CLAUDE_AGENT_SDK_VERSION` | 全局 |

### 轮级消息注入（Patches 6-10）

| # | 名称 | 作用 | 目标类/方法 |
|---|------|------|------------|
| 6 | 注入跟踪属性 | 在 Query 类添加 `_continueAfterResult`、`_pendingUserMessages` | sX |
| 7 | readMessages 拦截 | 在 `result` 事件入队后检查排队消息，有则注入 | sX.readMessages() |
| 8 | send 拦截 | 当 `firstResultReceived` 为 true 时，新消息入队而非直接发送 | YW.send() |
| 9 | stream 持续迭代 | `result` 后若有排队消息则 continue 而非 return | YW.stream() |
| 10 | 辅助方法 | 添加 `enableContinueConversation()`、`hasPendingMessages()`、`getPendingMessageCount()` | YW |

## 执行时机

### 本地（Electron 主进程）

在 `src/main/bootstrap/essential.ts` 的 `initializeEssentialServices()` 中同步执行：

```typescript
execFileSync(process.execPath, [patchScript], { stdio: 'pipe' })
```

位于阶段一（Essential），在 agent 相关模块初始化之前运行。确保所有后续 SDK 使用都被 patch。

### 远端（remote-agent-proxy）

在 `packages/remote-agent-proxy/scripts/build-with-timestamp.js` 构建脚本中执行：

```javascript
execSync('node ' + unifiedPatchScript, { cwd: rootDir, stdio: 'inherit' })
```

构建时 patch，部署产物已包含 patched SDK。

## 脚本位置

`scripts/patch-sdk.mjs`（项目根目录，本地和远端共用）

## SDK 版本升级指南

SDK 每次发布新版本时，minified 变量名会变化。升级步骤：

1. 更新 `src/shared/constants/sdk.ts` 中的 `CLAUDE_AGENT_SDK_VERSION`
2. 分析新版 `sdk.mjs` 的 minified 变量名映射
3. 更新 `scripts/patch-sdk.mjs` 中的匹配模式
4. 验证 10/10 patches 全部成功
5. 本地和远端分别测试

## 涉及文件

| 文件 | 角色 |
|------|------|
| `scripts/patch-sdk.mjs` | 统一 patch 脚本 |
| `src/shared/constants/sdk.ts` | SDK 版本常量 |
| `src/main/bootstrap/essential.ts` | 本地启动执行 |
| `packages/remote-agent-proxy/scripts/build-with-timestamp.js` | 远端构建执行 |
