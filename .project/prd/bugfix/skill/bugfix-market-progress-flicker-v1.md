# Bugfix: 技能市场进度条来回切换 — 后端并发 fetch 未去重 + 进度事件无请求标识

## 元信息

| 字段 | 值 |
|------|-----|
| 级别 | bugfix |
| 状态 | in-progress |
| 指令人 | misakamikoto |
| 创建时间 | 2026-05-08 |
| 优先级 | P2 |
| 影响范围 | 后端（技能市场服务） + 前端（技能市场组件） |

## 问题背景

用户在技能页面点击"技能市场" → 切换到其他 tab → 再切回"技能市场"，加载进度条来回切换/跳动。快速反复切换时尤其明显。

## 根因分析（已确认）

### 根因：后端同一 source 的并发 fetch 未去重，进度事件无请求标识

**完整数据流：**

1. 用户点击"技能市场" → `SkillMarket` 组件挂载 → `loadSkills(1, true)`
2. `loadSkills` → `api.skillMarketList()` → IPC `skill:market:list` → `getSkills()` → `fetchFromGitHubRepo()` / `fetchFromGitCodeRepo()`
3. 后端检查 `skillsCache`，无缓存则开始遍历 repo 拉取技能，通过 `skill:market:fetch-progress` 事件发送进度
4. 前端 `onSkillMarketFetchProgress` 监听器接收进度 → 更新进度条

**问题发生在切换 tab 时：**

1. 用户切到"技能库" tab → `SkillMarket` 卸载，`onSkillMarketFetchProgress` 监听器被移除
2. 但后端 `fetchFromGitHubRepo` 的 async 仍在运行
3. 用户切回"技能市场" → `SkillMarket` **重新挂载**（新实例，所有 ref 重置为初始值）
4. 新实例调用 `loadSkills(1, true)` → 后端收到新请求
5. **此时 `skillsCache` 仍为空**（旧 fetch 未完成），后端启动**第二个**并发的 `fetchFromGitHubRepo`
6. 两个 fetch 都通过 `skill:market:fetch-progress` 广播进度（无 request ID 区分）
7. 新注册的监听器收到**两份不同步的进度事件**（不同 repo、不同计数）→ 进度条来回跳动

**两个关键缺陷：**
- `fetchFromGitHubRepo` / `fetchFromGitCodeRepo` 没有 fetch 去重机制 — 同一 source 可以有多个并发 fetch
- 进度事件 `skill:market:fetch-progress` 不携带请求标识 — 前端无法区分事件来自哪个 fetch

## 修复方案

### 修改 1：后端 fetch 去重（核心修复）

**文件**：`src/main/services/skill/skill-market-service.ts`

新增 `fetchInProgress: Map<string, Promise<RemoteSkillItem[]>>`：
- 每次发起 fetch 前，检查该 source 是否已有 fetch 在进行中
- 如有，直接 `await` 同一个 Promise，不启动新的 fetch
- fetch 完成后（无论成功失败）清除 Map 条目
- `resetCache()` 时同步清理 `fetchInProgress`

### 修改 2：进度事件携带 fetchId（防御性措施）

**文件**：`src/main/services/skill/skill-market-service.ts`

- 新增 `fetchIdCounter` 递增序号和 `createProgressSender(fetchId)` 方法
- 每次 fetch 创建唯一的 `fetchId`，所有进度事件携带 `fetchId`
- 复用 `sendProgress` 闭包改为调用 `createProgressSender` 方法

**文件**：`src/renderer/components/skill/SkillMarket.tsx`

- 新增 `fetchIdRef` 引用
- `loadSkills` 时将 `fetchGenerationRef` 的值同步到 `fetchIdRef`
- `onSkillMarketFetchProgress` 监听器过滤 `progress.fetchId !== fetchIdRef.current` 的事件

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/skill/skill-market-service.ts` | 修改 | 新增 `fetchInProgress` Map + `fetchIdCounter` + `createProgressSender()`；`fetchFromGitHubRepo` / `fetchFromGitCodeRepo` 添加去重逻辑；`resetCache()` 清理 `fetchInProgress` |
| `src/renderer/components/skill/SkillMarket.tsx` | 修改 | 新增 `fetchIdRef`；进度事件监听器添加 fetchId 过滤；`loadSkills` 同步 fetchId |

## 验收标准

### 核心功能

- [ ] 打开技能市场 → 等进度条出现 → 切换到技能库 → 切回技能市场 → 进度条不再来回跳动
- [ ] 快速反复切换 tab 多次 → 无进度条异常
- [ ] 搜索技能时切换 tab 再切回 → 搜索结果正常显示，进度条不异常

### 回归验证

- [ ] 首次进入技能市场正常加载技能列表
- [ ] 切换技能源后正常加载
- [ ] 搜索功能正常
- [ ] `npm run build` 通过

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 源码文件 | `src/main/services/skill/skill-market-service.ts` | 理解 `fetchFromGitHubRepo` / `fetchFromGitCodeRepo` 的缓存检查、`sendProgress` 闭包、以及缺少去重的问题 |
| 源码文件 | `src/renderer/components/skill/SkillMarket.tsx` | 理解 `loadSkills` 的 generation counter、`onSkillMarketFetchProgress` 监听器的注册/清理、组件挂载/卸载生命周期 |
| 源码文件 | `src/renderer/pages/skill/SkillPage.tsx` | 理解 SkillMarket 的条件渲染（`!marketLoading && currentView === 'market'`）导致卸载/重新挂载 |
