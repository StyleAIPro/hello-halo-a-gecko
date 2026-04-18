# PRD [Bug 修复级] — 技能市场加载体验统一与优化

> 版本：bugfix-skill-market-experience-v3
> 日期：2026-04-18
> 指令人：@MoonSeeker
> 反馈人：@MoonSeeker
> 归属模块：modules/skill
> 严重程度：Major

## 背景

v2 PRD (`bugfix-gitcode-skill-fetch-v2.md`) 实现了 GitCode 源的速率限制和加载进度反馈。当前已落地，但存在三个体验问题：

1. **GitHub 和 GitCode 源的加载体验不一致**：GitCode 有进度条反馈，GitHub 只显示通用 "Loading..."，两者应统一。
2. **大仓库首次加载阻塞**：GitCode 等源在首次加载时需递归扫描目录 + 批量获取元数据，整个过程可能需要数分钟（受速率限制约束），用户在此期间只看到进度条，无法看到任何已加载的 skill。
3. **进度计数不准确**：`findSkillDirs` 递归扫描的进度报告存在数值不一致和可能卡住的问题。

## 问题分析

### ISSUE-001：GitHub 和 GitCode 显示方式不一致

**文件**：`src/main/services/skill/skill-market-service.ts`

- `fetchFromGitCodeRepo()`（第 766-822 行）通过 `sendProgress` 回调向渲染进程发送 `skill:market:fetch-progress` 事件，前端显示进度条。
- `fetchFromGitHubRepo()`（第 681-718 行）没有进度回调，调用 `githubSkillSource.listSkillsFromRepo()` 时不传递 `onProgress`，前端只显示通用 "Loading..."。

GitHub 和 GitCode 的 `listSkillsFromRepo` 返回结构完全相同的 `RemoteSkillItem[]`，但 GitHub 源缺少进度上报。

### ISSUE-002：首次加载阻塞 — 用户等待时间过长

**文件**：`src/main/services/skill/skill-market-service.ts`、`src/main/services/skill/gitcode-skill-source.service.ts`

当前所有源（GitHub、GitCode、skills.sh）都在第一次请求时全量拉取并缓存 skill，然后分页返回。对于 GitCode，受速率限制（2s/请求）和并发限制（max 3）约束，获取大量 skill 的元数据可能需要数分钟。用户在此期间只能看到进度条，无法与已加载的 skill 交互。

**根因**：`fetchFromGitCodeRepo()` 中的 `listSkillsFromRepo()` 是阻塞式调用，所有 skill 加载完毕后才返回，前端在此期间不会更新技能列表。

### ISSUE-003：`findSkillDirs` 进度计数不准确且可能卡住

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`（第 319-374 行）

问题代码（第 354-366 行）：

```typescript
let scannedCount = 0;
const totalDirs = dirs.length; // 这是当前层级目录数，不是总 skill 数

const subResults = await Promise.all(
  dirs.map(async (dir: any) => {
    const sub = await withConcurrency(() =>
      findSkillDirs(repo, subPath, token, maxDepth - 1, onProgress),
    );
    scannedCount++;
    onProgress?.({ phase: 'scanning', current: scannedCount, total: totalDirs });
    return sub;
  }),
);
```

三个问题：
1. **`total` 是当前层级的子目录数**，不是总 skill 数。如果根目录有 49 个子目录，进度显示 47/49，但实际可能只有 5 个 skill dir。
2. **递归调用中每层都报告进度**，深层报告覆盖浅层报告，数值不一致。第 361 行将 `onProgress` 传递给递归调用 `findSkillDirs(repo, subPath, token, maxDepth - 1, onProgress)`，导致子目录内部的进度事件覆盖父级的进度事件。
3. **如果某个目录的 API 调用超时或卡住**，进度永远停在 N-1/M。

## 解决方案

### 修复 ISSUE-001：GitHub 源添加进度上报

为 `githubSkillSource.listSkillsFromRepo()` 添加 `onProgress` 回调参数（与 GitCode 签名一致），在 `fetchFromGitHubRepo()` 中通过 IPC 发送进度事件。

- `github-skill-source.service.ts` 的 `listSkillsFromRepo(repo, token?, onProgress?)` 新增可选参数
- `skill-market-service.ts` 的 `fetchFromGitHubRepo()` 中创建 `sendProgress` 回调（复用 GitCode 的模式）
- 前端无需改动（已有通用的进度 UI 渲染逻辑）

### 修复 ISSUE-002：渐进式加载 — 逐个推送已发现的 skill

采用最简方案，不改变现有架构的缓存和分页机制：

1. 后端新增 IPC push 事件 `skill:market:skill-found`，每获取完一个 skill 的元数据后立即推送给前端
2. 后端新增 IPC push 事件 `skill:market:fetch-complete`，全部加载完成后推送最终统计
3. 首次 `skillMarketList(page=1)` 对 GitCode/GitHub 源立即返回 `{ skills: [], total: 0, hasMore: true }`，让前端进入等待推送模式
4. 前端收到 `skill:market:skill-found` 事件后，将 skill 追加到列表并实时渲染
5. 收到 `skill:market:fetch-complete` 后，更新 total 和 hasMore 状态
6. 已缓存的情况下（非首次加载），走原有的缓存分页逻辑，不触发推送模式

**关键设计**：
- 推送模式下 `loading` 仍为 `true`，进度条继续显示，但 skill 卡片同步出现
- 分页缓存机制不变，推送结束后后续翻页仍从缓存 slice
- `skill:market:fetch-progress` 事件保留，与 `skill:market:skill-found` 并行工作

### 修复 ISSUE-003：修正 `findSkillDirs` 进度报告

1. **递归内部不触发进度回调**：将 `onProgress` 包装为顶层专用版本，递归调用不传递回调
2. **改用"不确定总数"模式**：scanning 阶段只显示 "已扫描 N 个目录"，不显示 `/M`（因为事先无法知道总 skill 数）
3. **添加超时保护**：如果单个目录扫描超过 30s，标记为跳过并继续，避免卡住

## 技术方案

### 1. GitHub 源进度上报

**文件**：`src/main/services/skill/github-skill-source.service.ts`

修改 `listSkillsFromRepo` 签名，新增可选 `onProgress` 参数：

```typescript
export async function listSkillsFromRepo(
  repo: string,
  token?: string,
  onProgress?: SkillFetchProgressCallback,
): Promise<RemoteSkillItem[]>
```

在内部递归扫描目录和获取元数据的循环中，添加进度回调调用。由于 GitHub API 没有严格的速率限制问题，可以直接在每次获取目录和每次获取元数据后回调。

**文件**：`src/main/services/skill/skill-market-service.ts`

`fetchFromGitHubRepo()` 方法中添加 `sendProgress` 回调（与 `fetchFromGitCodeRepo` 完全相同的模式）：

```typescript
private async fetchFromGitHubRepo(
  source: SkillMarketSource,
  page: number,
  pageSize: number,
): Promise<{ skills: RemoteSkillItem[]; total: number; hasMore: boolean }> {
  // ... existing cache check ...

  const sendProgress = (progress: { phase: string; current: number; total: number }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('skill:market:fetch-progress', progress);
    }
  };

  const repoSkills = await githubSkillSource.listSkillsFromRepo(repo, token, sendProgress);
  // ... existing cache logic ...
}
```

### 2. 渐进式加载 — 后端 push 机制

#### 2.1 IPC 事件定义

**文件**：`src/shared/constants/` 中新增 IPC 通道常量（或直接在 `skill-market-service.ts` 中使用字符串常量）

新增两个 push 事件：
- `skill:market:skill-found` — 单个 skill 发现事件
- `skill:market:fetch-complete` — 全部加载完成事件

事件载荷：

```typescript
// skill:market:skill-found
interface SkillFoundEvent {
  skill: RemoteSkillItem;
  total: number;  // 当前已发现的 skill 总数（递增）
}

// skill:market:fetch-complete
interface FetchCompleteEvent {
  total: number;
  sourceId: string;
}
```

#### 2.2 `fetchFromGitCodeRepo` 改造

**文件**：`src/main/services/skill/skill-market-service.ts`

```typescript
private async fetchFromGitCodeRepo(
  source: SkillMarketSource,
  page: number,
  pageSize: number,
): Promise<{ skills: RemoteSkillItem[]; total: number; hasMore: boolean }> {
  const sourceId = source.id;
  const offset = (page - 1) * pageSize;
  const repos = source.repos || [];
  const token = gitcodeSkillSource.getGitCodeToken();

  let cachedSkills = this.skillsCache.get(sourceId);
  if (cachedSkills) {
    // 已缓存：走原有分页逻辑
    const total = cachedSkills.length;
    const hasMore = offset + pageSize < total;
    const skills = cachedSkills.slice(offset, offset + pageSize);
    return { skills, total, hasMore };
  }

  // 首次加载：立即返回空列表 + hasMore=true，让前端进入等待推送模式
  // 后台异步加载
  if (!this._fetchInProgress.has(sourceId)) {
    this._fetchInProgress.add(sourceId);
    this._doBackgroundFetch(sourceId, repos, token).finally(() => {
      this._fetchInProgress.delete(sourceId);
    });
  }

  return { skills: [], total: 0, hasMore: true };
}
```

新增私有方法和状态：

```typescript
// 后台加载进行中标记
private _fetchInProgress: Set<string> = new Set();

private async _doBackgroundFetch(
  sourceId: string,
  repos: string[],
  token: string | undefined,
): Promise<void> {
  gitcodeSkillSource.resetProxyDispatcher();
  const allSkills: RemoteSkillItem[] = [];
  const errors: string[] = [];

  const sendProgress = (progress: { phase: string; current: number; total: number }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('skill:market:fetch-progress', progress);
    }
  };

  // 自定义 onProgress：在获取每个 skill 元数据后推送
  const onSkillFound = (skill: RemoteSkillItem, count: number) => {
    allSkills.push(skill);
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('skill:market:skill-found', {
        skill,
        total: count,
      });
    }
  };

  for (const repo of repos) {
    try {
      // 使用支持逐个回调的 listSkillsFromRepo
      const repoSkills = await gitcodeSkillSource.listSkillsFromRepoStreaming(
        repo, token, sendProgress, onSkillFound,
      );
      allSkills.push(...repoSkills);
    } catch (error: any) {
      const msg = error?.message || String(error);
      errors.push(`${repo}: ${msg}`);
      console.error(`[SkillMarketService] Failed to fetch from GitCode repo ${repo}:`, error);
    }
  }

  // 发送完成事件
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('skill:market:fetch-complete', {
      total: allSkills.length,
      sourceId,
    });
  }

  // Signal completion (existing progress event)
  sendProgress({ phase: 'scanning', current: 0, total: 0 });

  // 缓存结果
  if (allSkills.length > 0 || errors.length === 0) {
    this.skillsCache.set(sourceId, allSkills);
  }
  if (allSkills.length === 0 && errors.length > 0) {
    // 发送错误事件让前端显示
    mainWindow?.webContents?.send('skill:market:fetch-error', {
      error: `Failed to fetch GitCode skills: ${errors.join('; ')}`,
      sourceId,
    });
  }
}
```

#### 2.3 `listSkillsFromRepoStreaming` 新增

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`

新增 `listSkillsFromRepoStreaming` 方法，与 `listSkillsFromRepo` 逻辑一致，但在获取每个 skill 元数据后通过 `onSkillFound` 回调立即推送：

```typescript
export type SkillFoundCallback = (skill: RemoteSkillItem, totalFound: number) => void;

export async function listSkillsFromRepoStreaming(
  repo: string,
  token?: string,
  onProgress?: SkillFetchProgressCallback,
  onSkillFound?: SkillFoundCallback,
): Promise<RemoteSkillItem[]> {
  const skills: RemoteSkillItem[] = [];
  const sourceId = `gitcode:${repo}`;
  const seenPaths = new Set<string>();
  const pathsToCheck = ['skills/', '/'];

  for (const basePath of pathsToCheck) {
    try {
      const skillDirs = await findSkillDirs(repo, basePath, token, 5, onProgress);
      const uniqueDirs = skillDirs.filter(({ path: p }) => {
        if (seenPaths.has(p)) return false;
        seenPaths.add(p);
        return true;
      });

      let metadataFetched = 0;
      const totalToFetch = uniqueDirs.length;

      // 逐个获取元数据（非 Promise.all），每个完成后立即推送
      for (const { path: skillPath, name } of uniqueDirs) {
        try {
          const item = await withConcurrency(async () => {
            let frontmatter: SkillFrontmatter = {};
            let description = '';
            try {
              const content = await fetchSkillFileContent(repo, `${skillPath}/SKILL.md`, token);
              if (content) {
                const parsed = parseFrontmatter(content);
                frontmatter = parsed.frontmatter;
                description = parsed.body.split('\n').filter((l) => l.trim() && !l.startsWith('#')).slice(0, 3).join(' ');
              }
            } catch { /* continue without metadata */ }

            const skillName = frontmatter.name || name;
            const skillId = skillPath.toLowerCase().replace(/\s+/g, '-');
            return {
              id: `${sourceId}:${skillId}`,
              name: formatSkillName(skillName),
              description: frontmatter.description || description || `Skill from ${repo}`,
              fullDescription: undefined,
              version: frontmatter.version || '1.0.0',
              author: frontmatter.author || repo.split('/')[0],
              tags: frontmatter.tags || [],
              lastUpdated: new Date().toISOString(),
              sourceId,
              githubRepo: repo,
              githubPath: skillPath,
            } as RemoteSkillItem;
          });

          skills.push(item);
          metadataFetched++;
          onProgress?.({ phase: 'fetching-metadata', current: metadataFetched, total: totalToFetch });
          onSkillFound?.(item, skills.length);
        } catch {
          metadataFetched++;
          onProgress?.({ phase: 'fetching-metadata', current: metadataFetched, total: totalToFetch });
        }
      }

      if (skills.length > 0 && basePath === 'skills/') break;
    } catch (error) {
      console.error(`[GitCodeSkillSource] Error listing ${repo}/${basePath}:`, error);
    }
  }

  return skills;
}
```

#### 2.4 同样对 GitHub 源应用 `fetchFromGitHubRepo` 后台加载

**文件**：`src/main/services/skill/skill-market-service.ts`

对 `fetchFromGitHubRepo()` 应用相同的模式：首次加载返回空列表 + 后台推送。

#### 2.5 Preload 层暴露新事件

**文件**：`src/preload/index.ts`

```typescript
onSkillMarketSkillFound: (callback: (data: { skill: any; total: number }) => void) => {
  const handler = (_event: any, data: any) => callback(data);
  ipcRenderer.on('skill:market:skill-found', handler);
  return () => ipcRenderer.removeListener('skill:market:skill-found', handler);
},
onSkillMarketFetchComplete: (callback: (data: { total: number; sourceId: string }) => void) => {
  const handler = (_event: any, data: any) => callback(data);
  ipcRenderer.on('skill:market:fetch-complete', handler);
  return () => ipcRenderer.removeListener('skill:market:fetch-complete', handler);
},
onSkillMarketFetchError: (callback: (data: { error: string; sourceId: string }) => void) => {
  const handler = (_event: any, data: any) => callback(data);
  ipcRenderer.on('skill:market:fetch-error', handler);
  return () => ipcRenderer.removeListener('skill:market:fetch-error', handler);
},
```

#### 2.6 Renderer API 层映射

**文件**：`src/renderer/api/transport.ts`

在 `onEvent()` 的 `methodMap` 中添加：

```typescript
'skill:market:skill-found': 'onSkillMarketSkillFound',
'skill:market:fetch-complete': 'onSkillMarketFetchComplete',
'skill:market:fetch-error': 'onSkillMarketFetchError',
```

**文件**：`src/renderer/api/index.ts`

导出：

```typescript
onSkillMarketSkillFound: (callback: (data: { skill: RemoteSkillItem; total: number }) => void) =>
  transport.onEvent('onSkillMarketSkillFound', callback),
onSkillMarketFetchComplete: (callback: (data: { total: number; sourceId: string }) => void) =>
  transport.onEvent('onSkillMarketFetchComplete', callback),
onSkillMarketFetchError: (callback: (data: { error: string; sourceId: string }) => void) =>
  transport.onEvent('onSkillMarketFetchError', callback),
```

#### 2.7 前端监听并实时渲染

**文件**：`src/renderer/components/skill/SkillMarket.tsx`

```typescript
// 在 useEffect 中监听新事件
useEffect(() => {
  const cleanupFound = api.onSkillMarketSkillFound((data) => {
    setSkills((prev) => [...prev, data.skill]);
    setTotal(data.total);
  });

  const cleanupComplete = api.onSkillMarketFetchComplete((data) => {
    setTotal(data.total);
    setHasMore(data.total > skills.length); // 如果推送的 skill 比 total 少，说明 hasMore
    setLoading(false);
    loadingRef.current = false;
    setFetchProgress(null);
  });

  const cleanupError = api.onSkillMarketFetchError((data) => {
    setLoadError(data.error);
    setLoading(false);
    loadingRef.current = false;
    setFetchProgress(null);
  });

  return () => {
    cleanupFound();
    cleanupComplete();
    cleanupError();
  };
}, []);
```

在 `loadSkills` 中，当收到 `skills: []` + `hasMore: true` 的首次响应时，不将 `skills` 设为空（保留已有推送的 skill）：

```typescript
if (result.success && result.data) {
  const newSkills = result.data.skills || [];
  if (newSkills.length === 0 && result.data.hasMore && reset) {
    // 首次加载进入推送模式：不清除 skills，保持 loading 状态
    // 前端已通过 skill-found 事件追加 skill
    setHasMore(true);
  } else if (reset || pageNum === 1) {
    setSkills(newSkills);
    setHasMore(result.data.hasMore || false);
  } else {
    setSkills((prev) => [...prev, ...newSkills]);
    setHasMore(result.data.hasMore || false);
  }
  if (result.data.total > 0) setTotal(result.data.total);
  setPage(pageNum);
}
```

### 3. 修正 `findSkillDirs` 进度报告

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`

#### 3.1 递归内部不触发进度回调

修改 `findSkillDirs`，将 `onProgress` 替换为包装后的顶层专用回调：

```typescript
async function findSkillDirs(
  repo: string,
  path: string,
  token?: string,
  maxDepth: number = 5,
  onProgress?: SkillFetchProgressCallback,
): Promise<Array<{ path: string; name: string }>> {
  if (maxDepth <= 0) return [];

  const apiPath =
    path === '/' ? `/repos/${repo}/contents` : `/repos/${repo}/contents/${path.replace(/\/$/, '')}`;

  let data: any[];
  try {
    const result = await withConcurrency(() => gitcodeApiFetch(apiPath, { token }));
    if (!Array.isArray(result)) return [];
    data = result;
  } catch {
    return [];
  }

  const dirs = data.filter((item: any) => item.type === 'dir' && !item.name.startsWith('.'));
  const hasSkillMd = data.some(
    (item: any) => item.type === 'file' && item.name.toUpperCase() === 'SKILL.MD',
  );

  const results: Array<{ path: string; name: string }> = [];

  if (hasSkillMd) {
    const dirName = path === '/' ? '' : path.replace(/\/$/, '').split('/').pop()!;
    results.push({ path: path.replace(/\/$/, ''), name: dirName });
    return results;
  }

  // 只由最顶层调用者触发进度回调，递归内部不触发
  let scannedCount = 0;
  const totalDirs = dirs.length;

  const subResults = await Promise.all(
    dirs.map(async (dir: any) => {
      const subPath = path === '/' ? `${dir.name}/` : `${path}${dir.name}/`;
      // 递归调用不传递 onProgress，避免深层进度覆盖浅层进度
      const sub = await withConcurrency(() =>
        findSkillDirs(repo, subPath, token, maxDepth - 1),
      );
      scannedCount++;
      onProgress?.({
        phase: 'scanning',
        current: scannedCount,
        total: totalDirs,
      });
      return sub;
    }),
  );

  for (const sub of subResults) {
    results.push(...sub);
  }

  return results;
}
```

关键变更：第 361 行的递归调用 `findSkillDirs(repo, subPath, token, maxDepth - 1, onProgress)` 改为 `findSkillDirs(repo, subPath, token, maxDepth - 1)`，不再传递 `onProgress`。

#### 3.2 前端 scanning 阶段不显示 `/M`

**文件**：`src/renderer/components/skill/SkillMarket.tsx`

进度 UI 中 scanning 阶段不再显示 `/total`，改为 "已扫描 N 个目录"：

```tsx
{fetchProgress.phase === 'scanning'
  ? t('Scanning directories...') + ` (${t('scanned')} ${fetchProgress.current} ${t('directories')})`
  : t('Loading skill details...') + ` (${fetchProgress.current}/${fetchProgress.total})`
}
```

## 影响范围

- [x] 涉及 API 变更 → `listSkillsFromRepo`（GitHub）新增可选 `onProgress` 参数；新增 `listSkillsFromRepoStreaming`（GitCode）
- [x] 涉及 IPC 通道新增 → `skill:market:skill-found`、`skill:market:fetch-complete`、`skill:market:fetch-error`
- [ ] 涉及数据结构变更 → 无（复用现有 `RemoteSkillItem`）
- [ ] 涉及功能设计变更 → 无（体验优化，核心流程不变）

## 验收标准

1. **GitHub 源进度反馈**：
   - 切换到 GitHub 源后，前端应显示加载进度（非通用 "Loading..."）
   - 进度信息应随扫描/加载推进而更新

2. **渐进式加载**：
   - 首次加载 GitCode/GitHub 源时，skill 卡片应逐个出现在列表中（而非一次性全部出现）
   - 加载期间进度条仍显示
   - 已出现的 skill 卡片可以点击查看详情
   - 全部加载完成后，进度条消失，total 更新为最终值

3. **缓存命中时无变化**：
   - 第二次加载同一源时，直接从缓存分页返回，无推送事件，体验与之前一致

4. **进度计数准确**：
   - scanning 阶段只显示 "已扫描 N 个目录"，不显示不准确的 `/M`
   - fetching-metadata 阶段继续显示 `current/total`
   - 不会因某个目录超时而卡住进度

5. **刷新行为**：
   - 点击刷新按钮后，清除缓存，skill 列表清空，重新进入渐进式加载模式
   - 切换源时，旧的推送状态被清除

6. **错误处理**：
   - 后台加载失败时，前端显示错误信息
   - 已推送的 skill 在错误发生后仍保留在列表中

## 变更
| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-18 | 初始版本：三个 ISSUE 的分析和修复方案 | @MoonSeeker |
