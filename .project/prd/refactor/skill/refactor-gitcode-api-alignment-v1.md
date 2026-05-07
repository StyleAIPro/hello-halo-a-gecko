# PRD [重构级] — GitCode API 对齐全面优化

> 版本：refactor-gitcode-api-alignment-v1
> 日期：2026-04-26
> 状态：done
> 指令人：@MoonSeeker
> 归属模块：modules/skill
> 优先级：P1

## 背景

参照 GitCode 官方 API 文档（`散乱文档/GitCode-API-Summary.md`，2026-04-25 统计，250 个端点），对现有 GitCode 技能集成进行全面审查后发现 17 个问题，涵盖安全、性能、正确性和代码质量四个层面。

当前代码基于早期对 GitCode API 的理解（50 req/min 限制、`gitcode.com/api/v5` 域名）编写，与官方文档存在多处偏差。同时用户反馈 getSkillDetail 获取 GitCode 技能详情时会卡死 60-120 秒。

## 问题清单

### 安全问题

| # | 严重度 | 问题 | 位置 |
|---|--------|------|------|
| 1 | Critical | `pushSkillAsMR` 中 token 暴露在 URL query parameter（`?access_token=xxx`），可见于日志 | `gitcode-skill-source.service.ts` L949,981,1003,1067 |
| 2 | Critical | 文件上传时 token 同时在 URL 和 request body 中发送 | `gitcode-skill-source.service.ts` L1019-1024 |

### 正确性问题

| # | 严重度 | 问题 | 位置 |
|---|--------|------|------|
| 3 | High | `pushSkillAsMR` 所有写操作绕过 rate limiter 和 429 重试 | `gitcode-skill-source.service.ts` L898-1119 |
| 4 | High | Rate limiter 参数过严（1s 间隔 + 50/min），实际限制为 400/min | `gitcode-skill-source.service.ts` L57-62 |
| 5 | High | `getMarketSkillDetail` 无整体超时，最坏情况阻塞 60-120s | `skill.controller.ts` L944-957 |
| 6 | High | 请求计数器 `_requestCount` 在 `withConcurrency` 和 `gitcodeApiFetch` 中各 +1，重复计数 | `gitcode-skill-source.service.ts` L119,149 |
| 7 | Low | 死代码 ternary `path.includes('?') ? X : X`，两个分支完全相同 | `gitcode-skill-source.service.ts` L159 |
| 8 | Low | auth service 中 `data.avatar_url \|\| data.avatar_url \|\| null` 冗余访问 | `gitcode-auth.service.ts` L51 |

### 性能问题

| # | 严重度 | 问题 | 位置 |
|---|--------|------|------|
| 9 | Medium | `fetchSkillFileContent` 使用 `/contents/{path}` 返回 base64 编码，可用 `/raw/{path}` 直接获取文本 | `gitcode-skill-source.service.ts` L369-384 |
| 10 | Medium | `getSkillDetailFromRepo` 串行尝试 SKILL.md → SKILL.yaml，应并行 | `gitcode-skill-source.service.ts` L776-809 |
| 11 | Medium | `GITCODE_API_BASE` 在两个文件中各自定义，且值为 `gitcode.com/api/v5` 而非文档标准 `api.gitcode.com/api/v5` | `gitcode-skill-source.service.ts` L21, `gitcode-auth.service.ts` L12 |
| 12 | Medium | `listSkillsFromRepo` 和 `listSkillsFromRepoStreaming` ~90% 代码重复 | `gitcode-skill-source.service.ts` L567-761 |

### 代码质量问题

| # | 严重度 | 问题 | 位置 |
|---|--------|------|------|
| 13 | Low | 8+ 处 `catch {}` 静默吞掉错误，无任何日志 | `gitcode-skill-source.service.ts` 多处 |
| 14 | Low | `findSkillDirs` 递归扫描无整体超时 | `gitcode-skill-source.service.ts` L280-362 |
| 15 | Low | `pushSkillAsMR` 失败后不清理已创建的分支 | `gitcode-skill-source.service.ts` L898-1119 |
| 16 | Low | `findSkillDirs` 内 `Promise.all` 对所有子目录并发递归，无并发控制 | `gitcode-skill-source.service.ts` L325 |
| 17 | Low | `resetProxyDispatcher` re-export 实际为 no-op 函数 | `gitcode-skill-source.service.ts` L133 |

## 技术方案

### Phase 0: 清理 + 常量统一（Issue #7, #11, #17）

**目标**：消除死代码、统一常量定义、修正 Base URL

#### 0.1 导出并修正 `GITCODE_API_BASE`

**文件**：`gitcode-skill-source.service.ts` L21

```typescript
// Before
const GITCODE_API_BASE = 'https://gitcode.com/api/v5';

// After
export const GITCODE_API_BASE = 'https://api.gitcode.com/api/v5';
```

#### 0.2 Auth service 导入统一常量

**文件**：`gitcode-auth.service.ts`

```typescript
// Before
import { gitcodeFetch } from './skill/gitcode-skill-source.service';
const GITCODE_API_BASE = 'https://gitcode.com/api/v5';

// After
import { gitcodeFetch, GITCODE_API_BASE } from './skill/gitcode-skill-source.service';
```

同时修复 L51 冗余字段访问：`data.avatar_url || data.avatar_url || null` → `data.avatar_url || null`

#### 0.3 删除无效 re-export

**文件**：`gitcode-skill-source.service.ts` L133

删除 `export { invalidateProxyCache as resetProxyDispatcher };`

**文件**：`skill-market-service.ts` L815

```typescript
// Before
import * as gitcodeSkillSource from './gitcode-skill-source.service';
// ...
gitcodeSkillSource.resetProxyDispatcher();

// After
import { invalidateProxyCache } from '../proxy';
// ...
invalidateProxyCache();
```

注意：需确认 `skill-market-service.ts` 中的其他 `gitcodeSkillSource` 导入（如 `listSkillsFromRepo`、`getSkillDetailFromRepo`、`getGitCodeToken`、`listSkillsFromRepoStreaming`）仍然从 `./gitcode-skill-source.service` 导入。

#### 0.4 删除死代码 ternary

**文件**：`gitcode-skill-source.service.ts` L159

```typescript
// Before
const url = path.includes('?') ? `${GITCODE_API_BASE}${path}` : `${GITCODE_API_BASE}${path}`;

// After
const url = `${GITCODE_API_BASE}${path}`;
```

### Phase 1: 安全修复 — Token 处理（Issue #1, #2）

**目标**：所有 GitCode API 请求统一通过 header 发送 token，杜绝 token 暴露在 URL 中

#### 1.1 新增 `gitcodeAuthFetch` 辅助函数

**文件**：`gitcode-skill-source.service.ts`，在 `gitcodeFetch` 导出之后（~L143）

```typescript
/**
 * Authenticated fetch for GitCode write operations.
 * Sends token via private-token header (not URL) for security.
 * Includes rate limiting to stay within API quota.
 */
async function gitcodeAuthFetch(
  url: string,
  init: RequestInit,
  token: string,
): Promise<Response> {
  await _rateLimiter.acquire();
  _requestCount++;
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> || {}),
    'private-token': token,
  };
  return gitcodeFetch(url, { ...init, headers });
}
```

#### 1.2 重构 `pushSkillAsMR` 中的 4 处写操作

**文件**：`gitcode-skill-source.service.ts` `pushSkillAsMR` 函数

| 操作 | 原代码 | 修改后 |
|------|--------|--------|
| Fork（~L949） | `gitcodeFetch(\`...\?access_token=\${token}\`)` | `gitcodeAuthFetch(\`...\repos/${repo}/forks\`, {method:'POST',...}, token)` |
| 分支创建（~L981） | URL query params 传 ref + branch_name | POST body: `{ref: baseBranch, branch_name: branchName}` |
| 文件上传（~L1003,1031） | URL 含 `?access_token=`, body 含 `access_token` | URL 不含 token，body 删除 `access_token` 字段，用 `gitcodeAuthFetch` |
| MR 创建（~L1066） | `gitcodeFetch(\`...\?access_token=\${token}\`)` | `gitcodeAuthFetch(\`.../pulls\`, {method:'POST',...}, token)` |

### Phase 2: 速率限制 + 请求计数（Issue #3, #4, #6）

**目标**：放宽速率限制至合理水平，统一写操作限流，修复计数器

#### 2.1 更新 Rate Limiter 配置

**文件**：`gitcode-skill-source.service.ts` L57-62

| 参数 | 修改前 | 修改后 | 说明 |
|------|--------|--------|------|
| `RATE_LIMIT_MAX_TOKENS` | 50 | 60 | 突发预算（远低于 400/min 上限） |
| `RATE_LIMIT_MIN_INTERVAL_MS` | 1000 | 200 | ~5 req/s（远低于 400/min） |
| `RATE_LIMIT_REFILL_INTERVAL_MS` | 1200 | 1000 | 每秒补充 1 token |

更新注释：
```typescript
// GitCode limit: 400 requests/min, 4000 requests/hour per user.
// Strategy: 200ms minimum gap + 60-token/minute burst budget (conservative).
```

#### 2.2 修复请求计数器

**文件**：`gitcode-skill-source.service.ts`

- `withConcurrency`：删除 `_requestCount++` 和 telemetry 日志，仅保留信号量功能
- `gitcodeApiFetch`：保留 `_requestCount++`，新增 telemetry 日志（每 10 次输出一次）
- `gitcodeAuthFetch`：保留 `_requestCount++`（Phase 1.1 已包含）

### Phase 3: 性能优化（Issue #9, #10, #12）

**目标**：用 raw 端点加速文件读取、并行获取技能详情、消除代码重复

#### 3.1 `fetchSkillFileContent` 改用 raw 端点

**文件**：`gitcode-skill-source.service.ts` L369-384

```typescript
export async function fetchSkillFileContent(
  repo: string,
  filePath: string,
  token?: string,
): Promise<string | null> {
  try {
    await _rateLimiter.acquire();
    _requestCount++;
    const encodedPath = encodeURIComponent(filePath).replace(/%2F/g, '/');
    const headers: Record<string, string> = {};
    if (token) headers['private-token'] = token;

    const response = await gitcodeFetch(
      `${GITCODE_API_BASE}/repos/${repo}/raw/${encodedPath}`,
      { headers },
    );
    if (response.status === 404) return null;
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}
```

#### 3.2 `getSkillDetailFromRepo` 并行获取

**文件**：`gitcode-skill-source.service.ts` L776-809

```typescript
const contentPaths = [`${skillPath}/SKILL.md`, `${skillPath}/SKILL.yaml`];
const results = await Promise.allSettled(
  contentPaths.map((p) => fetchSkillFileContent(repo, p, token))
);

// Prefer SKILL.md over SKILL.yaml
for (let i = 0; i < results.length; i++) {
  const result = results[i];
  if (result.status === 'fulfilled' && result.value) {
    const contentPath = contentPaths[i];
    const content = result.value;
    const isYaml = contentPath.endsWith('.yaml');
    // ... 现有解析逻辑不变
  }
}
```

#### 3.3 消除 `listSkillsFromRepo` / `listSkillsFromRepoStreaming` 重复

**文件**：`gitcode-skill-source.service.ts` L567-761

提取共享实现为 `listSkillsFromRepoImpl(repo, token, onProgress?, onSkillFound?)`，原两个函数变为薄 wrapper：

```typescript
async function listSkillsFromRepoImpl(
  repo: string,
  token: string | undefined,
  onProgress?: SkillFetchProgressCallback,
  onSkillFound?: SkillFoundCallback,
): Promise<RemoteSkillItem[]> {
  // 原 listSkillsFromRepo 的全部逻辑，onSkillFound 为可选回调
}

export async function listSkillsFromRepo(
  repo: string,
  token?: string,
  onProgress?: SkillFetchProgressCallback,
): Promise<RemoteSkillItem[]> {
  return listSkillsFromRepoImpl(repo, token, onProgress, undefined);
}

export async function listSkillsFromRepoStreaming(
  repo: string,
  token?: string,
  onProgress?: SkillFetchProgressCallback,
  onSkillFound?: SkillFoundCallback,
): Promise<RemoteSkillItem[]> {
  return listSkillsFromRepoImpl(repo, token, onProgress, onSkillFound);
}
```

### Phase 4: 超时 + 错误处理（Issue #5, #13, #14, #15, #16）

**目标**：加超时保护、增加日志可观测性、修复边界情况

#### 4.1 `getMarketSkillDetail` 加 30s 超时

**文件**：`skill.controller.ts` L944-957

```typescript
export async function getMarketSkillDetail(skillId: string) {
  const DETAIL_TIMEOUT_MS = 30_000;
  try {
    const skill = await Promise.race([
      skillMarket.getSkillDetail(skillId),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('Skill detail fetch timed out (30s)')), DETAIL_TIMEOUT_MS),
      ),
    ]);
    if (!skill) return { success: false, error: 'Skill not found' };
    return { success: true, data: skill };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get skill detail',
    };
  }
}
```

#### 4.2 `findSkillDirs` 加 deadline 参数

**文件**：`gitcode-skill-source.service.ts` `findSkillDirs` 函数

- 新增可选参数 `deadline?: number`（`Date.now() + timeout`）
- 函数入口和递归入口检查 `deadline`，超时提前返回空数组
- 递归调用包裹 `withConcurrency` 控制并发
- 在 `listSkillsFromRepoImpl` 中传入 `deadline = Date.now() + 20_000`

#### 4.3 `pushSkillAsMR` 失败时清理分支

**文件**：`gitcode-skill-source.service.ts` `pushSkillAsMR`

当 `commitSuccess === 0` 时，DELETE 已创建的分支：

```typescript
if (commitSuccess === 0) {
  try {
    await gitcodeAuthFetch(
      `${GITCODE_API_BASE}/repos/${targetRepo}/branches/${encodeURIComponent(branchName)}`,
      { method: 'DELETE' },
      token,
    );
    console.warn('[GitCodeSkillSource] Cleaned up orphan branch:', branchName);
  } catch (e: any) {
    console.warn('[GitCodeSkillSource] Branch cleanup failed:', e.message);
  }
  return { success: false, error: `All files failed. First: ${commitErrors[0]}` };
}
```

#### 4.4 关键 catch 块加日志

**原则**：不改变返回逻辑（仍返回空/null/error），只增加 `console.debug` 或 `console.warn`

| 位置 | 原代码 | 修改 |
|------|--------|------|
| `fetchSkillFileContent` catch | `catch {}` | `catch (e: any) { console.debug('[GitCode] fetch failed:', e.message); }` |
| `findSkillDirectoryPath` L485 catch | `catch {}` | `catch (e: any) { console.debug('[GitCode] path check failed:', dir, e.message); }` |
| `listRepoDirectories` catch | `catch {}` | `catch (e: any) { console.debug('[GitCode] list dirs failed:', e.message); }` |

## 涉及文件

| 文件 | 预估改动 | Phase |
|------|---------|-------|
| `src/main/services/skill/gitcode-skill-source.service.ts` | 大 | 0-4 |
| `src/main/services/gitcode-auth.service.ts` | 小 | 0 |
| `src/main/controllers/skill.controller.ts` | 小 | 4 |
| `src/main/services/skill/skill-market-service.ts` | 小 | 0 |

## 开发前必读

| 分类 | 文档/文件 | 阅读目的 |
|------|----------|---------|
| 外部参考 | `散乱文档/GitCode-API-Summary.md` | GitCode 官方 API 250 端点、认证方式、速率限制（400/min） |
| 模块设计文档 | `.project/modules/skill/features/skill-market/design.md` | 技能市场完整架构、数据模型、IPC 通道、已知问题 |
| 模块设计文档 | `.project/modules/skill/features/skill-source/design.md` | GitCode/GitHub 源服务职责、认证依赖 |
| 功能变更记录 | `.project/modules/skill/features/skill-market/changelog.md` | 17 条历史变更，理解当前代码状态 |
| 功能变更记录 | `.project/modules/skill/features/skill-source/changelog.md` | 7 条历史变更，理解 findSkillDirs 优化历程 |
| Bug 记录 | `.project/modules/skill/features/skill-market/bugfix.md` | 7 个已知 bug，避免回归 |
| 源码文件 | `src/main/services/skill/gitcode-skill-source.service.ts` | 主要修改目标，理解 RateLimiter/Semaphore/API 调用模式 |
| 源码文件 | `src/main/services/gitcode-auth.service.ts` | Auth service，需统一常量导入 |
| 源码文件 | `src/main/controllers/skill.controller.ts` | Controller，需加超时 |
| 源码文件 | `src/main/services/skill/skill-market-service.ts` | Market service，需修正 import |
| 历史 PRD | `.project/prd/bugfix/skill/bugfix-gitcode-rate-limiter-v1.md` | 当前限流参数基线（将被此 PRD 更新） |
| 历史 PRD | `.project/prd/bugfix/skill/bugfix-gitcode-skill-fetch-v2.md` | 限流器 + 进度机制的实现细节 |
| API 文档 | `.project/api/skill.md` | IPC 通道定义，确认无接口签名变更 |

## 验收标准

- [ ] Phase 0：`GITCODE_API_BASE` 仅定义一次且值为 `api.gitcode.com/api/v5`，无死代码，无无效 re-export
- [ ] Phase 1：`pushSkillAsMR` 中零处 `access_token` 出现在 URL 中，body 中不含 `access_token` 字段
- [ ] Phase 2：连续 GitCode API 请求间隔 ~200ms（不再 1s），一分钟内不超过 60 次，请求计数器每次 +1
- [ ] Phase 3：`fetchSkillFileContent` 使用 `/raw/` 端点，SKILL.md/yaml 并行获取，`listSkillsFromRepo`/`listSkillsFromRepoStreaming` 共享实现
- [ ] Phase 4：`getMarketSkillDetail` 30s 超时，`findSkillDirs` 有 20s 整体 deadline，`pushSkillAsMR` 失败时清理分支
- [ ] 全部通过：`npm run typecheck && npm run lint && npm run build`
- [ ] 回归：GitHub 技能源功能不受影响

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-26 | 初始版本：17 个问题全面优化方案 | @MoonSeeker |
