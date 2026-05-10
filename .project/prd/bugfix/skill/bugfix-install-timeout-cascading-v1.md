# PRD [Bug 修复级] — 技能安装超时后级联失败，后续安装全部超时

> 版本：bugfix-install-timeout-cascading-v1
> 日期：2026-04-24
> 指令人：用户
> 归属模块：modules/skill
> 严重程度：Major（首个 skill 安装超时后，后续所有安装均失败，必须重启应用才能恢复）
> 所属功能：features/skill-market + features/skill-source
> 状态：in-progress

## 问题描述

- **期望行为**：第一个 skill 安装超时后，后续安装的 skill 应该正常完成，不受之前超时影响
- **实际行为**：第一个 skill 安装超时（60s）后，后续安装的所有 skill 全部显示超时，无法成功安装。必须重启应用才能恢复正常
- **复现步骤**：
  1. 配置 GitCode PAT Token
  2. 在技能市场选择一个较大的 skill 或在网络较差时安装（确保安装超过 60s 触发超时）
  3. 等待安装超时完成
  4. 立即安装另一个 skill
  5. 观察第二个 skill 也显示超时（实际上 API 请求被 rate limiter 阻塞，60s 内无法完成）

## 根因分析

### 根因 1：安装超时后 pending 的 GitCode API 请求不被取消

**文件**：`src/main/controllers/skill.controller.ts`，`installSkillFromMarket`（L378-390）

当前 60s 超时通过 `setTimeout` + `clearTimeout` 实现。当超时触发时，`doInstall()` 的 Promise 已 resolve（返回超时错误），但 `doInstall` 内部正在执行的 `gitcodeApiFetch` 调用**不会被取消** -- 它们继续运行直到各自的 30s fetch 超时自然到期。

```typescript
// L378-390 — 超时触发时 doInstall 内部的 API 请求仍在运行
return new Promise<{ success: boolean; error?: string }>((resolve) => {
  const timeoutId = setTimeout(() => {
    // 此时 doInstall 内部可能还有多个 gitcodeApiFetch 在排队或执行
    // 这些请求不会被取消，继续消耗 rate limiter 资源
    const msg = 'Installation timed out (60s). Please check your network and try again.';
    onOutput?.({ type: 'error', content: msg });
    resolve({ success: false, error: msg });
  }, INSTALL_TIMEOUT);

  doInstall().then((result) => {
    clearTimeout(timeoutId);
    resolve(result);
  });
});
```

这些"僵尸"请求会持续影响全局共享的 rate limiter（`src/main/services/skill/gitcode-skill-source.service.ts` 的 `RateLimiter` 实例）：

1. **消耗 rate limiter token**：`gitcodeApiFetch` 在 `acquire()` 时消耗了 token（L94 `this._tokens--`），abort 后不归还。僵尸请求的 `acquire()` 已执行，token 已扣减
2. **占用 1s 间隔**：每次 `acquire()` 都更新 `_lastAcquire`（L94），后续请求需等待 1s 间隔才能通过。多个僵尸请求排队意味着累积等待时间
3. **占用 TCP 连接**：pending 的 fetch 占用连接池，影响后续请求的网络性能

**级联效应**：当第一个安装超时时有多个 API 请求在排队（`findSkillDirectoryPath` 最多尝试 3 个路径变体 + fallback 递归扫描 + `fetchSkillDirectoryContents` 递归下载文件），超时后这些请求继续执行，将 rate limiter 的 token 配额和间隔时间推到很晚。第二次安装发起的所有 API 请求都被 rate limiter 阻塞，在 60s 超时内无法完成 -- 再次超时 -- 形成恶性循环。

### 根因 2：`installSkillMultiTarget` 中 `downloadSkill` 被重复调用

**文件**：`src/main/controllers/skill.controller.ts`

`installSkillMultiTarget`（L439）先调用 `skillMarket.downloadSkill(skillId)` 获取 skill 信息用于远程安装：

```typescript
// L439
const downloadResult = await skillMarket.downloadSkill(skillId);
```

然后调用 `installSkillFromMarket`（L460）进行本地安装，而 `installSkillFromMarket` 内部（L257）又调用了一次 `downloadSkill(skillId)`：

```typescript
// L257 — 内部再次调用 downloadSkill
const downloadResult = await skillMarket.downloadSkill(skillId, (data) => {
  onOutput?.(data);
});
```

每个安装会发**两倍** API 请求（一次用于获取 remoteRepo/skillName，一次用于实际安装），加速 rate limiter token 耗尽。在网络较慢或请求较多时，这进一步增加了超时风险。

## 技术方案

### 修复 1：安装超时时通过 AbortSignal 取消所有 pending 的 GitCode API 请求

在 `installSkillFromMarket` 中创建一个 `AbortController`，将 `signal` 逐层透传：

```
installSkillFromMarket (创建 AbortController)
  → installSkillFromSource (接收 signal)
    → adapter.findSkillDirectoryPath (透传 signal)
    → adapter.fetchSkillDirectoryContents (透传 signal)
      → gitcodeApiFetch / gitcodeFetch (消费 signal)
```

超时触发时调用 `abortController.abort()`，所有 pending 的 fetch 请求立即取消，rate limiter 资源被释放。

**`skill.controller.ts` 改动**：

```typescript
// installSkillFromMarket
export async function installSkillFromMarket(
  skillId: string,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
): Promise<{ success: boolean; error?: string }> {
  const INSTALL_TIMEOUT = 60_000;
  const abortController = new AbortController();

  return new Promise<{ success: boolean; error?: string }>((resolve) => {
    const timeoutId = setTimeout(() => {
      abortController.abort();
      const msg = 'Installation timed out (60s). Please check your network and try again.';
      console.warn('[SkillController]', msg);
      onOutput?.({ type: 'error', content: msg });
      resolve({ success: false, error: msg });
    }, INSTALL_TIMEOUT);

    doInstall(abortController.signal).then((result) => {
      clearTimeout(timeoutId);
      resolve(result);
    });
  });
}
```

```typescript
// installSkillFromSource 增加 signal 参数
async function installSkillFromSource(
  repo: string,
  skillName: string,
  adapter: SkillSourceAdapter,
  onOutput?: ...,
  signal?: AbortSignal,
): Promise<{ success: boolean; error?: string }> {
  // ...
  const dirPath = await adapter.findSkillDirectoryPath(repo, skillName, token, signal);
  // ...
  const files = await adapter.fetchSkillDirectoryContents(repo, dirPath, token, signal);
}
```

```typescript
// SkillSourceAdapter 类型更新
type SkillSourceAdapter = {
  findSkillDirectoryPath: (repo: string, skillName: string, token?: string, signal?: AbortSignal) => Promise<string | null>;
  fetchSkillDirectoryContents: (repo: string, dirPath: string, token?: string, signal?: AbortSignal) => Promise<Array<{ path: string; content: string }>>;
  getToken: () => string | undefined | Promise<string | undefined>;
  sourceLabel: string;
};
```

**`gitcode-skill-source.service.ts` 改动**：

`gitcodeFetch` 和 `gitcodeApiFetch` 支持接收外部 `AbortSignal`，与内部超时 signal 合并（外部 signal 优先）：

```typescript
// gitcodeFetch — 合并外部 signal
export async function gitcodeFetch(url: string, init?: RequestInit): Promise<Response> {
  const dispatcher = await getProxyDispatcher();
  const internalController = new AbortController();
  const timeout = setTimeout(() => internalController.abort(), GITCODE_FETCH_TIMEOUT_MS);

  // 合并外部 signal 和内部超时 signal
  const externalSignal = init?.signal;
  let mergedSignal: AbortSignal;

  if (externalSignal) {
    // 外部 signal abort 时，同时取消内部超时
    if (externalSignal.aborted) {
      clearTimeout(timeout);
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    mergedSignal = externalSignal; // 外部优先
    externalSignal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
  } else {
    mergedSignal = internalController.signal;
  }

  try {
    const response = await fetch(url, {
      ...init,
      signal: mergedSignal,
      ...(dispatcher ? ({ dispatcher } as any) : {}),
    });
    return response;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `GitCode API request aborted: ${url}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
```

```typescript
// gitcodeApiFetch — 增加 signal 参数
async function gitcodeApiFetch(path: string, options?: GitCodeApiOptions & { signal?: AbortSignal }): Promise<any> {
  await _rateLimiter.acquire();

  // 检查外部 signal 是否已 abort
  if (options?.signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options?.token) {
    headers['private-token'] = options.token;
  }

  const url = path.includes('?') ? `${GITCODE_API_BASE}${path}` : `${GITCODE_API_BASE}${path}`;
  const response = await gitcodeFetch(url, { headers, signal: options?.signal });
  // ... 后续逻辑不变
}
```

```typescript
// findSkillDirectoryPath — 透传 signal
export async function findSkillDirectoryPath(
  repo: string,
  skillName: string,
  token?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  // ...
  const data = await gitcodeApiFetch(apiPath, { token, signal });
  // ...
}

// fetchSkillDirectoryContents — 透传 signal
export async function fetchSkillDirectoryContents(
  repo: string,
  dirPath: string,
  token?: string,
  signal?: AbortSignal,
): Promise<Array<{ path: string; content: string }>> {
  // ...
  const data = await gitcodeApiFetch(apiPath, { token, signal });
  // ...递归调用也透传 signal
}
```

**`github-skill-source.service.ts` 改动**：

同样为 `findSkillDirectoryPath` 和 `fetchSkillDirectoryContents` 增加 `signal` 参数，透传到 `githubApiFetch` → `fetch`。保持与 GitCode 端接口一致：

```typescript
export async function findSkillDirectoryPath(
  repo: string,
  skillName: string,
  token?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  // ...
  const data = await githubApiFetch(apiPath, { token, signal });
  // ...
}

export async function fetchSkillDirectoryContents(
  repo: string,
  dirPath: string,
  token?: string,
  signal?: AbortSignal,
): Promise<Array<{ path: string; content: string }>> {
  // ...
  const data = await githubApiFetch(apiPath, { token, signal });
  // ...
}

async function githubApiFetch(path: string, options?: GitHubApiOptions & { signal?: AbortSignal }): Promise<any> {
  // ...
  const response = await fetch(`https://api.github.com${path}`, { headers, signal: options?.signal });
  // ...
}
```

### 修复 2：`installSkillMultiTarget` 传递 `downloadSkill` 结果，避免重复调用

新增内部函数 `installSkillFromMarketWithInfo`，接受预获取的 `downloadResult`，跳过内部的 `downloadSkill` 调用。`installSkillMultiTarget` 调用此方法而非 `installSkillFromMarket`。

```typescript
// 内部方法：接受预获取的 downloadResult
async function installSkillFromMarketWithInfo(
  downloadResult: { success: boolean; remoteRepo?: string; skillName?: string; sourceType?: string; error?: string },
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
  signal?: AbortSignal,
): Promise<{ success: boolean; error?: string }> {
  const INSTALL_TIMEOUT = 60_000;
  const abortController = new AbortController();

  return new Promise<{ success: boolean; error?: string }>((resolve) => {
    const timeoutId = setTimeout(() => {
      abortController.abort();
      const msg = 'Installation timed out (60s). Please check your network and try again.';
      resolve({ success: false, error: msg });
    }, INSTALL_TIMEOUT);

    doInstallWithInfo(downloadResult, onOutput, abortController.signal).then((result) => {
      clearTimeout(timeoutId);
      resolve(result);
    });
  });
}
```

`installSkillMultiTarget` 修改为：

```typescript
// 本地安装时传递已获取的 downloadResult
const result = await installSkillFromMarketWithInfo(downloadResult, localOnOutput);
```

> 注意：`installSkillFromMarket` 对外接口保持不变（仍内部调用 `downloadSkill`），保证单 skill 安装路径的兼容性。仅 `installSkillMultiTarget` 内部使用 `installSkillFromMarketWithInfo`。

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/controllers/skill.controller.ts` | 修改 | AbortSignal 透传 + `installSkillFromMarketWithInfo` 新增 + `installSkillMultiTarget` 去重 |
| `src/main/services/skill/gitcode-skill-source.service.ts` | 修改 | `gitcodeFetch`/`gitcodeApiFetch` 支持外部 AbortSignal + 合并 signal + `findSkillDirectoryPath`/`fetchSkillDirectoryContents` 透传 signal |
| `src/main/services/skill/github-skill-source.service.ts` | 修改 | `githubApiFetch`/`findSkillDirectoryPath`/`fetchSkillDirectoryContents` 增加 signal 参数 |
| `src/main/services/skill/skill-market-service.ts` | 修改 | `downloadSkill` 方法签名不变（无需修改） |
| `.project/modules/skill/features/skill-market/changelog.md` | 更新 | 追加变更记录 |
| `.project/modules/skill/features/skill-market/bugfix.md` | 更新 | 追加 bug 记录 |
| `.project/modules/skill/features/skill-source/changelog.md` | 更新 | 追加变更记录 |

## 开发前必读

| 分类 | 文档/文件 | 阅读目的 |
|------|----------|---------|
| 模块文档 | `.project/modules/skill/features/skill-source/changelog.md` | 了解 GitCode skill source 最近变更（rate limiter 参数、并发控制） |
| 模块文档 | `.project/modules/skill/features/skill-source/bugfix.md` | 了解 GitCode skill source 已知问题 |
| 模块文档 | `.project/modules/skill/features/skill-market/changelog.md` | 了解 skill market 最近变更 |
| 模块文档 | `.project/modules/skill/features/skill-market/bugfix.md` | 了解 skill market 已知问题 |
| 源码文件 | `src/main/controllers/skill.controller.ts` | 理解 `installSkillFromMarket`（L244-390）超时逻辑、`installSkillFromSource`（L75-213）安装流程、`installSkillMultiTarget`（L423-508）多目标安装流程 |
| 源码文件 | `src/main/services/skill/gitcode-skill-source.service.ts` | 理解 `gitcodeFetch`（L153-176）超时实现、`gitcodeApiFetch`（L178-247）rate limiter 集成、`RateLimiter` 类（L62-103）token/间隔机制 |
| 源码文件 | `src/main/services/skill/github-skill-source.service.ts` | 理解 `githubApiFetch`（L62-96）接口签名、`findSkillDirectoryPath`（L231-262）和 `fetchSkillDirectoryContents`（L173-225）的调用链 |
| 历史PRD | `.project/prd/bugfix/skill/bugfix-skill-install-hang-v1.md` | 了解 60s 整体超时的引入背景和 `clearTimeout` 修复 |
| 历史PRD | `.project/prd/bugfix/skill/bugfix-install-timeout-always-fires-v1.md` | 了解 `Promise.race` → `clearTimeout` 修复的上下文 |
| 历史PRD | `.project/prd/bugfix/skill/bugfix-gitcode-rate-limiter-v1.md` | 了解 rate limiter 参数（1s 间隔、50 token 上限） |

## 验收标准

- [ ] 第一个 skill 安装超时后，后续 skill 安装正常完成（不级联超时）
- [ ] 安装超时时，控制台日志显示 pending 请求被取消（abort）
- [ ] `installSkillMultiTarget` 中本地安装不再重复调用 `downloadSkill`
- [ ] AbortSignal 从 `installSkillFromMarket` 逐层透传到 `gitcodeFetch` / `githubApiFetch`
- [ ] 正常安装流程不受影响（安装成功，技能可正常加载和使用）
- [ ] GitHub skill 安装同样支持 AbortSignal 取消
- [ ] `npm run typecheck && npm run lint && npm run build` 通过
- [ ] 新增/修改的用户可见文本已执行 `npm run i18n`（如无新增文本则跳过）

## 变更记录

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-24 | 初始 Bug 修复 PRD | 用户 |
