# PRD [Bug 修复级] — GitCode 技能获取体验优化：限速 + 加载进度

> 版本：bugfix-gitcode-skill-fetch-v2
> 日期：2026-04-18
> 指令人：@MoonSeeker
> 反馈人：@MoonSeeker
> 归属模块：modules/skill
> 严重程度：Major

## 背景

v1 PRD (`bugfix-gitcode-skill-fetch-v1.md`) 修复了 GitCode 技能获取的致命问题（速率限制器失效、无超时、错误被吞掉、并发打爆 API），当前 v1 修复已落地。在此基础上，GitCode 技能获取仍存在两个体验层面的问题：

1. **无分钟级限速**：当前仅有全局并发信号量（max 3），但没有每分钟请求总量限制。递归目录扫描 + 批量元数据获取可能在一分钟内发出远超 GitCode API 允许的请求数，导致 429 降级和指数退避等待，拖慢整体加载。
2. **无加载进度反馈**：前端在 `listSkillsFromRepo()` 执行期间只显示一个通用的 `Loader2` 旋转图标和 "Loading..." 文本。用户无法知道当前处于"扫描目录"还是"获取元数据"阶段，也无法预估剩余时间。对于目录层级深、技能数量多的仓库，等待时间可能长达数十秒，用户体验差。

## 问题分析

### ISSUE-001：无分钟级速率限制

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`

当前流量控制机制：
- `Semaphore` 类：全局并发信号量，max 3 个并发请求
- `withConcurrency(fn)`：所有 API 调用通过此函数获取信号量
- `gitcodeApiFetch()`：收到 429 后指数退避重试（2s -> 4s -> 8s，最多 3 次）

问题：
- 并发限制 != 速率限制。假设每次请求耗时 500ms，max 3 并发 = 每分钟约 360 次请求，远超 GitCode API 限制
- 429 退避是被动响应式，而非主动预防。触发 429 后的等待时间会累加到总加载时间
- 没有遥测数据来观察实际请求频率

### ISSUE-002：前端无加载进度

**文件**：`src/renderer/components/skill/SkillMarket.tsx`

当前加载流程：
1. 用户切换到 GitCode 源或点击刷新
2. `loadSkills()` 设置 `loading = true`，显示通用旋转图标
3. `api.skillMarketList(page, pageSize)` 调用 IPC -> controller -> `SkillMarketService.getSkills()` -> `fetchFromGitCodeRepo()`
4. `fetchFromGitCodeRepo()` 调用 `gitcodeSkillSource.listSkillsFromRepo()`，此过程包含：
   - `findSkillDirs()`：递归扫描目录（max depth 5），每次扫描一个目录就是一次 API 调用
   - 对每个发现的 skill dir 调用 `fetchSkillFileContent()` 获取 SKILL.md
5. 所有技能加载完毕后，前端一次性收到完整列表

问题：
- 步骤 4 可能产生数十次 API 调用，用户在此期间只看到 "Loading..." 无任何细节
- 无法区分"正在扫描目录"和"正在获取技能详情"两个阶段
- 如果某个阶段卡住（如网络慢），用户无法判断是正常等待还是挂起

### ISSUE-003：后端无进度上报机制

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`、`src/main/services/skill/skill-market-service.ts`

当前 `listSkillsFromRepo()` 和 `findSkillDirs()` 是纯异步函数，不向外报告进度。`SkillMarketService` 也没有向 renderer 发送中间状态的机制。

## 解决方案

### 修复 ISSUE-001：添加令牌桶速率限制器

在 `gitcode-skill-source.service.ts` 中实现一个令牌桶（Token Bucket）速率限制器，与现有并发信号量协同工作：

```
请求 -> 令牌桶（30/min） -> 并发信号量（max 3） -> 实际 API 调用
```

- **令牌桶参数**：
  - 容量（bucket size）：30
  - 填充速率：30 个/分钟（即每 2 秒补充 1 个令牌）
  - 无令牌时：等待直到下一个令牌可用
- **与并发信号量的关系**：先获取令牌桶令牌，再获取并发信号量。两者串联。
- **遥测日志**：每次 API 调用时记录日志（采样，非每次），包括：总请求计数、令牌等待次数、令牌等待总时长。
- **实现位置**：`gitcode-skill-source.service.ts`，在 `withConcurrency()` 之前添加速率检查。

### 修复 ISSUE-002：前端加载进度 UI

在 `SkillMarket.tsx` 中增加分阶段加载进度展示：

- **新增状态**：`fetchProgress: { phase: 'scanning' | 'fetching-metadata' | 'done', current: number, total: number } | null`
- **UI 表现**：
  - `scanning` 阶段：显示 "正在扫描目录... (已扫描 N 个)" + 进度条
  - `fetching-metadata` 阶段：显示 "正在加载技能详情... (N/M)" + 进度条
  - `done` 阶段：恢复正常列表显示
- **刷新行为**：点击刷新按钮时，清除缓存，显示进度 UI，重新加载
- **回退兼容**：如果后端未发送进度事件（如 skills.sh 源），继续显示通用 Loading 状态

### 修复 ISSUE-003：后端进度上报机制

通过新增 IPC 通道实现主进程到渲染进程的进度通知：

- **新增 IPC 事件**：`skill:market:fetch-progress`（push 模式，主进程 -> 渲染进程）
- **事件载荷**：
  ```typescript
  interface SkillFetchProgress {
    phase: 'scanning' | 'fetching-metadata' | 'done';
    current: number;
    total: number;
  }
  ```
- **进度上报点**：
  - `findSkillDirs()`：每扫描完一个目录分支后回调一次（`current` = 已扫描目录数，`total` = 当前层的总目录数）
  - `listSkillsFromRepo()`：每获取完一个 skill 的元数据后回调一次（`current` = 已获取数，`total` = 发现的 skill 总数）
- **回调传递方式**：
  - `listSkillsFromRepo(repo, token, onProgress?)` 新增可选 `onProgress` 回调参数
  - `findSkillDirs(repo, path, token, maxDepth, onProgress?)` 同样新增可选回调
  - `SkillMarketService.fetchFromGitCodeRepo()` 创建回调，通过 `BrowserWindow.webContents.send()` 发送 IPC 事件
  - Preload 层暴露 `onSkillMarketFetchProgress(callback)` 监听方法
  - Renderer 的 `transport.ts` 映射该事件

## 技术方案

### 1. 令牌桶速率限制器实现

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`

```typescript
// ── Token Bucket Rate Limiter ─────────────────────────────────
const RATE_LIMIT_MAX_TOKENS = 30;        // 令牌桶容量
const RATE_LIMIT_REFILL_INTERVAL_MS = 2000; // 每 2 秒补充 1 个令牌
const RATE_LIMIT_REFILL_AMOUNT = 1;       // 每次补充 1 个

class TokenBucket {
  private _tokens: number;
  private _lastRefill: number;

  constructor(maxTokens: number) {
    this._tokens = maxTokens;
    this._lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this._lastRefill;
    const tokensToAdd = Math.floor(elapsed / RATE_LIMIT_REFILL_INTERVAL_MS) * RATE_LIMIT_REFILL_AMOUNT;
    if (tokensToAdd > 0) {
      this._tokens = Math.min(this._tokens + tokensToAdd, RATE_LIMIT_MAX_TOKENS);
      this._lastRefill = now;
    }
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this._tokens > 0) {
      this._tokens--;
      return;
    }
    // 计算等待时间
    const waitMs = RATE_LIMIT_REFILL_INTERVAL_MS;
    await new Promise((r) => setTimeout(r, waitMs));
    this.refill();
    this._tokens = Math.max(this._tokens - 1, 0);
  }
}

const _rateLimiter = new TokenBucket(RATE_LIMIT_MAX_TOKENS);
```

**修改 `withConcurrency()`**：在获取信号量之前先获取令牌：

```typescript
async function withConcurrency<T>(fn: () => Promise<T>): Promise<T> {
  await _rateLimiter.acquire(); // 先通过速率限制
  await _apiSemaphore.acquire(); // 再通过并发限制
  try {
    return await fn();
  } finally {
    _apiSemaphore.release();
  }
}
```

**遥测日志**：在 `withConcurrency` 中添加可选采样日志（每 10 次请求输出一次统计）。

### 2. 进度回调接口

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`

新增进度回调类型：

```typescript
export interface SkillFetchProgressCallback {
  (progress: { phase: 'scanning' | 'fetching-metadata'; current: number; total: number }): void;
}
```

修改 `findSkillDirs` 签名，新增可选 `onProgress` 参数：

```typescript
async function findSkillDirs(
  repo: string,
  path: string,
  token?: string,
  maxDepth?: number,
  onProgress?: SkillFetchProgressCallback,
): Promise<Array<{ path: string; name: string }>>
```

在扫描每个子目录后回调：`onProgress?.({ phase: 'scanning', current: scannedCount, total: totalDirs })`

修改 `listSkillsFromRepo` 签名，新增可选 `onProgress` 参数：

```typescript
export async function listSkillsFromRepo(
  repo: string,
  token?: string,
  onProgress?: SkillFetchProgressCallback,
): Promise<RemoteSkillItem[]>
```

在获取每个 skill 的元数据后回调：`onProgress?.({ phase: 'fetching-metadata', current: fetchedCount, total: uniqueDirs.length })`

### 3. IPC 通道注册

**文件**：`src/main/services/skill/skill-market-service.ts`

`fetchFromGitCodeRepo()` 方法中创建进度回调，通过 `BrowserWindow` 发送事件：

```typescript
private async fetchFromGitCodeRepo(
  source: SkillMarketSource,
  page: number,
  pageSize: number,
): Promise<{ skills: RemoteSkillItem[]; total: number; hasMore: boolean }> {
  // ... existing code ...

  const { BrowserWindow } = await import('electron');
  const mainWindow = BrowserWindow.getAllWindows()[0];

  const onProgress = (progress: { phase: string; current: number; total: number }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('skill:market:fetch-progress', progress);
    }
  };

  const repoSkills = await gitcodeSkillSource.listSkillsFromRepo(repo, token, onProgress);
  // ...
}
```

**文件**：`src/preload/index.ts`

在 `window.aicoBot` 中暴露监听方法：

```typescript
onSkillMarketFetchProgress: (callback: (progress: any) => void) => {
  const handler = (_event: any, progress: any) => callback(progress);
  ipcRenderer.on('skill:market:fetch-progress', handler);
  return () => ipcRenderer.removeListener('skill:market:fetch-progress', handler);
},
```

**文件**：`src/renderer/api/transport.ts`

在 `onEvent()` 的 `methodMap` 中添加映射：

```typescript
'skill:market:fetch-progress': 'onSkillMarketFetchProgress',
```

**文件**：`src/renderer/api/index.ts`

导出：

```typescript
onSkillMarketFetchProgress: (callback: (progress: SkillFetchProgress) => void) =>
  transport.onEvent('onSkillMarketFetchProgress', callback),
```

### 4. 前端进度 UI

**文件**：`src/renderer/components/skill/SkillMarket.tsx`

新增状态和监听：

```typescript
interface FetchProgress {
  phase: 'scanning' | 'fetching-metadata' | 'done';
  current: number;
  total: number;
}

const [fetchProgress, setFetchProgress] = useState<FetchProgress | null>(null);
```

在 `useEffect` 中监听进度事件：

```typescript
useEffect(() => {
  const cleanup = api.onSkillMarketFetchProgress((progress) => {
    setFetchProgress(progress);
    if (progress.phase === 'done') {
      setTimeout(() => setFetchProgress(null), 500);
    }
  });
  return cleanup;
}, []);
```

在搜索栏下方的状态区域替换当前的通用 Loading 文本：

```tsx
{loading ? (
  fetchProgress ? (
    <div className="space-y-1">
      <span className="flex items-center gap-1">
        <Loader2 className="w-3 h-3 animate-spin" />
        {fetchProgress.phase === 'scanning'
          ? t('Scanning directories...') + ` (${fetchProgress.current}/${fetchProgress.total || '?'})`
          : t('Loading skill details...') + ` (${fetchProgress.current}/${fetchProgress.total || '?'})`
        }
      </span>
      {fetchProgress.total > 0 && (
        <div className="w-full bg-secondary rounded-full h-1.5">
          <div
            className="bg-primary h-1.5 rounded-full transition-all duration-300"
            style={{ width: `${(fetchProgress.current / fetchProgress.total) * 100}%` }}
          />
        </div>
      )}
    </div>
  ) : (
    <span className="flex items-center gap-1">
      <Loader2 className="w-3 h-3 animate-spin" />
      {t('Loading...')}
    </span>
  )
) : (
  <span>{total} {t('skills')}</span>
)}
```

### 5. 缓存刷新与进度重置

在 `loadSkills` 回调和源切换逻辑中，当 `reset: true` 时清除 `fetchProgress` 状态：

```typescript
const loadSkills = useCallback(async (pageNum: number, reset: boolean = false) => {
  if (reset) {
    setFetchProgress(null);
  }
  // ... existing code ...
}, [debouncedQuery, t]);
```

## 影响范围

- [x] 涉及 API 变更 → `listSkillsFromRepo`、`findSkillDirs` 新增可选 `onProgress` 回调参数（向后兼容）
- [ ] 涉及数据结构变更 → 无（新增 `SkillFetchProgressCallback` 接口仅在内部使用）
- [ ] 涉及功能设计变更 → 无（体验优化，核心流程不变）

## 验收标准

1. **速率限制**：
   - 在一分钟内发起超过 30 次 GitCode API 请求时，日志中应显示令牌等待记录
   - 不应出现 429 速率限制错误（在正常使用场景下）
   - 遥测日志每 10 次请求输出一次统计信息

2. **加载进度**：
   - 切换到 GitCode 源后，前端应显示分阶段进度信息（先"扫描目录"，后"加载技能详情"）
   - 进度数字应随扫描/加载推进而更新
   - 进度条应平滑过渡
   - 加载完成后进度 UI 自动消失

3. **回退兼容**：
   - skills.sh 和 GitHub 源仍显示通用 Loading 状态，不受影响
   - 如果 `onProgress` 未传递，`listSkillsFromRepo` 行为与之前完全一致

4. **刷新行为**：
   - 点击刷新按钮后，进度重置并重新显示加载过程
   - 切换源时，旧的进度状态被清除

## 变更
| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-18 | 初始版本 | @MoonSeeker |
