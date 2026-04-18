# PRD [重构级] — 技能市场 GitHub/GitCode 平台隔离

> 版本：refactor-skill-market-platform-isolation-v1
> 日期：2026-04-18
> 指令人：@MoonSeeker
> 归属模块：modules/skill
> 严重程度：Major

## 背景

当前技能市场的代码架构没有将 GitHub 和 GitCode 作为独立平台隔离，导致多处逻辑混淆、功能缺陷和用户体验问题：

1. 共享类型 `RemoteSkillItem` 使用 `githubRepo`/`githubPath` 字段名存储所有平台数据，GitCode 和 skills.sh 源也使用这些字段，语义不清
2. Push 流程不校验目标平台，`loadRepoDirectories` 始终调用 GitHub API，GitCode 源无法加载目录列表
3. 前端文案硬编码英文，"View on GitHub" 对 GitCode 源也显示 GitHub
4. Controller 返回值不一致，GitHub 返回 `prUrl`，GitCode 返回 `mrUrl`

## 问题分析

### ISSUE-001：类型字段命名不区分平台

**文件**：`src/shared/skill/skill-types.ts`

`RemoteSkillItem` 接口的 `githubRepo`/`githubPath` 字段被 GitHub、GitCode、skills.sh 三种源共用，整个代码库 30+ 处引用，语义混淆，扩展性差。

**涉及文件**：
- `src/main/services/skill/github-skill-source.service.ts`（6 处）
- `src/main/services/skill/gitcode-skill-source.service.ts`（6 处）
- `src/main/services/skill/skill-market-service.ts`（18 处）
- `src/main/controllers/skill.controller.ts`
- `src/renderer/components/skill/SkillMarket.tsx`

### ISSUE-002：Push 流程缺少平台校验

**文件**：`src/renderer/components/skill/SkillLibrary.tsx`、`src/renderer/stores/skill/skill.store.ts`、`src/renderer/api/index.ts`

- `loadRepoDirectories` 始终调用 GitHub API，GitCode 源的目录列表无法加载
- IPC handler 和 preload 层已有 `skill:market:list-gitcode-repo-dirs` 通道，但 renderer API 层未暴露
- Push 按钮始终显示 "Create PR"，GitCode 应显示 "Create MR"
- 描述文案始终说 "Pull Request"，GitCode 应说 "Merge Request"

### ISSUE-003：前端硬编码英文

**文件**：`src/renderer/components/skill/SkillMarket.tsx`、`src/renderer/components/skill/SkillLibrary.tsx`

多处用户可见字符串未使用 `t()` 国际化函数，违反项目「禁止硬编码文本」规范。

### ISSUE-004：Controller 返回值不一致

**文件**：`src/main/controllers/skill.controller.ts`

`pushSkillToGitCode` 返回 `{ success: true, mrUrl: '...' }`，`pushSkillToGitHub` 返回 `{ success: true, prUrl: '...' }`。Store 层已统一为 `prUrl` 读取，但 controller 层字段名不一致。

## 解决方案

### 修复 ISSUE-001：重命名为平台中性字段

`githubRepo` → `remoteRepo`，`githubPath` → `remotePath`，全局 `replace_all` 替换。

### 修复 ISSUE-002：Push 流程平台路由

1. renderer API 层添加 `skillMarketListGitCodeRepoDirs(repo)`
2. Store 层添加 `loadGitCodeRepoDirectories(repo)`
3. SkillLibrary 中根据 source type 路由到正确的目录列表 API
4. Push 按钮/描述文案根据 source type 动态显示 PR/MR

### 修复 ISSUE-003：i18n 覆盖

- SkillMarket 硬编码字符串包裹 `t()`
- "View on GitHub" 改为根据 `sourceId` 条件显示 "View on GitHub" / "View on GitCode"

### 修复 ISSUE-004：统一 Controller 返回值

`pushSkillToGitCode` 返回值中 `mrUrl` → `prUrl`，Store 层同步更新。

## 改动文件清单

| # | 文件 | ISSUE | 说明 |
|---|------|-------|------|
| 1 | `src/shared/skill/skill-types.ts` | 001 | 字段重命名 |
| 2 | `src/main/services/skill/github-skill-source.service.ts` | 001 | 6 处引用更新 |
| 3 | `src/main/services/skill/gitcode-skill-source.service.ts` | 001 | 6 处引用更新 |
| 4 | `src/main/services/skill/skill-market-service.ts` | 001 | 18 处引用更新 |
| 5 | `src/main/controllers/skill.controller.ts` | 001, 004 | 字段重命名 + 返回值统一 |
| 6 | `src/renderer/components/skill/SkillMarket.tsx` | 001, 003 | 字段引用 + i18n |
| 7 | `src/renderer/api/index.ts` | 002 | 新增 `skillMarketListGitCodeRepoDirs` |
| 8 | `src/renderer/stores/skill/skill.store.ts` | 002 | 新增 `loadGitCodeRepoDirectories` |
| 9 | `src/renderer/components/skill/SkillLibrary.tsx` | 002, 003 | 平台路由 + 文案动态化 |
| 10 | `src/main/services/remote-deploy/remote-deploy.service.ts` | 001 | 参数名 `githubRepo` → `remoteRepo` |

## 影响范围

- [x] 涉及类型变更 → `RemoteSkillItem` 字段重命名
- [ ] 涉及 IPC 通道新增 → 无（已存在，仅 renderer 层补齐）
- [ ] 涉及功能设计变更 → 无（行为逻辑不变，仅路由和文案适配）
- [x] 涉及 i18n → 新增 key 需翻译

## 验收标准

1. `npm run typecheck` 通过，`RemoteSkillItem` 使用 `remoteRepo`/`remotePath`
2. GitCode 源 Push 模态框中目录列表能正常加载
3. Push 文案：GitHub 显示 "Create PR"，GitCode 显示 "Create MR"
4. "View on" 链接：GitHub 源显示 "View on GitHub"，GitCode 源显示 "View on GitCode"
5. GitHub 和 GitCode push 均返回 `{ success, prUrl }`

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-18 | 初始版本 | @MoonSeeker |
