# PRD [Bug 修复级] -- gh-search 系统提示词动态注入环境状态

> 版本：gh-search-dynamic-status-v1
> 日期：2026-05-08
> 指令人：用户
> 归属模块：modules/main/services (agent, gh-search)
> 严重程度：High
> 状态：in-progress

## 问题描述

### 期望行为

LLM 应能感知当前运行时 GitHub PAT 和网络代理的配置状态。当 gh-search 工具因网络问题失败时，LLM 应根据实际环境状态给出准确建议（如检查代理设置），而非一律告知用户"PAT 未配置"。

### 实际行为

用户已配置 GitHub PAT 和网络代理，gh-search MCP 工具在代理环境下应该能正常工作。但 LLM 遇到任何工具错误就默认"PAT 未配置"，误导用户去重复配置已存在的 PAT。

## 根因分析

系统提示词（`system-prompt.ts` 的 `SYSTEM_PROMPT_TEMPLATE`）中 GitHub Search 段落是**静态硬编码**的：

```
**Prerequisites:** A GitHub Personal Access Token must be configured in Settings > GitHub. GitHub CLI (gh) is optional.
```

LLM 无法知道运行时 PAT 和代理是否已配置。当工具因网络问题失败时，LLM 只能根据错误消息猜测，看到 403 或 "REST API failed" 就认为是认证问题。

`SystemPromptContext` 接口（`system-prompt.ts:38-53`）只包含 `workDir`、`modelInfo`、`platform` 等通用字段，没有 GitHub 配置状态。

## 修复方案

### 修改 1：SystemPromptContext 添加 ghSearchStatus 字段

**文件**：`src/main/services/agent/system-prompt.ts`

在 `SystemPromptContext` 接口中新增 `ghSearchStatus` 可选字段：

```typescript
export interface SystemPromptContext {
  workDir: string;
  modelInfo?: string;
  platform?: string;
  osVersion?: string;
  today?: string;
  isGitRepo?: boolean;
  allowedTools?: readonly string[];
  /** GitHub search environment status for dynamic system prompt */
  ghSearchStatus?: {
    patConfigured: boolean;
    proxyEnabled: boolean;
  };
}
```

### 修改 2：SYSTEM_PROMPT_TEMPLATE 动态化 GitHub 段落

**文件**：`src/main/services/agent/system-prompt.ts`

将第 205-225 行的静态 GitHub Search 段落中顶部的状态描述和 Prerequisites 部分替换为 `${GH_SEARCH_STATUS}` 占位符。保留原有的 Search Tools、View Tools、Common Search Qualifiers 和 Example 段落不变。

替换前（第 205-209 行）：

```
# GitHub Search

You have built-in GitHub capabilities via the MCP server "gh-search". Use these tools to search and view GitHub resources.

**Prerequisites:** A GitHub Personal Access Token must be configured in Settings > GitHub. GitHub CLI (gh) is optional.
```

替换后：

```
# GitHub Search

${GH_SEARCH_STATUS}
```

### 修改 3：buildSystemPrompt 处理 ghSearchStatus 替换

**文件**：`src/main/services/agent/system-prompt.ts`

在 `buildSystemPrompt()` 函数（第 239-257 行）中，根据 `ctx.ghSearchStatus` 生成动态的 GitHub Search 状态段落并替换 `${GH_SEARCH_STATUS}` 占位符。

三种状态的替换内容：

**PAT 已配置 + 代理已启用：**

```
You have built-in GitHub capabilities via the MCP server "gh-search". GitHub search is ready to use:
- GitHub PAT: configured
- Network proxy: enabled
- GitHub CLI (gh): optional

When using gh-search tools, they will authenticate via the configured PAT and route through the network proxy. These tools should work normally.

If a gh-search tool fails with a network or proxy error, do NOT ask the user to configure a GitHub PAT — it is already configured. Instead, suggest the user check their network proxy settings or retry the request.
```

**PAT 未配置：**

```
You have built-in GitHub capabilities via the MCP server "gh-search", but GitHub PAT is NOT configured.
- GitHub PAT: not configured

To use GitHub search tools, ask the user to configure a GitHub Personal Access Token in Settings > GitHub.
```

**PAT 已配置但代理未启用：**

```
You have built-in GitHub capabilities via the MCP server "gh-search". GitHub search is ready to use:
- GitHub PAT: configured
- Network proxy: not enabled (direct connection)

GitHub search tools are available and will authenticate via the configured PAT. If tools fail with network errors, the user may need to enable a network proxy in Settings.
```

当 `ctx.ghSearchStatus` 未提供时（向后兼容），使用默认的静态文本（保持原有行为）。

### 修改 4：send-message-local.ts 传入 ghSearchStatus

**文件**：`src/main/services/agent/send-message-local.ts`

在调用 `buildBaseSdkOptions()` 之前，检查 GitHub PAT 和代理状态，并通过 `SystemPromptContext.ghSearchStatus` 传入：

```typescript
import { getGitHubToken } from '../config.service';
import { getEffectiveProxyUrl } from '../proxy';

// 在构建 sdkOptions 前（约第 314 行之前）
const ghSearchStatus = {
  patConfigured: !!getGitHubToken(),
  proxyEnabled: !!getEffectiveProxyUrl(),
};
```

`buildBaseSdkOptions()` 在 `sdk-config.ts:608-611` 内部调用 `buildSystemPrompt({ workDir, modelInfo: ... })`。需要修改 `BaseSdkOptionsParams` 接口新增可选 `ghSearchStatus` 字段，并在 `buildBaseSdkOptions` 中将其传递给 `buildSystemPrompt()`。

具体改动点：

**文件**：`src/main/services/agent/sdk-config.ts`

- `BaseSdkOptionsParams` 接口新增 `ghSearchStatus?: { patConfigured: boolean; proxyEnabled: boolean }`
- `buildBaseSdkOptions()` 第 610 行的 `buildSystemPrompt({ workDir, modelInfo: ... })` 调用中，追加 `ghSearchStatus` 参数

**文件**：`src/main/services/agent/send-message-local.ts`

- 第 316 行的 `buildBaseSdkOptions({ ... })` 调用中，追加 `ghSearchStatus` 参数

注意：`send-message-local.ts:334-341` 中 AI Browser 启用时会覆盖 `sdkOptions.systemPrompt`，使用的是 `buildSystemPromptWithAIBrowser()`。需同步在该调用中传入 `ghSearchStatus`，或将 `ghSearchStatus` 提取为 SDK options 的独立字段。

### 修改 5：同步更新 GH_SEARCH_SYSTEM_PROMPT（index.ts）

**文件**：`src/main/services/gh-search/index.ts`

`GH_SEARCH_SYSTEM_PROMPT`（第 155 行）包含静态的 Prerequisites 段落：

```
### Prerequisites
- A GitHub Personal Access Token must be configured in Settings > GitHub
- GitHub CLI (gh) is optional — if searches fail, suggest the user configure a GitHub token in Settings
```

删除该 Prerequisites 段落（因为 system-prompt.ts 已动态处理），只保留工具文档部分（Search Tools、View Tools、Common Search Syntax、Usage Tips）。

### 修改 6：orchestrator.ts 也传入 ghSearchStatus

**文件**：`src/main/services/agent/orchestrator.ts`

orchestrator 中也创建了 gh-search MCP server（第 439-447 行）和调用 `buildBaseSdkOptions`（第 455 行）。需要同样传入 `ghSearchStatus`：

```typescript
import { getGitHubToken } from '../config.service';
import { getEffectiveProxyUrl } from '../proxy';

// 在 buildBaseSdkOptions 调用前
const ghSearchStatus = {
  patConfigured: !!getGitHubToken(),
  proxyEnabled: !!getEffectiveProxyUrl(),
};
```

在 `buildBaseSdkOptions({ ... })` 调用中追加 `ghSearchStatus`。

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/system-prompt.ts` | 修改 | `SystemPromptContext` 新增 `ghSearchStatus`；`SYSTEM_PROMPT_TEMPLATE` GitHub 段落动态化；`buildSystemPrompt()` 处理 `${GH_SEARCH_STATUS}` 替换 |
| `src/main/services/agent/sdk-config.ts` | 修改 | `BaseSdkOptionsParams` 新增 `ghSearchStatus` 可选字段；`buildBaseSdkOptions()` 传递 `ghSearchStatus` 给 `buildSystemPrompt()` |
| `src/main/services/agent/send-message-local.ts` | 修改 | 构建 `ghSearchStatus` 对象并传入 `buildBaseSdkOptions()` 和 `buildSystemPromptWithAIBrowser()` |
| `src/main/services/agent/orchestrator.ts` | 修改 | 构建 `ghSearchStatus` 对象并传入 `buildBaseSdkOptions()` |
| `src/main/services/gh-search/index.ts` | 修改 | `GH_SEARCH_SYSTEM_PROMPT` 删除静态 Prerequisites 段落 |

## 验收标准

### 核心功能

- [ ] PAT 已配置 + 代理已启用时，系统提示词包含 "GitHub PAT: configured" 和 "Network proxy: enabled"，并明确告知 LLM 不要建议用户配置 PAT
- [ ] PAT 未配置时，系统提示词包含 "GitHub PAT: not configured"，提示 LLM 引导用户配置 PAT
- [ ] PAT 已配置但代理未启用时，系统提示词显示 "Network proxy: not enabled (direct connection)"
- [ ] `ghSearchStatus` 未提供时（向后兼容），使用默认静态文本，不报错

### 代码质量

- [ ] `SystemPromptContext.ghSearchStatus` 为可选字段，现有调用方无需修改即可编译通过
- [ ] `GH_SEARCH_SYSTEM_PROMPT` 不再包含与 system-prompt.ts 重复的 Prerequisites 信息
- [ ] TypeScript 类型检查通过（`npm run typecheck`）
- [ ] 构建通过（`npm run build`）

### LLM 行为验证

- [ ] 用户已配置 PAT 和代理，gh-search 因网络临时故障失败时，LLM 不再提示"PAT 未配置"
- [ ] 用户确实未配置 PAT 时，LLM 正确引导用户去 Settings > GitHub 配置

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 源码文件 | `src/main/services/agent/system-prompt.ts` | 理解 `SystemPromptContext` 接口（第 38-53 行）、`SYSTEM_PROMPT_TEMPLATE` GitHub Search 段落（第 205-225 行）、`buildSystemPrompt()` 函数（第 239-257 行）的结构 |
| 源码文件 | `src/main/services/agent/send-message-local.ts` | 理解 gh-search MCP server 创建（第 311 行）和系统提示词构建的时机（第 334-341 行 AI Browser 覆盖 systemPrompt 的逻辑） |
| 源码文件 | `src/main/services/agent/orchestrator.ts` | 理解 orchestrator 中 gh-search 的创建（第 439-447 行）和 `buildBaseSdkOptions` 调用（第 455 行） |
| 源码文件 | `src/main/services/agent/sdk-config.ts` | 理解 `BaseSdkOptionsParams` 接口（第 90-117 行）、`buildBaseSdkOptions()` 函数中 systemPrompt 构建逻辑（第 608-611 行） |
| 源码文件 | `src/main/services/gh-search/index.ts` | 理解 `GH_SEARCH_SYSTEM_PROMPT` 结构（第 155-224 行），定位需删除的 Prerequisites 段落 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、纯类型导入用 `import type`、命名规范 |

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-08 | 初始 PRD：gh-search 系统提示词动态注入 GitHub PAT 和代理状态 | 用户 |
