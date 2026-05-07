# PRD [Bug 修复级] -- 内网代理环境下 GitHub PAT 认证失败

> 版本：github-auth-proxy-fix-v1
> 日期：2026-05-03
> 指令人：moonseeker
> 归属模块：modules/main/services (proxy + github-auth)
> 严重程度：High
> 状态：done
> 关联 PRD：`.project/prd/feature/network-proxy/network-proxy-v1.md`

## 问题描述

### 期望行为

在内网环境（使用本机代理如 Clash/V2Ray）下，AICO-Bot 设置页的 GitHub Connect 按钮输入 PAT token 后点击连接，应能正常验证 token 并完成登录。

### 实际行为

始终报 "Invalid token. Please check your Personal Access Token."，但该 token 在外网环境下可用。

### 复现步骤

1. 在内网环境下启动 AICO-Bot，确保系统配置了 HTTP 代理（Clash/V2Ray）
2. 打开设置页，进入 GitHub 配置
3. 输入有效的 GitHub PAT token
4. 点击 Connect
5. 观察：始终提示 "Invalid token"

### 影响范围

- **内网代理环境**：必现
- **外网直连环境**：不受影响
- **影响功能**：GitHub PAT 直接登录、git credentials 自动配置

## 根因分析

经过排查，确认以下四个问题：

### 根因 1：缺少 User-Agent 请求头（主因）

`validateGitHubToken()` 调用 `proxyFetch` 请求 `https://api.github.com/user` 时，headers 中没有 `User-Agent`。

- 外网直连走 `fetch()`（undici），自动附带 `User-Agent: undici/x.x.x`，所以不报错
- 内网走代理路径 `fetchViaProxy()`，底层用 `https.request()`，不会自动加 `User-Agent`
- 内网企业网关做 DPI 检查，缺 `User-Agent` 直接返回 403
- GitHub API 本身也要求必须带 `User-Agent`（RFC 要求）

### 根因 2：错误被静默吞掉

`validateGitHubToken()` 的 catch 块直接 `return null`，把网络错误、代理错误、TLS 错误全部当成 "token 无效" 处理，用户无法区分是网络问题还是 token 问题。

### 根因 3：proxyFetch 不读取环境变量代理

原 `proxyFetch` 使用 `getProxyConfig()` 只检查 `config.network.enabled && config.network.proxyUrl`，不读取环境变量 `HTTPS_PROXY`/`HTTP_PROXY`。当用户仅通过环境变量配置代理而未在 UI 中配置时，请求不走代理。

### 根因 4：curl fallback 缺少 --ssl-no-revoke

`fetchViaCurl()` 的 curl 参数没有 `--ssl-no-revoke`，Windows 环境下 SSL 证书吊销检查可能超时。

## 修复方案

### 修改 1：为 validateGitHubToken 添加 User-Agent 请求头

**文件**：`src/main/services/github-auth.service.ts`

在 `validateGitHubToken()` 的 `proxyFetch` 调用中添加 `'User-Agent': 'AICO-Bot'` 请求头：

```typescript
const resp = await proxyFetch(`${GITHUB_API_BASE}/user`, {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'AICO-Bot',  // 新增
  },
  signal: AbortSignal.timeout(15_000),
});
```

### 修改 2：删除旧的 undici ProxyAgent 方案，统一使用 proxyFetch

**文件**：`src/main/services/github-auth.service.ts`

- 删除基于 undici `ProxyAgent` 的本地 `proxyFetch` 实现和 `getGitHubProxyDispatcher()`
- 改为导入统一的 `proxyFetch`（来自 `./proxy`），该实现支持 TLS bypass 和代理隧道
- 删除未使用的 `undici` 相关导入

### 修改 3：proxyFetch 改用 getEffectiveProxyUrl

**文件**：`src/main/services/proxy/proxy-fetch.ts`

`proxyFetch()` 改用 `getEffectiveProxyUrl()` 替代 `getProxyConfig()`，支持配置 > 环境变量 > 直连的优先级：

```typescript
// 原
// const { enabled, proxyUrl } = getProxyConfig();
// if (enabled && proxyUrl) { ... }

// 改为
const effectiveProxyUrl = getEffectiveProxyUrl();
if (effectiveProxyUrl) {
  return fetchViaProxy(url, init, effectiveProxyUrl, timeout);
}
```

**文件**：`src/main/services/proxy/proxy-agent.ts`

- `getEffectiveProxyUrl()` 从内部 function 改为 export function

**文件**：`src/main/services/proxy/index.ts`

- 导出 `getEffectiveProxyUrl`

### 修改 4：curl fallback 添加 --ssl-no-revoke

**文件**：`src/main/services/proxy/proxy-fetch.ts`

在 `fetchViaCurl()` 的 curl 参数数组中添加 `--ssl-no-revoke`，避免 Windows SSL 证书吊销检查超时：

```typescript
const args: string[] = [
  '-s',
  '-i',
  '--connect-timeout',
  String(connectTimeout),
  '--max-time',
  String(connectTimeout),
  '-k',
  '--ssl-no-revoke',  // 新增
  '-x',
  proxyUrl,
];
```

### 修改 5：代码整理

**文件**：`src/main/services/github-auth.service.ts`

- `getGhBin()` 重命名为 `resolveGhBinary()` 并导出（供其他模块使用）
- `fs` 导入拆分：`existsSync` 使用同步导入，`readFile`/`writeFile` 使用 `fs/promises` 异步导入
- 新增 `getCombinedGitHubAuthStatus()` 和 `CombinedGitHubAuthStatus` 类型，同时返回 PAT 状态和 gh CLI 状态
- `loginWithDirectToken()` 成功后自动调用 `setupGitCredentialsWithToken()` 配置 git credentials（fire-and-forget）

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/github-auth.service.ts` | 修改 | 添加 `User-Agent` 请求头；删除 undici ProxyAgent 方案；改用统一 proxyFetch；`getGhBin` 重命名为 `resolveGhBinary` 并导出；fs 导入拆分；新增 `getCombinedGitHubAuthStatus`；`loginWithDirectToken` 自动配置 git credentials |
| `src/main/services/proxy/proxy-agent.ts` | 修改 | `getEffectiveProxyUrl()` 从内部 function 改为 export function |
| `src/main/services/proxy/proxy-fetch.ts` | 修改 | `proxyFetch()` 改用 `getEffectiveProxyUrl()` 替代 `getProxyConfig()`；`fetchViaCurl()` 添加 `--ssl-no-revoke` 参数 |
| `src/main/services/proxy/index.ts` | 修改 | 新增导出 `getEffectiveProxyUrl` |

## 验收标准

### 核心功能

- [x] 内网代理环境下输入有效 PAT token 能正常验证并完成登录（User-Agent 修复生效）
- [x] 外网直连环境下 PAT 登录功能不受影响（回归验证）
- [x] `validateGitHubToken()` 请求头包含 `User-Agent: AICO-Bot`
- [x] `proxyFetch()` 未配置 UI 代理时可通过环境变量（`HTTPS_PROXY`/`HTTP_PROXY`）走代理

### 代码质量

- [x] `github-auth.service.ts` 删除了旧的 undici ProxyAgent 方案，统一使用 `./proxy` 的 proxyFetch
- [x] `proxy-agent.ts` 导出 `getEffectiveProxyUrl()`
- [x] `proxy/index.ts` 导出 `getEffectiveProxyUrl`
- [x] `fetchViaCurl()` 包含 `--ssl-no-revoke` 参数
- [x] `getGhBin()` 已重命名为 `resolveGhBinary()` 并导出
- [x] fs 导入拆分为同步（`existsSync`）和异步（`readFile`/`writeFile` via `fs/promises`）
- [x] `loginWithDirectToken()` 成功后自动调用 `setupGitCredentialsWithToken()`
- [x] TypeScript 类型检查通过（`npm run typecheck`）
- [x] ESLint 检查通过（`npm run lint`）
- [x] 构建通过（`npm run build`）

## 遗留问题

### gh CLI 调用仍缺少代理和 SSL 处理

`gh-search` 模块和 `github-skill-source` 模块中的 `gh` CLI 调用（Go 二进制）在 MITM 代理下仍会因 TLS 证书校验失败而报错。Go 运行时无法通过环境变量跳过 TLS 验证。

已创建后续功能 PRD 处理此问题：`.project/prd/feature/network-proxy/gh-cli-tls-fallback-v1.md`，方案为在 gh CLI 失败时自动回退到通过 `proxyFetch` 调用 GitHub REST API。

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-03 | 初始 Bug 修复 PRD（补记：User-Agent、proxyFetch 统一、环境变量代理、curl SSL 修复） | moonseeker |
