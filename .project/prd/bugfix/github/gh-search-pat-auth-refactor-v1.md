# PRD [Bug 修复级] -- gh-search MCP PAT 认证重构

> 版本：gh-search-pat-auth-refactor-v1
> 日期：2026-05-03
> 指令人：moonseeker
> 归属模块：modules/main/services (gh-search, skill, agent)
> 严重程度：High
> 状态：in-progress
> 关联 PRD：`.project/prd/bugfix/github/github-auth-proxy-fix-v1.md`

## 问题描述

### 期望行为

gh-search MCP 服务器应能使用已配置的 GitHub PAT token 进行认证，在不依赖 gh CLI 的情况下完成所有 GitHub 搜索和查看操作。pushSkillAsPR 等技能操作也应通过 PAT 走 REST API，而非依赖 gh CLI。

### 实际行为

1. **MCP 服务器仅使用 gh CLI 认证**：`sdk-mcp-server.ts` 的 `execGh()` 直接调用 `gh` 二进制，配置中的 PAT 未被使用
2. **代理/防火墙环境下 gh CLI 无法认证**：即使有有效 PAT，gh CLI（Go 二进制）在 MITM 代理下因 TLS 证书校验失败而报错
3. **pushSkillAsPR 完全依赖 gh CLI**：`github-skill-source.service.ts` 使用 `exec('gh api ...')` 执行所有 GitHub API 操作，代理环境下全部失败
4. **getGitHubToken 是 async 的 gh CLI 调用**：通过 `gh auth token` shell 命令获取 token，而非直接读取配置
5. **用户被迫安装 gh CLI**：即使已有 PAT，仍需安装 gh CLI 才能使用 GitHub 搜索功能

### 根因分析

### 根因 1：PAT 未传递给 MCP 服务器

`github-auth-proxy-fix-v1` PRD 修复了 PAT 登录问题（`proxyFetch` 添加 User-Agent、统一代理等），但 gh-search MCP 服务器内部并未使用 PAT。`execGh()` 只通过 gh CLI 发起请求，PAT 虽已存储在 `config.json` 中却未被利用。

### 根因 2：getGitHubToken 依赖 gh CLI 而非 config

`github-skill-source.service.ts` 的 `getGitHubToken()` 实现为 `exec('gh auth token')`，是从 gh CLI 运行时获取 token 而非从 `config.service.ts` 读取配置。`config.service.ts` 中已有同步的 `getGitHubToken()` 函数但未被引用。

### 根因 3：pushSkillAsPR 全部使用 gh CLI exec

`pushSkillAsPR()` 中所有操作（获取用户名、检查 fork、创建分支、上传文件、创建 PR）都通过 `execAsync(\`"${ghBin}" api ...\`)` 执行，这些调用在代理环境下全部失败。

### 根因 4：gh CLI 重复解析逻辑

`getGhBinaryPath()` 在 `sdk-mcp-server.ts` 和 `github-skill-source.service.ts` 中各有一份几乎相同的实现，使用 `require` 动态导入 Electron 模块。`github-auth.service.ts` 中已有导出的 `resolveGhBinary()` 但未被使用。

### 根因 5：SDK 日志误导

OpenAI 兼容模式下 `sdkModel` 被设为假的 `claude-sonnet-4-6`（用于 SDK 内部路由），`setModel()` 会将这个假模型名打印到日志，用户看到的是错误的模型信息。

## 修复方案

### 修改 1：MCP 服务器添加 REST API 直连（PAT 优先）

**文件**：`src/main/services/gh-search/sdk-mcp-server.ts`

- 删除本地 `getGhBinaryPath()` 函数，改用 `github-auth.service.ts` 导出的 `resolveGhBinary()`
- 新增 `ghApiDirect(args, token, timeout)` — 解析 gh CLI 参数并映射到对应的 GitHub REST API 端点，通过 `proxyFetch` + PAT 发请求
  - 支持 `search repos/issues/prs/code/commits`、`issue view`、`pr view`、`repo view` 等命令
- 新增 `ghApiFallback(args, error)` — gh CLI 失败时自动回退到 REST API
- 新增 `buildSearchParams()`、`parseViewArgs()`、`parseRepoViewArgs()` 辅助函数
- `execGh()` 执行策略：PAT REST API 优先 → gh CLI 次之 → gh CLI 失败时 REST API 兜底

### 修改 2：gh-search 模块入口认证状态重构

**文件**：`src/main/services/gh-search/index.ts`

- `checkGhCliStatus()` 返回类型改为 `GhSearchAuthStatus`，包含 `patAuth` 和 `ghCli` 两个部分
- PAT 认证检查：通过 `proxyFetch('https://api.github.com/user')` + PAT headers
- gh CLI 检查降级为可选，仅做可用性+认证状态检查
- 删除 `getGhBinaryPath` 的 re-export，改用 `resolveGhBinary` from `github-auth.service.ts`
- 更新 `GH_SEARCH_SYSTEM_PROMPT`：PAT 为必需前提，gh CLI 为可选

### 修改 3：技能 GitHub 操作全部改为 REST API

**文件**：`src/main/services/skill/github-skill-source.service.ts`

- 删除本地 `getGhBin()` 函数和 async `getGitHubToken()`（原为 `gh auth token`）
- 改为 re-export `config.service.ts` 的同步 `getGitHubToken()`
- `listRepoDirectories()` 从 `await getGitHubToken()` 改为同步 `getGitHubToken()`
- `pushSkillAsPR()` 完全重写：
  - 获取用户名：`proxyFetch(GITHUB_API_BASE/user)` 替代 `gh api user --jq ".login"`
  - 检查 fork：`proxyFetch(GITHUB_API_BASE/repos/${repo})` 替代 `gh api /repos/${repo} --jq ".fork"`
  - 创建分支：REST API 替代 `gh api ... -X PUT -f ...`
  - 上传文件：REST API 替代 `gh api ... --input ...`
  - 创建 PR：REST API 替代 `gh pr create ...`

### 修改 4：getGitHubToken 调用从 async 改为 sync

**文件**：`src/main/services/skill/skill-market-service.ts`、`src/main/controllers/skill.controller.ts`

- `await githubSkillSource.getGitHubToken()` → `githubSkillSource.getGitHubToken()`（同步调用）

### 修改 5：新增组合认证状态 IPC 通道

**文件**：`src/main/ipc/github.ts`

- 新增 `github:auth-status-combined` handler，调用 `getCombinedGitHubAuthStatus()`
- 旧 `github:auth-status` 标记为 DEPRECATED

### 修改 6：系统提示词更新

**文件**：`src/main/services/agent/system-prompt.ts`

- 前提条件从 "gh CLI must be installed and authenticated" 改为 "A GitHub Personal Access Token must be configured in Settings > GitHub. GitHub CLI (gh) is optional."

### 修改 7：SDK 配置重构 — 兼容模型标识

**文件**：`src/main/services/agent/sdk-config.ts`

- `ResolvedSdkCredentials` 新增 `isCompatModel?: boolean` 标记
- 重构 `resolveCredentialsForSdk()`：使用 `detectNativeAnthropic()` 区分原生 Anthropic 和 OpenAI 兼容后端
- 非 Anthropic 后端标记 `isCompatModel = true`，`sdkModel` 设为 `claude-sonnet-4-6`（SDK 内部路由用）
- 导入 `normalizeApiUrl` 用于自动拼接 `/v1/chat/completions`

### 修改 8：Agent 消息发送跳过兼容模型 setModel

**文件**：`src/main/services/agent/send-message.ts`

- `setModel()` 调用增加 `!resolvedCredentials.isCompatModel` 条件，避免将假模型名 `claude-sonnet-4-6` 打印到日志

### 修改 9：远程部署 SDK 检查优化

**文件**：`src/main/services/remote-deploy/remote-deploy.service.ts`

- SDK 版本检查先尝试本地 `node_modules` 路径（快速路径，适用于离线部署），失败再回退到 `npm list -g`（慢路径）

### 修改 10：前端完整重写 — PAT 优先的 GitHub 设置页

**文件**：`src/preload/index.ts`、`src/renderer/api/index.ts`、`src/renderer/components/settings/GitHubSection.tsx`

- Preload 暴露 `githubGetAuthStatusCombined` API
- Renderer API 导出 `githubGetAuthStatusCombined` 方法
- `GitHubSection.tsx` 完整重写：
  - `CombinedAuthStatus` 类型：`pat`（primary）+ `ghCli`（optional）两部分
  - PAT 为唯一必需认证方式，gh CLI 仅在可用时显示为可选
  - 简化状态管理：删除双认证状态追踪（`directStatus`/`authStatus`），合并为单一 `authStatus`
  - 删除 `directToken`/`isDirectLoggingIn`/`directCredMessage` 等冗余状态

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/gh-search/sdk-mcp-server.ts` | 修改 | 删除本地 `getGhBinaryPath()`；新增 `ghApiDirect()`、`ghApiFallback()`、`buildSearchParams()`、`parseViewArgs()`、`parseRepoViewArgs()`；`execGh()` 支持 PAT 优先 + gh CLI 回退 |
| `src/main/services/gh-search/index.ts` | 修改 | `checkGhCliStatus()` 返回 `GhSearchAuthStatus`（pat + ghCli）；PAT 通过 `proxyFetch` 验证；gh CLI 降级为可选；更新系统提示词 |
| `src/main/services/skill/github-skill-source.service.ts` | 修改 | 删除 `getGhBin()` 和 async `getGitHubToken()`；re-export sync `getGitHubToken()`；`pushSkillAsPR()` 全部改为 REST API |
| `src/main/services/skill/skill-market-service.ts` | 修改 | `getGitHubToken()` 调用从 async 改为 sync；日志格式化 |
| `src/main/controllers/skill.controller.ts` | 修改 | `getGitHubToken()` 调用从 async 改为 sync |
| `src/main/ipc/github.ts` | 修改 | 新增 `github:auth-status-combined` handler；`github:auth-status` 标记 DEPRECATED |
| `src/main/services/agent/system-prompt.ts` | 修改 | 前提条件改为 PAT 必需、gh CLI 可选 |
| `src/main/services/agent/sdk-config.ts` | 修改 | `ResolvedSdkCredentials` 新增 `isCompatModel`；重构 `resolveCredentialsForSdk()` 使用 `detectNativeAnthropic()`；导入 `normalizeApiUrl` |
| `src/main/services/agent/send-message.ts` | 修改 | `setModel()` 跳过兼容模型 |
| `src/main/services/remote-deploy/remote-deploy.service.ts` | 修改 | SDK 检查先查本地 `node_modules`（快速路径），再回退 `npm list -g` |
| `src/preload/index.ts` | 修改 | `AicoBotAPI` 新增 `githubGetAuthStatusCombined` |
| `src/renderer/api/index.ts` | 修改 | 新增 `githubGetAuthStatusCombined` 方法 |
| `src/renderer/components/settings/GitHubSection.tsx` | 修改 | 完整重写：PAT 为唯一必需认证；gh CLI 为可选；`CombinedAuthStatus` 类型；简化状态管理 |

## 验收标准

### 核心功能

- [ ] 配置有效 PAT 后，gh-search MCP 服务器能通过 REST API 完成搜索操作（repos/issues/PRs/code/commits），无需 gh CLI
- [ ] gh CLI 可用时，MCP 服务器仍能通过 gh CLI 工作（PAT 不可用时自动回退）
- [ ] `pushSkillAsPR()` 通过 REST API 完成（获取用户、检查 fork、创建分支、上传文件、创建 PR），无需 gh CLI
- [ ] 代理/防火墙环境下（有效 PAT + proxyFetch），所有 GitHub 操作正常工作
- [ ] `getGitHubToken()` 为同步函数，直接从 config 读取，不再依赖 gh CLI

### 前端

- [ ] GitHub 设置页以 PAT 为唯一必需认证方式
- [ ] gh CLI 仅在可用时显示为可选信息
- [ ] 认证状态通过 `githubGetAuthStatusCombined` 获取，包含 `pat` 和 `ghCli` 两部分

### SDK / Agent

- [ ] 系统提示词正确描述 PAT 为必需、gh CLI 为可选
- [ ] OpenAI 兼容模式下不再打印误导性的 `setModel: claude-sonnet-4-6` 日志
- [ ] 原生 Anthropic 后端走 passthrough 路径不受影响

### 代码质量

- [ ] `sdk-mcp-server.ts` 删除了本地 `getGhBinaryPath()`，使用 `resolveGhBinary()` from `github-auth.service.ts`
- [ ] `github-skill-source.service.ts` 删除了本地 `getGhBin()` 和 async `getGitHubToken()`
- [ ] TypeScript 类型检查通过（`npm run typecheck`）
- [ ] ESLint 检查通过（`npm run lint`）
- [ ] 构建通过（`npm run build`）

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计文档 | `.project/prd/bugfix/github/github-auth-proxy-fix-v1.md` | 理解前置修复：PAT 登录、proxyFetch 统一、`resolveGhBinary()` 导出 |
| 源码文件 | `src/main/services/gh-search/sdk-mcp-server.ts` | 理解 MCP 工具定义和 `execGh()` 执行流程 |
| 源码文件 | `src/main/services/gh-search/index.ts` | 理解模块入口、认证状态检查、系统提示词 |
| 源码文件 | `src/main/services/skill/github-skill-source.service.ts` | 理解技能 GitHub 操作和 `pushSkillAsPR()` 实现 |
| 源码文件 | `src/main/services/github-auth.service.ts` | 理解 `resolveGhBinary()`、`getCombinedGitHubAuthStatus()` 实现 |
| 源码文件 | `src/main/services/proxy/proxy-fetch.ts` | 理解 `proxyFetch()` 代理请求流程 |
| 源码文件 | `src/main/services/agent/sdk-config.ts` | 理解 SDK 凭证解析和 `ResolvedSdkCredentials` 类型 |
| 源码文件 | `src/main/services/agent/send-message.ts` | 理解 `setModel()` 调用位置和逻辑 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、IPC 常量化、命名规范 |

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-03 | 初始 PRD：gh-search MCP PAT 认证重构（补记） | moonseeker |
