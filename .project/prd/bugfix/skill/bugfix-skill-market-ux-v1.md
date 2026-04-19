# PRD [Bug 修复级] — 技能市场 UX 精修与请求优化

> 版本：bugfix-skill-market-ux-v1
> 日期：2026-04-18
> 指令人：@MoonSeeker
> 反馈人：@MoonSeeker
> 归属模块：modules/skill
> 严重程度：Major

## 背景

v1 清理 PRD（`bugfix-skill-market-cleanup-v1.md`）修复了技能市场的 7 项综合问题。在此基础上，技能市场仍存在 3 个体验层面的问题：

1. **GitCode 加载进度跳跃**：`listSkillsFromRepo` 使用 `Promise.all` 并行获取所有 SKILL.md 元数据，导致进度从 0% 直接跳到 100%，无中间更新，用户感知为"卡住后突然完成"。
2. **前端初始激活源与后端不一致**：前端通过 `marketSources.find(s => s.enabled)` 取第一个启用的源作为 `activeSourceId`，但后端有自己的 `activeSourceId` 存储在配置中。当用户将非首位的源设为活跃时，页面刷新后前端和后端会指向不同的源，导致数据错乱。
3. **GitHub 元数据获取被误改为顺序执行**：在上一轮修复中，GitHub 的 `listSkillsFromRepo` 不慎从并行 `Promise.all` 改为顺序 `for...of`，拖慢了加载速度。GitHub 无速率限制，应保持并行。

## 问题分析

### BUG-001：GitCode 加载进度跳跃（Major）

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`

当前 `listSkillsFromRepo` 中，元数据获取使用 `Promise.all` 并行发起所有请求：

```typescript
const results = await Promise.all(
  uniqueDirs.map(async ({ path: skillPath, name }) => {
    // 获取 SKILL.md 元数据
    const item = await withConcurrency(async () => { /* ... */ });
    return item;
  }),
);
```

所有请求并发发出，`onProgress` 回调要么全部在同一帧触发（几乎同时完成），要么只在最后一个完成时报告，导致进度条从 0% 瞬间跳到 100%。

**根因**：`Promise.all` 并行模式不适合需要逐个报告进度的场景。GitCode 有速率限制（令牌桶 + 并发信号量），请求实际上会被排队串行化，但进度回调仍基于 Promise resolve 时机，无法反映真实的逐个完成状态。

**影响**：用户体验差 — 进度条无中间更新，用户以为加载卡住了。

### BUG-002：前端初始激活源与后端不一致（Major）

**文件**：
- `src/renderer/stores/skill/skill.store.ts`
- `src/renderer/components/skill/SkillMarket.tsx`

当前前端初始化逻辑（`SkillMarket.tsx` 的 `useEffect`）：

```typescript
const initialSource = marketSources.find(s => s.enabled);
if (initialSource) {
  setActiveSourceId(initialSource.id);
}
```

这里取的是第一个 **启用**（`enabled`）的源，而非后端配置中的 **活跃**（`active`）源。后端通过 `SkillMarketService.getSkills()` 返回的 `activeSourceId` 字段指示当前活跃源。

当用户将非首位源（如 GitCode）设为活跃源后刷新页面，前端会错误地选择第一个启用的源（如 GitHub），导致：
- UI 显示 GitHub 源选中，但后端请求的是 GitCode 数据
- 用户看到的数据与所选源不匹配

**根因**：前端初始化时未读取后端返回的 `activeSourceId`，而是自行根据 `enabled` 字段推断。

### BUG-003：GitHub 元数据获取被误改为顺序执行（Minor, 优化）

**文件**：`src/main/services/skill/github-skill-source.service.ts`

在 `bugfix-skill-market-cleanup-v1` 的修复过程中，GitHub 的 `listSkillsFromRepo` 中的元数据获取被不慎从并行 `Promise.all` 改为了顺序 `for...of` 循环（可能是与 GitCode 的修复混在一起时误改）。

GitHub API 无严格的速率限制要求，并行获取元数据可以充分利用网络带宽，显著加快加载速度。改为顺序执行后，加载时间线性增长（N 个技能 = N 倍延迟）。

**根因**：修复 BUG-001（GitCode 进度问题）时，将 GitCode 的 `Promise.all` 改为 `for...of` 以支持逐个进度上报，此改动被不慎应用到 GitHub 源。

## 解决方案

### 修复 BUG-001：GitCode 元数据获取改为顺序循环

将 GitCode `listSkillsFromRepo` 中的 `Promise.all` 改为 `for...of` 顺序循环，每获取完一个 skill 的元数据后立即报告进度：

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`

```typescript
// 修改前（并行，进度跳跃）
const results = await Promise.all(
  uniqueDirs.map(async ({ path: skillPath, name }) => {
    const item = await withConcurrency(async () => { /* ... */ });
    return item;
  }),
);

// 修改后（顺序，逐个报告进度）
const results: RemoteSkillItem[] = [];
for (let i = 0; i < uniqueDirs.length; i++) {
  const { path: skillPath, name } = uniqueDirs[i];
  const item = await withConcurrency(async () => { /* ... */ });
  results.push(item);
  onProgress?.({ phase: 'fetching-metadata', current: i + 1, total: uniqueDirs.length });
}
```

由于 GitCode 已有速率限制（令牌桶 + 并发信号量），顺序执行不会增加总请求时间（请求本来就是被排队的），但能让进度条平滑推进。

### 修复 BUG-002：前端从后端响应获取 activeSourceId

#### Store 层（`src/renderer/stores/skill/skill.store.ts`）

新增 `_activeSourceId` 状态，从后端响应中读取：

```typescript
// 新增状态
const _activeSourceId = useState<string | null>(null);

// 在 loadMarketSources 成功后，从后端响应提取 activeSourceId
// 后端 getSources() 返回 { sources, activeSourceId }
```

#### 组件层（`src/renderer/components/skill/SkillMarket.tsx`）

修改初始化 `useEffect`，优先使用 store 中的 `_activeSourceId`：

```typescript
useEffect(() => {
  // 优先使用后端返回的 activeSourceId
  const backendActiveId = _activeSourceId; // 从 store 读取
  const fallbackSource = marketSources.find(s => s.enabled);

  if (backendActiveId && marketSources.some(s => s.id === backendActiveId)) {
    setActiveSourceId(backendActiveId);
  } else if (fallbackSource) {
    setActiveSourceId(fallbackSource.id);
  }
}, [marketSources, _activeSourceId]);
```

#### 竞态条件防护

在 `SkillMarket.tsx` 中，已有 `fetchGenerationRef` 机制（v1 清理 PRD 中添加）用于丢弃过期结果。确保该机制在源切换时正确递增，防止快速切换时旧结果覆盖新结果。

### 修复 BUG-003：GitHub 恢复并行元数据获取

将 GitHub `listSkillsFromRepo` 中的元数据获取恢复为 `Promise.all` 并行模式：

**文件**：`src/main/services/skill/github-skill-source.service.ts`

```typescript
// 恢复为并行获取
const results = await Promise.all(
  uniqueDirs.map(async ({ path: skillPath, name }) => {
    const item = await fetchSkillMetadata(skillPath, name);
    return item;
  }),
);

// 进度在所有完成后一次性报告
onProgress?.({ phase: 'fetching-metadata', current: uniqueDirs.length, total: uniqueDirs.length });
```

GitHub 无速率限制，并行获取可以最大化加载速度。进度以单批次方式报告（完成后直接跳到 100%），但 GitHub API 响应速度快，用户感知不到进度跳跃问题。

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/skill/gitcode-skill-source.service.ts` | 修改 | GitCode `listSkillsFromRepo` 中元数据获取改为顺序 `for...of`，逐个报告进度 |
| `src/main/services/skill/github-skill-source.service.ts` | 修改 | GitHub `listSkillsFromRepo` 恢复 `Promise.all` 并行获取，进度批量报告 |
| `src/renderer/stores/skill/skill.store.ts` | 修改 | 新增 `_activeSourceId` 状态，从后端响应中读取 |
| `src/renderer/components/skill/SkillMarket.tsx` | 修改 | 初始化时使用后端的 `activeSourceId` + `fetchGenerationRef` 竞态防护 |

## 影响范围

- [ ] 涉及 API 变更 → 无
- [ ] 涉及数据结构变更 → 无
- [ ] 涉及功能设计变更 → 无（体验优化，核心流程不变）
- [x] 涉及加载性能变更 → GitCode 进度平滑（总加载时间不变）；GitHub 恢复并行速度

## 验收标准

1. **GitCode 进度平滑**（BUG-001）：
   - 选择 GitCode 源后，进度条应逐格推进（每获取一个 skill 更新一次），不再从 0% 跳到 100%
   - 总加载时间不应显著增加

2. **初始激活源一致**（BUG-002）：
   - 将非首位的源（如 GitCode）设为活跃源，刷新页面后，前端 UI 的源选择器应显示 GitCode 为选中状态
   - 后端返回的技能数据应与前端选中的源一致

3. **竞态条件防护**（BUG-002）：
   - 快速连续切换两个不同的市场源，确认最终显示的是最后选择的源的数据，不会被旧请求覆盖

4. **GitHub 加载速度**（BUG-003）：
   - GitHub 源的加载速度应与初始版本一致（并行获取），不应出现顺序执行导致的延迟
   - GitHub 源的进度条可以跳到 100%（单批次报告），因为加载速度快

## 变更
| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-18 | 初始版本：3 个 BUG 的分析和修复方案 | @MoonSeeker |
