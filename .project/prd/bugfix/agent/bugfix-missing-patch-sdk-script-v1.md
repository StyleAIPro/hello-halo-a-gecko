# PRD [Bug 修复级] — 启动失败：缺少 patch-sdk.mjs 脚本文件

> 版本：bugfix-missing-patch-sdk-script-v1
> 日期：2026-04-17
> 指令人：@moonseeker1
> 反馈人：@moonseeker1
> 归属模块：modules/agent
> 严重程度：Critical

## 问题描述
- **期望行为**：应用正常启动，Electron 主进程 bootstrap 阶段一（Essential）完成初始化
- **实际行为**：应用启动失败，报错 `Error launching app - Unable to find Electron app at E:\Project\AICO-Bot\scripts\patch-sdk.mjs - Cannot find module 'E:\Project\AICO-Bot\scripts\patch-sdk.mjs'`
- **复现步骤**：
  1. 克隆仓库并安装依赖（`npm install`）
  2. 运行 `npm run dev` 启动开发服务器
  3. 应用启动失败，控制台输出上述错误

## 根因分析

### 背景

模块级 PRD `prd/module/agent/unified-sdk-patch-v1` 设计了统一 SDK Patch 脚本 `scripts/patch-sdk.mjs`，并在 `src/main/bootstrap/essential.ts` 第 45-58 行添加了启动时执行该脚本的代码。同时 PRD 要求删除旧的 `packages/remote-agent-proxy/scripts/patch-sdk.mjs`，由提交 `1228bfe` 完成。

### 问题根因

`scripts/patch-sdk.mjs` 文件**从未被提交到 Git 仓库**。具体原因分析：

1. `unified-sdk-patch-v1` PRD 实施时，`src/main/bootstrap/essential.ts` 添加了 SDK Patch 执行逻辑（第 45-58 行）
2. 提交 `1228bfe` 删除了旧的 `packages/remote-agent-proxy/scripts/patch-sdk.mjs`
3. 但新的统一脚本 `scripts/patch-sdk.mjs` **没有被添加到 Git**（可能是 `.gitignore` 排除或提交遗漏）
4. 合并提交 `3c006dd` 合入了 bootstrap 代码但未包含脚本文件本身

### 关键代码位置

| 文件 | 行号 | 说明 |
|------|------|------|
| `src/main/bootstrap/essential.ts` | 45-58 | 尝试执行 `scripts/patch-sdk.mjs`，文件不存在导致 `execFileSync` 抛出异常 |
| `scripts/patch-sdk.mjs` | 缺失 | 统一 SDK Patch 脚本，PRD 设计存在但文件未入库 |

### 异常传播机制

`essential.ts` 中的 try/catch 捕获了 `execFileSync` 的错误并 `console.error`，但该异常本身不会导致 Electron 崩溃。然而 Electron 报告的错误信息为 `Unable to find Electron app`，说明异常发生在 Electron 加载阶段，可能是 `path.join(__dirname, '..', '..')` 在某些环境下的路径计算将 `scripts/patch-sdk.mjs` 错误识别为应用入口点。

## 修复方案

需要在调研 `scripts/patch-sdk.mjs` 的历史版本（从 `packages/remote-agent-proxy/scripts/patch-sdk.mjs` 恢复）后，决定采用以下方案之一：

### 方案 A（推荐）：恢复脚本文件

从提交 `1228bfe` 之前的版本恢复 `packages/remote-agent-proxy/scripts/patch-sdk.mjs` 的内容，按 `unified-sdk-patch-v1` PRD 的设计重新创建 `scripts/patch-sdk.mjs` 并提交到仓库。

**步骤**：
1. 从 Git 历史恢复旧版 `packages/remote-agent-proxy/scripts/patch-sdk.mjs`
2. 按 `unified-sdk-patch-v1` PRD 的补丁清单（共 11 个补丁）更新脚本内容，适配 SDK 0.2.104
3. 将文件放入 `scripts/patch-sdk.mjs` 并提交
4. 验证 `npm run dev` 正常启动

### 方案 B（兜底）：移除 bootstrap 中的 patch 执行代码

如果 `scripts/patch-sdk.mjs` 的补丁功能在当前 SDK 版本下已不再需要（需确认 SDK 0.2.104 是否已内置选项转发等功能），则移除 `essential.ts` 第 45-58 行的 SDK Patch 代码块。

**步骤**：
1. 移除 `essential.ts` 第 45-58 行
2. 移除顶部 `import { execFileSync } from 'child_process'` 和 `import path from 'path'`（如无其他使用）
3. 更新 `modules/agent/features/sdk-patch/design.md` 记录变更
4. 验证 `npm run dev` 正常启动

### 方案选择依据

需先调研确认：
- SDK 0.2.104 是否已内置 cwd/systemPrompt/maxTurns 等选项转发（`session-manager.ts` 中 `// Requires SDK patch` 注释是否仍有效）
- 轮级消息注入（补丁 7-11）是否仍被需要（PRD 变更记录显示已回退中途发消息方案）

## 影响范围
- [ ] 涉及 API 变更 → 无
- [ ] 涉及数据结构变更 → 无
- [x] 涉及功能设计变更 → `modules/agent/features/sdk-patch/design.md`（需根据实际采用的修复方案更新）

## 验证方式

1. `npm run dev` — 应用正常启动，无 `Cannot find module` 错误
2. 检查控制台日志 — `[Bootstrap] SDK patch applied` 或确认 patch 逻辑已移除
3. 创建 Agent 会话发送消息 — 确认 SDK 功能正常（cwd、systemPrompt 等选项生效）
4. 在 Windows/macOS/Linux 上分别验证

## 变更
| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-17 | 初始 PRD | @moonseeker1 |
