# PRD [Bug 修复级] — Push 按钮文案 + 同名仓库 MR 路由错误

> 版本：bugfix-skill-push-ui-and-repo-routing-v1
> 日期：2026-04-18
> 指令人：@MoonSeeker
> 归属模块：modules/skill
> 严重程度：Major

## 问题描述

### BUG-001：Push 按钮始终显示 "Push to GitHub"
- **实际行为**：无论源是 GitHub 还是 GitCode，触发按钮始终显示 "Push to GitHub"
- **期望行为**：GitCode 源显示 "Push to GitCode"，多源时显示通用文案

### BUG-002：同名仓库 MR 路由错误
- **实际行为**：`<select>` 的 `value` 使用 `s.repos?.[0]`（如 `owner/repo`），GitHub 和 GitCode 如果有相同的 `owner/repo`，两个 option 的 value 重复。`find()` 匹配到第一个，导致 GitCode 仓库被当作 GitHub 处理（调用 `pushSkillAsPR` 而非 `pushSkillAsMR`）
- **期望行为**：每个源有唯一的选中状态，即使仓库名相同也能正确路由到对应平台

### BUG-003：SkillDetail 子组件引用未定义变量
- **实际行为**：`SkillDetail` 组件内直接引用父组件的 `githubSources` 变量，运行时报 `ReferenceError`
- **根因**：`githubSources` 未作为 prop 传递给 `SkillDetail`

## 修复方案

### 修复 BUG-001：按钮文案动态化
触发按钮根据 `githubSources` 数量和类型：
- 仅 1 个源且为 GitCode → "Push to GitCode"
- 仅 1 个源且为 GitHub → "Push to GitHub"
- 多个源 → "Push to Remote"

### 修复 BUG-002：使用 sourceId 作为 select value
1. 新增 `pushTargetSourceId` 状态
2. `<select value>` 改用 `s.id`（每个源唯一），显示时加前缀 `GitHub:` / `GitCode:`
3. 所有 `githubSources.find(s => s.repos?.[0] === pushTargetRepo)` 替换为 `pushTargetSource` 变量
4. 新增 `isGitCodePush` 派生变量简化条件判断

### 修复 BUG-003：传递 githubSourcesList prop
1. `SkillDetail` props 新增 `githubSourcesList?: SkillMarketSource[]`
2. 父组件传递 `githubSourcesList={githubSources}`
3. 按钮文案使用 `githubSourcesList` 而非 `githubSources`

## 影响文件

- `src/renderer/components/skill/SkillLibrary.tsx`

## 验证

1. 仅配置 GitHub 源时，按钮显示 "Push to GitHub"
2. 仅配置 GitCode 源时，按钮显示 "Push to GitCode"
3. 同时配置同名 GitHub + GitCode 仓库，下拉框显示 "GitHub: owner/repo" 和 "GitCode: owner/repo"，选择 GitCode 后正确调用 `pushSkillAsMR`
4. 页面无 ReferenceError

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-18 | 初始版本 | @MoonSeeker |
