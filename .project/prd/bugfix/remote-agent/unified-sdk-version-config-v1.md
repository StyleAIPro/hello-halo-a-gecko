# PRD [Bug 修复级] — 统一管理 Claude Agent SDK 版本，清理 0.2.87 遗留物，记录 SDK Patch 机制

> 版本：unified-sdk-version-config-v1
> 日期：2026-04-16
> 指令人：@StyleAIPro
> 归属模块：modules/remote-agent
> 严重程度：Medium（版本管理不一致、遗留文件导致 postinstall 报错、SDK Patch 机制未文档化）
> 所属功能：features/remote-deploy

## 背景

`@anthropic-ai/claude-agent-sdk` 版本目前散落在 3 个地方，没有统一管理：

1. 根 `package.json` — `"@anthropic-ai/claude-agent-sdk": "0.2.104"`
2. `packages/remote-agent-proxy/package.json` — `"@anthropic-ai/claude-agent-sdk": "0.2.104"`
3. `src/main/services/remote-deploy/remote-deploy.service.ts` 第 71 行 — `const REQUIRED_SDK_VERSION = '0.2.104'`

升级 SDK 版本时需要手动同步 3 处，容易遗漏导致版本不一致。

此外，0.2.87 版本的遗留物未清理，旧的 patch 文件和 tgz 包仍然存在于仓库中，且根目录的 patch 文件会在 postinstall 时报错。SDK Patch 机制（运行时对 SDK 进行 monkey-patch）也未有文档记录。

## 遗留物清单

| 文件 | 位置 | 说明 |
|------|------|------|
| `@anthropic-ai+claude-agent-sdk+0.2.87.patch` | `patches/`（根目录） | 142KB，postinstall 时报错 |
| `@anthropic-ai+claude-agent-sdk+0.2.87.patch` | `packages/remote-agent-proxy/patches/` | 940B |
| `anthropic-ai-claude-agent-sdk-0.2.87.tgz` | 根目录 | 17MB，旧版 SDK 打包文件 |
| `package-lock.json` | `packages/remote-agent-proxy/` | 锁定在 0.2.87，需 `npm install` 更新 |

## SDK Patch 机制说明

`packages/remote-agent-proxy/scripts/patch-sdk.mjs` 会在部署时对 SDK 的 `sdk.mjs` 进行运行时 patch，共 6 个补丁操作：

### 补丁 1：移除 CLAUDE_CODE_ENTRYPOINT 标记（3 处）

SDK 在初始化时会设置 `process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts"`，标记进程为 SDK 模式。这会导致某些功能被限制。Patch 通过正则匹配移除所有赋值语句，让 SDK 进程伪装为原生 CLI 进程。

### 补丁 2：转发 Tz 构造器选项到 mX (ProcessTransport)

SDK 的 `unstable_v2_createSession`（Tz 类构造器）在创建底层 ProcessTransport (mX) 时，硬编码了 `extraArgs: {}`、`maxTurns: void 0`、`maxBudgetUsd: void 0` 等选项，导致调用方传入的 `cwd`、`stderr`、`extraArgs`、`maxTurns`、`maxBudgetUsd`、`sandbox` 等选项被忽略。Patch 将这些选项改为从调用方参数 `$.xxx` 中读取并转发。

### 补丁 3：传递 initConfig (systemPrompt) 到 Query

SDK 未将调用方传入的 `systemPrompt` 传递给 Query 构造器（lX），导致自定义系统提示词不生效。Patch 在 Query 构造前解析 `systemPrompt` 字符串，构建 `initConfig` 对象（包含 `systemPrompt`、`appendSystemPrompt`、`agents`）并传入。

### 补丁 4：添加 Tz 类方法

为 Tz 类补充 5 个运行时控制方法，使调用方可以在会话运行期间动态控制 Agent 行为：
- `interrupt()` — 中断当前 Agent 轮次
- `setModel(model)` — 动态切换模型
- `setMaxThinkingTokens(tokens)` — 动态调整最大思考 token 数
- `setPermissionMode(mode)` — 动态切换权限模式
- `pid` (getter) — 获取底层进程 PID

### 补丁 5：移除 CLAUDE_AGENT_SDK_VERSION 环境变量

SDK 硬编码了 `process.env.CLAUDE_AGENT_SDK_VERSION = "0.2.87"`，Patch 移除该赋值语句，避免版本号环境变量干扰。

### 补丁 6：添加 patch 标记

在文件头（shebang 之后）添加 `// [PATCHED] AICO-Bot SDK patch applied` 标记，防止重复 patch。脚本启动时会检查该标记，已 patch 则跳过。

### 为什么需要 patch

SDK 的 `unstable_v2_createSession` API 在设计上对部分选项（如 `cwd`、`systemPrompt`、`maxTurns` 等）做了硬编码或忽略，AICO-Bot 需要完整控制这些选项以支持远程部署、自定义系统提示词、运行时控制等功能。由于 SDK 未提供官方配置项，只能通过运行时 patch 来实现。

## 需求

### 需求 1：统一 SDK 版本常量

- 在 `src/shared/constants/` 中新增 SDK 版本常量文件 `sdk.ts`
- 导出 `CLAUDE_AGENT_SDK_VERSION = '0.2.104'`
- 在 `src/shared/constants/index.ts` 中 re-export
- `remote-deploy.service.ts` 中的 `REQUIRED_SDK_VERSION` 改为引用此常量
- 注：根 `package.json` 和 proxy `package.json` 仍各自声明依赖版本，这是 npm 机制要求，无法引用共享常量。常量主要用于运行时代码中的版本校验。

### 需求 2：清理 0.2.87 遗留物

- 删除 `patches/@anthropic-ai+claude-agent-sdk+0.2.87.patch`
- 删除 `packages/remote-agent-proxy/patches/@anthropic-ai+claude-agent-sdk+0.2.87.patch`
- 删除 `anthropic-ai-claude-agent-sdk-0.2.87.tgz`
- 在 `packages/remote-agent-proxy/` 下执行 `npm install` 更新 `package-lock.json`

### 需求 3：记录 SDK Patch 机制

- 在 `.project/modules/remote-agent/features/remote-deploy/design.md` 的末尾追加「SDK Patch 机制」章节，详细记录上述 6 个 patch 的用途和原理

### 需求 4：更新模块文档

- 在 `.project/modules/remote-agent/remote-agent-v1.md` 的「内部组件」表中添加 remote-agent-proxy 组件行
- 在功能列表中标注 SDK 版本管理相关的变更

## 变更范围

| 操作 | 文件/路径 |
|------|-----------|
| 新增 | `src/shared/constants/sdk.ts` |
| 修改 | `src/shared/constants/index.ts`（添加 re-export） |
| 修改 | `src/main/services/remote-deploy/remote-deploy.service.ts`（引用常量替换硬编码） |
| 修改 | `.project/modules/remote-agent/features/remote-deploy/design.md`（追加 SDK Patch 章节） |
| 修改 | `.project/modules/remote-agent/remote-agent-v1.md`（更新组件表和功能列表） |
| 删除 | `patches/@anthropic-ai+claude-agent-sdk+0.2.87.patch` |
| 删除 | `packages/remote-agent-proxy/patches/@anthropic-ai+claude-agent-sdk+0.2.87.patch` |
| 删除 | `anthropic-ai-claude-agent-sdk-0.2.87.tgz` |
| 更新 | `packages/remote-agent-proxy/package-lock.json`（npm install 更新） |

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 Bug 修复 PRD：统一 SDK 版本常量、清理 0.2.87 遗留物、记录 SDK Patch 机制 | @StyleAIPro |
