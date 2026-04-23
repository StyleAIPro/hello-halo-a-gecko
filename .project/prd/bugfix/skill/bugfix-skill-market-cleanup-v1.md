# PRD [Bug 修复级] — 技能市场综合问题修复

> 版本：bugfix-skill-market-cleanup-v1
> 日期：2026-04-18
> 指令人：@MoonSeeker
> 反馈人：@MoonSeeker
> 归属模块：modules/skill
> 严重程度：Major

## 问题描述

在技能市场实现中发现 7 个问题，涵盖进度准确性、死代码、重复定义、分支覆盖、接口一致性、参数透传和竞态条件：

1. **进度不准确 — 递归扫描进度卡顿**（Major）：GitCode `findSkillDirs` 虽然已经不再向递归调用传递 `onProgress`，但 GitHub `findSkillDirs`（`github-skill-source.service.ts:325`）没有 `onProgress` 参数，完全不支持进度回调。这导致 GitHub 源的扫描阶段进度报告始终为空，用户看到的进度条在 scanning 阶段无更新。

2. **死代码事件通道**（Minor）：`skill:market:skill-found`、`skill:market:fetch-complete`、`skill:market:fetch-error` 三个 IPC 事件在 `src/preload/index.ts`（第 605-611 行类型声明、第 1171-1176 行实现）和 `src/renderer/api/transport.ts`（第 325-327 行 methodMap）和 `src/renderer/api/index.ts`（第 2382-2389 行导出）中注册，但主进程中没有任何代码发送这三个事件。这是之前回退的渐进式加载方案（v3 PRD 中 ISSUE-002）残留的代码。

3. **preload 重复定义**（Minor）：`skillAnalyzeConversations` 在 `src/preload/index.ts` 的类型接口（`AicoBotAPI`）中定义了两次（第 564 行和第 623 行），实现部分也定义了两次（第 1188 行和可能的其他位置）。由于 TypeScript 对象字面量中的重复属性后者覆盖前者，功能上不受影响，但代码维护困难。

4. **skills.sh 详情只尝试 main 分支**（Minor）：`fetchSkillContent`（`skill-market-service.ts:644-674`）在构建 raw.githubusercontent.com URL 时只使用 `main` 分支（第 653 行 `.../${repo}/main/${path}/SKILL.md`，第 663 行 `.../${repo}/main/${path}/README.md`），不尝试 `master` 分支。这导致使用 `master` 作为默认分支的仓库无法获取技能详情内容。

5. **GitCode validateRepo 缺少 hasSkillsDir**（Minor）：GitCode `validateRepo`（`gitcode-skill-source.service.ts:819-839`）返回类型为 `{ valid, error?, skillCount? }`，而 GitHub `validateRepo`（`github-skill-source.service.ts:635-676`）返回类型为 `{ valid, hasSkillsDir, skillCount, error? }`。GitCode 缺少 `hasSkillsDir` 字段，导致前端在使用统一接口时可能获取不到该字段。

6. **loadMarketSkills(sourceId) 参数透传 bug**（Major）：在 `skill.store.ts:319` 中 `loadMarketSkills` 接受可选 `sourceId` 参数并传给 `api.skillMarketList(sourceId)`。而 `src/renderer/api/index.ts:2350-2355` 中 `skillMarketList` 签名为 `(page?, pageSize?)`，调用 `window.aicoBot.skillMarketList(page, pageSize)`。IPC handler（`src/main/ipc/skill.ts:187`）将第一个参数解释为 `page`。因此 `sourceId` 会被错误地当作 `page` 参数传递。当前 UI 未直接调用 `loadMarketSkills(sourceId)`，但这是一个潜在的 bug，一旦被触发会导致分页逻辑错乱。

7. **快速切换源的竞态条件**（Minor）：在 `SkillMarket.tsx` 中，`loadingRef`（第 122 行）防止并发加载，但不能保证最新请求优先。当用户快速切换源时，如果旧请求的 Promise 在新请求之后 resolve，旧数据会覆盖新数据。`loadingRef` 机制只阻止新请求发起，不取消旧请求或忽略旧响应。

## 根因分析

### BUG-001：GitHub findSkillDirs 无进度回调

**文件**：`src/main/services/skill/github-skill-source.service.ts:325-372`

GitHub 的 `findSkillDirs` 函数签名中没有 `onProgress` 参数，递归遍历目录时无法向上层报告进度。与 GitCode 的 `findSkillDirs`（已经修复了递归传递问题）不一致。

**根因**：GitHub 源在实现时未考虑进度上报需求，两个源的实现没有对齐。

### BUG-002：死代码事件通道

**文件**：`src/preload/index.ts`、`src/renderer/api/transport.ts`、`src/renderer/api/index.ts`

v3 PRD 中的 ISSUE-002 方案设计了渐进式加载机制，添加了三个 push 事件通道。但该方案未被实现（或已回退），只留下了事件注册代码。

**根因**：PRD 方案实现/回退后未清理残留代码。

### BUG-003：preload 重复定义

**文件**：`src/preload/index.ts` 第 564 行和第 623 行（类型）、以及对应的实现

`skillAnalyzeConversations`、`skillCreateTempSession`、`skillSendTempMessage`、`skillCloseTempSession` 在 `AicoBotAPI` 接口中出现两次，在 `api` 对象实现中也出现两次（第 564-567 行附近和第 1188-1193 行附近）。

**根因**：合并冲突解决不当或复制粘贴错误。

### BUG-004：fetchSkillContent 只尝试 main 分支

**文件**：`src/main/services/skill/skill-market-service.ts:644-674`

URL 构建硬编码为 `https://raw.githubusercontent.com/${repo}/main/${path}/SKILL.md`，没有尝试 `master` 分支的回退逻辑。

**根因**：GitHub 的默认分支可能是 `main` 或 `master`，实现时只考虑了 `main`。

### BUG-005：GitCode validateRepo 返回值不一致

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts:819-839`

GitCode 的 `validateRepo` 返回类型为 `Promise<{ valid: boolean; error?: string; skillCount?: number }>`，缺少 `hasSkillsDir: boolean` 字段。

**根因**：两个源（GitHub/GitCode）的 `validateRepo` 独立实现，未统一接口规范。

### BUG-006：loadMarketSkills 参数透传错误

**文件**：`src/renderer/stores/skill/skill.store.ts:319`、`src/renderer/api/index.ts:2350-2355`、`src/main/ipc/skill.ts:187`

完整调用链：
1. `loadMarketSkills(sourceId?)` 调用 `api.skillMarketList(sourceId)`
2. `api.skillMarketList(page?, pageSize?)` 调用 `window.aicoBot.skillMarketList(page, pageSize)`
3. preload: `ipcRenderer.invoke('skill:market:list', sourceId, page, pageSize)`
4. IPC handler: `(_event, page?, pageSize?) => skillController.listMarketSkills(page, pageSize)`

当 `sourceId` 被传入时，IPC handler 的第一个参数接收到 `sourceId` 字符串并当作 `page` 使用。

**根因**：IPC handler 不接受 `sourceId` 参数（使用 `activeSourceId` 获取当前活跃源），但 preload 层和 API 层的参数签名没有与之对齐。

### BUG-007：快速切换源的竞态条件

**文件**：`src/renderer/components/skill/SkillMarket.tsx:372-410`

`loadingRef` 是一个简单的 boolean ref，仅用于防止并发加载。当用户快速切换源时：
1. 第一次切换触发 loadSkills()，`loadingRef = true`，发起请求 A
2. 第二次切换触发 loadSkills()，`loadingRef` 仍为 true，请求被跳过
3. 请求 A 完成后设置数据和 `loadingRef = false`
4. 数据来自旧源，但 UI 显示的是新源

**根因**：缺少请求取消机制（AbortController）和请求版本标识（requestId），无法区分新旧请求的响应。

## 修复方案

### 修复 BUG-001：GitHub findSkillDirs 添加进度回调

**文件**：`src/main/services/skill/github-skill-source.service.ts`

1. 为 `findSkillDirs` 添加可选 `onProgress` 参数（与 GitCode 签名一致）
2. 在递归调用中**不传递** `onProgress`（复用 GitCode 的模式，只在顶层报告进度）
3. 在 `listSkillsFromRepo` 调用 `findSkillDirs` 时传入 `onProgress`
4. 同步为 `listSkillsFromRepo` 方法添加 `onProgress` 回调参数
5. 在 `fetchFromGitHubRepo` 中创建 `sendProgress` 回调并发送 `skill:market:fetch-progress` 事件

### 修复 BUG-002：清理死代码事件通道

删除以下三处代码：

1. **`src/preload/index.ts`**：
   - 删除 `AicoBotAPI` 类型中的 `onSkillMarketSkillFound`、`onSkillMarketFetchComplete`、`onSkillMarketFetchError` 声明（第 605-611 行）
   - 删除 `api` 对象中对应的实现（第 1171-1176 行）

2. **`src/renderer/api/transport.ts`**：
   - 删除 `methodMap` 中的 `'skill:market:skill-found'`、`'skill:market:fetch-complete'`、`'skill:market:fetch-error'`（第 325-327 行）

3. **`src/renderer/api/index.ts`**：
   - 删除 `onSkillMarketSkillFound`、`onSkillMarketFetchComplete`、`onSkillMarketFetchError` 导出（第 2382-2389 行）

### 修复 BUG-003：删除 preload 重复定义

**文件**：`src/preload/index.ts`

1. 从 `AicoBotAPI` 接口中删除重复的声明（第 623-626 行的 `skillAnalyzeConversations`、`skillCreateTempSession`、`skillSendTempMessage`、`skillCloseTempSession`）
2. 从 `api` 对象中删除重复的实现（如果有）

### 修复 BUG-004：fetchSkillContent 添加 master 分支回退

**文件**：`src/main/services/skill/skill-market-service.ts`

修改 `fetchSkillContent` 方法，在 `main` 分支失败后尝试 `master` 分支：

```typescript
const branches = ['main', 'master'];

for (const branch of branches) {
  for (const path of basePaths) {
    try {
      const skillMdUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${path}/SKILL.md`;
      const response = await fetch(skillMdUrl);
      if (response.ok) {
        return await response.text();
      }
    } catch {
      // 继续尝试
    }

    try {
      const readmeUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${path}/README.md`;
      const response = await fetch(readmeUrl);
      if (response.ok) {
        return await response.text();
      }
    } catch {
      // 继续尝试
    }
  }
}
```

### 修复 BUG-005：GitCode validateRepo 添加 hasSkillsDir

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`

修改 `validateRepo` 返回类型，添加 `hasSkillsDir` 字段：

```typescript
export async function validateRepo(
  repo: string,
  token?: string,
): Promise<{ valid: boolean; hasSkillsDir: boolean; skillCount: number; error?: string }> {
```

在实现中添加 `skills/` 目录探测逻辑（与 GitHub `validateRepo` 一致），设置 `hasSkillsDir` 值。

### 修复 BUG-006：统一 skillMarketList 参数签名

涉及文件：
- `src/renderer/stores/skill/skill.store.ts`：`loadMarketSkills` 不再传 `sourceId`
- `src/renderer/api/index.ts`：确认 `skillMarketList` 签名为 `(page?, pageSize?)`
- `src/preload/index.ts`：确认 `skillMarketList` 签名为 `(sourceId?, page?, pageSize?)`

**方案**：由于 IPC handler 不支持 `sourceId` 参数（使用 `activeSourceId`），最简修复方式是从 `skill.store.ts` 的 `loadMarketSkills` 中移除 `sourceId` 参数，确保不会误传。如果未来需要按 sourceId 查询，应在 IPC handler 层面添加支持。

### 修复 BUG-007：添加请求版本标识解决竞态

**文件**：`src/renderer/components/skill/SkillMarket.tsx`

1. 使用 `useRef` 维护递增的 `requestId`
2. 在 `loadSkills` 开始时递增 `requestId` 并保存当前值
3. 在异步操作完成后检查 `requestId` 是否仍然是当前值
4. 如果不是当前值（说明有更新的请求），丢弃旧响应

```typescript
const requestIdRef = useRef(0);

const loadSkills = useCallback(async (pageNum: number, reset: boolean = false) => {
  if (loadingRef.current) return;
  loadingRef.current = true;
  setLoading(true);
  setLoadError(null);
  if (reset) setFetchProgress(null);

  const currentRequestId = ++requestIdRef.current;

  try {
    // ... existing fetch logic ...
    if (currentRequestId !== requestIdRef.current) return; // 丢弃旧响应
    // ... existing state updates ...
  } catch (error) {
    if (currentRequestId !== requestIdRef.current) return;
    // ... existing error handling ...
  } finally {
    if (currentRequestId === requestIdRef.current) {
      setLoading(false);
      loadingRef.current = false;
      setFetchProgress(null);
    }
  }
}, [debouncedQuery, t]);
```

## 影响范围

- [ ] 涉及 API 变更 → 无（IPC handler 接口不变）
- [ ] 涉及数据结构变更 → 无
- [x] 涉及功能设计变更 → `validateRepo` 返回类型变更（GitCode 新增 `hasSkillsDir` 字段），向前兼容

## 验证方式

1. **进度准确性**（BUG-001）：切换到 GitHub 源，观察进度条在 scanning 阶段是否有更新，不再卡顿不动
2. **死代码清理**（BUG-002）：确认 `grep -r "skill:market:skill-found\|skill:market:fetch-complete\|skill:market:fetch-error" src/` 在主进程中无结果
3. **重复定义清除**（BUG-003）：确认 `src/preload/index.ts` 中无重复的方法声明和实现
4. **master 分支回退**（BUG-004）：使用默认分支为 `master` 的 GitHub 仓库，确认技能详情能正常加载
5. **validateRepo 一致性**（BUG-005）：调用 GitCode `validateRepo`，确认返回值包含 `hasSkillsDir` 字段
6. **参数透传**（BUG-006）：确认 `loadMarketSkills()` 不传递多余参数，IPC handler 正确接收 `page` 和 `pageSize`
7. **竞态条件**（BUG-007）：快速连续切换两个不同的市场源，确认最终显示的是最后选择的源的数据，不会被旧请求覆盖

## 变更
| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-18 | 初始版本：7 个 BUG 的分析和修复方案 | @MoonSeeker |
