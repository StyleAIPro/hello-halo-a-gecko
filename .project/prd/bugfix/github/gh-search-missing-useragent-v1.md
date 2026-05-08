# PRD [Bug 修复级] -- gh-search REST API 缺少 User-Agent 请求头导致代理环境认证失败

> 版本：gh-search-missing-useragent-v1
> 日期：2026-05-08
> 指令人：用户
> 归属模块：modules/main/services (gh-search)
> 严重程度：High
> 状态：in-progress
> 关联 PRD：`.project/prd/bugfix/github/github-auth-proxy-fix-v1.md`、`.project/prd/bugfix/github/gh-search-pat-auth-refactor-v1.md`

## 问题描述

### 期望行为

用户已配置 GitHub PAT 和网络代理，使用 gh-search MCP 工具搜索 GitHub 时应能通过 REST API + 代理正常完成请求。

### 实际行为

gh-search MCP 工具报错"GitHub认证未配置"，但实际上 PAT 已正确配置。

### 复现步骤

1. 在代理/内网环境下启动 AICO-Bot
2. 确保系统配置了 HTTP 代理（Clash/V2Ray 等）
3. 在设置页配置有效的 GitHub PAT token
4. 触发 gh-search MCP 工具（如搜索 GitHub 仓库）
5. 观察：报错"GitHub认证未配置"

### 影响范围

- **代理/内网环境**：必现
- **外网直连环境**：不受影响（直连走 `fetch()` 自动附带 User-Agent）
- **影响功能**：所有 gh-search MCP 工具（搜索 repos/issues/PRs/code/commits、查看 issue/PR/repo）

## 根因分析

`gh-search-pat-auth-refactor-v1` PRD 将 gh-search MCP 从纯 gh CLI 模式重构为 PAT REST API 优先 + gh CLI 回退，但 `ghApiDirect()` 的 headers 构建遗漏了 `User-Agent`。

### 故障链路

1. `execGh()` 检测到 PAT 存在，调用 `ghApiDirect(args, token, timeout)`
2. `ghApiDirect()` 构建 headers：`Authorization`、`Accept`、`X-GitHub-Api-Version`，但**没有 `User-Agent`**
3. `proxyFetch()` -> `fetchViaProxy()` -> Node.js `https.request()`，不会自动添加 User-Agent
4. 代理/网关做 DPI 检查，缺少 User-Agent 的请求被拒绝（403）
5. `ghApiDirect()` 回退到 direct `fetch()`，但直连 GitHub API 在中国网络环境下不通
6. `execGh()` 回退到 gh CLI，但 gh CLI 调用时未传入 PAT 环境变量（`GH_TOKEN`），CLI 也认证失败
7. 最终错误被 LLM 解读为"GitHub认证未配置"

### 对比：项目中其他 GitHub API 调用点均已添加 User-Agent

| 文件 | 行号 | 说明 |
|------|------|------|
| `src/main/services/auth/github-auth.service.ts` | ~324 | `validateGitHubToken()` 已有 User-Agent |
| `src/main/services/skill/github-api.ts` | ~34 | 已有 User-Agent |
| `src/main/services/skill/github-skill-push.ts` | ~247, 289 | 已有 User-Agent |
| `src/main/services/skill/skill-market-service.ts` | ~327, 424 | 已有 User-Agent |
| `src/main/services/gh-search/gh-api.ts` | 80-84 | **缺少 User-Agent（本次修复）** |
| `src/main/services/gh-search/index.ts` | 56-60 | **缺少 User-Agent（本次修复）** |

唯一遗漏的就是 `gh-search/gh-api.ts` 的 `ghApiDirect()` 和 `gh-search/index.ts` 的 `checkGhCliStatus()`。

## 修复方案

### 修改 1：ghApiDirect 添加 User-Agent 请求头

**文件**：`src/main/services/gh-search/gh-api.ts`（第 80-84 行）

在 `ghApiDirect()` 的 headers 对象中添加 `'User-Agent': 'AICO-Bot'`：

```typescript
const headers: Record<string, string> = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'AICO-Bot',  // 新增
};
```

### 修改 2：gh CLI 回退时传入 PAT 环境变量

**文件**：`src/main/services/gh-search/gh-api.ts`（第 44-50 行）

当 PAT 存在时，gh CLI 回退调用应通过环境变量传入 token，确保 CLI 也能认证成功：

```typescript
const ghBin = resolveGhBinary();
const token = getGitHubToken();  // 已在第 35 行获取，但需要在 CLI 调用处也使用
try {
  const result = await execAsync(`"${ghBin}" ${args}`, {
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    env: token ? { ...process.env, GH_TOKEN: token } : process.env,  // 新增
  });
  return result;
} catch (error: any) {
```

注意：`token` 在第 35 行的 `if (token)` 块外可能不可见（取决于作用域），需要确认是否需要在外层也获取 token 或将 token 提升到外层作用域。

### 修改 3：checkGhCliStatus 的 PAT 验证也添加 User-Agent

**文件**：`src/main/services/gh-search/index.ts`（第 56-60 行）

`checkGhCliStatus()` 中验证 PAT 的 `ghHeaders` 同样缺少 `User-Agent`，一并修复：

```typescript
const ghHeaders: Record<string, string> = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'AICO-Bot',  // 新增
};
```

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/gh-search/gh-api.ts` | 修改 | `ghApiDirect()` headers 添加 `User-Agent: AICO-Bot`；`execGh()` gh CLI 回退时传入 `GH_TOKEN` 环境变量 |
| `src/main/services/gh-search/index.ts` | 修改 | `checkGhCliStatus()` ghHeaders 添加 `User-Agent: AICO-Bot` |

## 验收标准

### 核心功能

- [x] 代理环境下，配置有效 PAT 后 gh-search MCP 工具能通过 REST API 正常完成搜索操作
- [x] `ghApiDirect()` 的请求头包含 `User-Agent: AICO-Bot`
- [x] `checkGhCliStatus()` 的 PAT 验证请求头包含 `User-Agent: AICO-Bot`
- [x] `execGh()` 回退到 gh CLI 时，PAT 通过 `GH_TOKEN` 环境变量传入 CLI

### 回归验证

- [ ] 外网直连环境下 gh-search 功能不受影响（需用户手动验证）
- [x] gh CLI 回退路径正常工作（PAT 不可用或 REST API 失败时）
- [ ] 认证状态检查（设置页 GitHub 区域）正常显示（需用户手动验证）

### 代码质量

- [x] TypeScript 类型检查通过（`npm run typecheck`）— 本次修改无新增错误
- [x] 构建通过（`npm run build`）

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 源码文件 | `src/main/services/gh-search/gh-api.ts` | 理解 `ghApiDirect()` headers 构建和 `execGh()` 执行流程（PAT 优先 -> gh CLI 回退 -> REST API 兜底） |
| 源码文件 | `src/main/services/gh-search/index.ts` | 理解 `checkGhCliStatus()` 的 PAT 验证逻辑和 headers 构建 |
| 源码文件 | `src/main/services/proxy/proxy-fetch.ts` | 理解 `proxyFetch()` 代理请求流程，确认为何 Node.js `https.request()` 不自动添加 User-Agent |
| 关联 PRD | `.project/prd/bugfix/github/github-auth-proxy-fix-v1.md` | 理解同类 User-Agent 问题的修复历史，确认修复模式一致（`User-Agent: AICO-Bot`） |
| 关联 PRD | `.project/prd/bugfix/github/gh-search-pat-auth-refactor-v1.md` | 理解 gh-search PAT REST API 重构的设计，确认本次修改不影响既有架构 |

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-08 | 初始 PRD：gh-search REST API 缺少 User-Agent 导致代理环境认证失败 | 用户 |
