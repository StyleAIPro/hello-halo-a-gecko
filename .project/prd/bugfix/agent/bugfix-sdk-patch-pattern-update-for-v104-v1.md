# PRD [Bug 修复级] — SDK Patch 脚本 pattern 失效：适配 0.2.104 版本变量名变更

> 版本：bugfix-sdk-patch-pattern-update-for-v104-v1
> 日期：2026-04-17
> 指令人：@moonseeker1
> 反馈人：@moonseeker1
> 归属模块：modules/agent
> 严重程度：Critical

## 问题描述

- **期望行为**：`scripts/patch-sdk.mjs` 在 SDK 0.2.104 下成功匹配并应用所有补丁（PATCH 1-5），使 ProcessTransport 转发所有选项（`cwd`、`settingSources`、`additionalDirectories` 等），Query 构造函数接收 `systemPrompt`，Session 类注入运行时控制方法
- **实际行为**：PATCH 3/4/5 匹配失败（警告 `Could not find ...`），导致远程 Agent 上的 `~/.claude/skills/` skill 全部检测不到，`setMaxThinkingTokens` 不可用
- **复现步骤**：
  1. 本地 SDK 升级到 `@anthropic-ai/claude-agent-sdk@0.2.104`（或远程 proxy 已使用 0.2.104）
  2. 运行 `node scripts/patch-sdk.mjs`
  3. 控制台输出 PATCH 1/2 成功，PATCH 3/4/5 均输出 WARNING 匹配失败
  4. 远程 Agent 发送消息 → CLI 子进程收到空 `settingSources` 和 `additionalDirectories` → skill 发现被跳过
  5. 调用 `setMaxThinkingTokens` → Session 类无此方法，调用失败

## 根因分析

### 背景

`scripts/patch-sdk.mjs` 的 PATCH 3/4/5 使用了 minifier 生成的变量名作为匹配 pattern。SDK 从旧版（约 0.2.97）升级到 0.2.104 后，minifier 重新生成了变量名，导致 pattern 中的变量名与实际代码不匹配。

### 变量名映射变化

| 补丁 | 旧版变量名 | 0.2.104 变量名 | 说明 |
|------|------------|----------------|------|
| PATCH 3 (ProcessTransport 构造函数) | `mX`（类名） | `aX`（类名） | ProcessTransport 的 minified 类名 |
| PATCH 3 (env 变量) | `J` | `Y` | env 参数变量名 |
| PATCH 4 (Query 构造函数) | `lX`（类名） | `sX`（类名） | Query 类的 minified 类名 |
| PATCH 5 (Session close 方法) | `UI`（超时时间） | 需确认 | close 方法中的 setTimeout 延迟值变量名 |

### 影响链路

```
SDK 0.2.104 minifier 变量名变更
    → PATCH 3 匹配失败
    → ProcessTransport 保持原始硬编码值（settingSources:[], 无 additionalDirectories）
    → CLI 子进程 if(additionalDirectories.length === 0) → skip skill discovery
    → ~/.claude/skills/ 下的 skill 全部检测不到

    → PATCH 5 匹配失败
    → Session 类缺少运行时方法注入
    → setMaxThinkingTokens / interrupt / pid 等方法不可用
```

### 本地 vs 远程影响差异

- **本地**：之前使用 SDK 0.2.97，该版本原生支持 `additionalDirectories` 转发，补丁失效不影响。但升级到 0.2.104 后本地也会出问题
- **远程 proxy**：已使用 0.2.104，PATCH 失效导致 skill 发现完全失效

## 修复方案

### 1. 更新 `scripts/patch-sdk.mjs` 中的变量名 pattern

将 PATCH 3/4/5 的匹配 pattern 中的旧变量名替换为 0.2.104 对应的值：

| 补丁 | 修改内容 |
|------|---------|
| PATCH 3 | `mX` → `aX`（类名），`J` → `Y`（env 变量名） |
| PATCH 4 | `lX` → `sX`（Query 类名） |
| PATCH 5 | `UI` → 0.2.104 对应的超时变量名（需在 `sdk.mjs` 中确认） |

同时更新替换文本（newMxCtor / newQueryCtor / newMethods）中引用的对应变量名。

### 2. 同步到 remote-agent-proxy

将 `scripts/patch-sdk.mjs` 的修改同步到 `packages/remote-agent-proxy/scripts/patch-sdk.mjs`（两份文件应保持一致）。

### 3. 确认根 package.json SDK 版本

根目录 `package.json` 中 `@anthropic-ai/claude-agent-sdk` 已为 `^0.2.104`，无需修改。

### 4. 重新编译 remote-agent-proxy

`packages/remote-agent-proxy/package.json` 已是 0.2.104，patch 脚本更新后需执行 `npm run build:proxy` 重新编译。

### 各 Patch 必要性评估

| 补丁 | 说明 | 是否仍需要 |
|------|------|-----------|
| PATCH 1: 移除 CLAUDE_CODE_ENTRYPOINT | 正则匹配 `[a-zA-Z]+\.CLAUDE_CODE_ENTRYPOINT`，不受变量名影响 | 需要（如果 0.2.104 仍有此赋值） |
| PATCH 2: 移除 CLAUDE_AGENT_SDK_VERSION | 正则匹配 `process.env.CLAUDE_AGENT_SDK_VERSION`，不受变量名影响 | 需要（如果 0.2.104 仍有此赋值） |
| PATCH 3: ProcessTransport 转发所有选项 | 需更新变量名 `mX→aX`、`J→Y` | 需要（0.2.104 硬编码了 `settingSources:[]`） |
| PATCH 4: Query 构造函数传 systemPrompt | 需更新变量名 `lX→sX` | 需验证 0.2.104 是否原生支持 preset systemPrompt |
| PATCH 5: Session 运行时方法注入 | 需更新变量名 `UI→?` | 需验证 0.2.104 是否原生有 pid getter 等方法 |

### 实施步骤

1. 打开 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`，确认 PATCH 5 的 `UI` 在 0.2.104 中的新变量名
2. 逐个更新 PATCH 3/4/5 的 `oldMxCtor`、`oldQueryCtor`、`oldClose` 中的变量名
3. 同步更新替换文本中引用的变量名（`newMxCtor` 中的 `J→Y`，`newQueryCtor` 中的 `lX→sX`）
4. 将修改同步到 `packages/remote-agent-proxy/scripts/patch-sdk.mjs`
5. 运行 `node scripts/patch-sdk.mjs` 验证 PATCH 1-5 全部成功
6. 运行 `npm run build:proxy` 重新编译远程代理

## 影响范围

- [ ] 涉及 API 变更 → 无
- [ ] 涉及数据结构变更 → 无
- [x] 涉及功能设计变更 → `modules/agent/features/sdk-patch/design.md`（需记录 0.2.104 变量名映射）

## 验证方式

1. 运行 `node scripts/patch-sdk.mjs` — 确认 PATCH 1-5 全部成功，无 WARNING
2. 检查 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` — 确认包含 `[PATCHED] AICO-Bot SDK patch applied` 标记
3. 远程 Agent 测试：发送消息 → 确认 `~/.claude/skills/` 下的 skill 被正确检测
4. 远程 Agent 测试：调用 `setMaxThinkingTokens` → 确认方法存在且生效
5. 本地 Agent 测试：创建会话发送消息 → 确认 cwd、systemPrompt 等选项正常转发

## 变更
| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-17 | 初始 PRD | @moonseeker1 |
