# PRD [Bug 修复级] — GitHub/GitCode 技能推送行为一致性修复

> 版本：bugfix-skill-push-consistency-v1
> 日期：2026-04-18
> 指令人：@MoonSeeker
> 反馈人：@MoonSeeker
> 归属模块：modules/skill
> 严重程度：Major

## 背景

用户向 GitHub 仓库和 GitCode 仓库推送相同内容的技能时，GitCode 显示成功，GitHub 却显示失败。根本原因是两端对异常情况的处理策略不一致：GitCode 采用更宽容的策略（分支回退、部分失败容忍、MR 创建降级），而 GitHub 采用严格策略（硬编码分支名、单文件失败即中止、PR 创建失败即报错）。

这导致用户体验混乱——同一份技能内容，一个平台成功另一个平台失败，用户无法判断是自身操作问题还是平台差异。

## 问题分析

### ISSUE-001：GitHub 分支解析硬编码 `main`，无 `master` 回退

- **文件**：`src/main/services/skill/github-skill-source.service.ts`，`pushSkillAsPR` 函数（约第 763 行）
- **现象**：GitHub 硬编码通过 `gh api /repos/${targetRepo}/git/refs/heads/main` 获取默认分支 SHA，如果仓库使用 `master` 作为默认分支，此调用直接失败
- **对比**：GitCode 先尝试 `main`，失败后回退到 `master`（`gitcode-skill-source.service.ts` 第 883-895 行）

### ISSUE-002：GitHub 文件提交错误为致命错误

- **文件**：`src/main/services/skill/github-skill-source.service.ts`，文件提交循环（约第 780-807 行）
- **现象**：GitHub 在循环提交文件时，任何一个文件提交失败都抛出 Error，整个操作立即中止
- **对比**：GitCode 容忍部分失败，记录错误后继续提交剩余文件，至少一个文件提交成功即返回成功

### ISSUE-003：GitHub PR 创建错误为致命错误

- **文件**：`src/main/services/skill/github-skill-source.service.ts`，PR 创建（约第 810-835 行）
- **现象**：GitHub 如果 PR 创建失败，抛出 Error，操作报告失败
- **对比**：GitCode 如果 MR 创建失败，返回分支 URL 作为降级方案，操作仍报告成功并附带警告信息

### ISSUE-004：Store 层返回值访问方式不一致

- **文件**：`src/renderer/stores/skill/skill.store.ts`
- **GitHub handler**（约第 601-617 行）：检查 `result.data?.prUrl`（仅访问嵌套在 `data` 下的字段）
- **GitCode handler**（约第 619-637 行）：检查 `(result as any)?.mrUrl || (result as any)?.data?.mrUrl`（同时尝试顶级和嵌套路径），且使用了 `as any` 类型断言
- **影响**：不一致的访问模式可能导致 GitHub handler 在返回值结构调整后遗漏 URL

### ISSUE-005：前端展示文案一致性

- **文件**：`src/renderer/components/skill/SkillLibrary.tsx`
- **现象**：GitHub 和 GitCode 推送结果的 UI 文案可能不一致（如一个显示 "PR" 另一个显示 "MR"，或部分文案未走 i18n）
- **影响**：用户体验不统一，增加认知负担

## 解决方案

将 GitHub 推送行为对齐到 GitCode 的宽容策略，确保两个平台对同一份技能内容的推送结果一致。

### 统一行为原则

1. **分支解析宽容**：先尝试 `main`，失败后回退 `master`
2. **文件提交非致命**：单个文件失败不中止，记录错误并继续，至少一个文件成功即视为成功
3. **PR/MR 创建非致命**：创建失败时返回分支 URL 作为降级方案，附带 warning 信息
4. **返回值结构统一**：两端均返回 `{ success, prUrl?, error?, warning? }`，字段名统一为 `prUrl`（不区分 `mrUrl`/`prUrl`）
5. **Store 层统一**：两个 handler 使用相同的返回值访问方式
6. **前端文案统一**：统一使用 "PR" 术语或统一使用 "Pull Request" 术语，确保 i18n 覆盖

## 技术方案

### 1. GitHub 分支解析添加 `master` 回退

**文件**：`src/main/services/skill/github-skill-source.service.ts`

```typescript
// 修改前：仅尝试 main
const { stdout: refData } = await execAsync(
  `"${ghBin}" api /repos/${targetRepo}/git/refs/heads/main --jq ".object.sha"`,
  { timeout: 10_000 },
);

// 修改后：先尝试 main，失败后回退 master
let baseSha: string;
let defaultBranch: string;
try {
  const { stdout: refData } = await execAsync(
    `"${ghBin}" api /repos/${targetRepo}/git/refs/heads/main --jq ".object.sha"`,
    { timeout: 10_000 },
  );
  baseSha = refData.trim();
  defaultBranch = 'main';
} catch {
  const { stdout: refData } = await execAsync(
    `"${ghBin}" api /repos/${targetRepo}/git/refs/heads/master --jq ".object.sha"`,
    { timeout: 10_000 },
  );
  baseSha = refData.trim();
  defaultBranch = 'master';
}
```

### 2. GitHub 文件提交改为非致命

**文件**：`src/main/services/skill/github-skill-source.service.ts`

```typescript
// 修改前：单文件失败即抛错
for (const file of files) {
  await execAsync(...);  // 抛出则整个操作中止
}

// 修改后：记录失败，继续提交
let commitCount = 0;
const fileErrors: string[] = [];
for (const file of files) {
  try {
    await execAsync(...);
    commitCount++;
  } catch (err) {
    fileErrors.push(`${file.path}: ${err.message}`);
  }
}
if (commitCount === 0) {
  throw new Error(`所有文件提交失败: ${fileErrors.join('; ')}`);
}
// 部分失败时附带 warning
const warning = fileErrors.length > 0
  ? `${fileErrors.length} 个文件提交失败: ${fileErrors.join('; ')}`
  : undefined;
```

### 3. GitHub PR 创建改为非致命

**文件**：`src/main/services/skill/github-skill-source.service.ts`

```typescript
// 修改前：PR 创建失败即抛错
const { stdout: prData } = await execAsync(...);
const prUrl = JSON.parse(prData).html_url;

// 修改后：PR 创建失败返回分支 URL
let prUrl: string;
try {
  const { stdout: prData } = await execAsync(...);
  prUrl = JSON.parse(prData).html_url;
} catch (err) {
  // 降级：返回分支 URL
  prUrl = `https://github.com/${targetRepo}/tree/${branchName}`;
  warning = (warning ? warning + '; ' : '') + `PR 创建失败（${err.message}），已创建分支`;
}

return { success: true, prUrl, warning };
```

### 4. 统一返回值结构

**后端**：GitHub 和 GitCode 的 `pushSkillAsPR` 均返回：

```typescript
{
  success: boolean;
  prUrl?: string;   // 统一字段名
  error?: string;
  warning?: string;
}
```

GitCode 侧需将 `mrUrl` 字段名改为 `prUrl`，或在返回前做映射。

### 5. 统一 Store 层访问方式

**文件**：`src/renderer/stores/skill/skill.store.ts`

```typescript
// GitHub handler（修改后，与 GitCode 一致）
const result = await api.skillMarketPushToGitHub(skillId, targetRepo, targetPath);
if (result.success && result.prUrl) {
  set({ pushLoading: false, pushResult: { prUrl: result.prUrl, warning: result.warning } });
  return { success: true, prUrl: result.prUrl };
} else {
  set({ pushLoading: false, pushError: result.error || 'Failed to push skill' });
  return { success: false };
}

// GitCode handler（同步修改）
const result = await api.skillMarketPushToGitCode(skillId, targetRepo, targetPath);
if (result.success && result.prUrl) {
  set({ pushLoading: false, pushResult: { prUrl: result.prUrl, warning: result.warning } });
  return { success: true, prUrl: result.prUrl };
} else {
  set({ pushLoading: false, pushError: result.error || 'Failed to push skill to GitCode' });
  return { success: false };
}
```

移除所有 `as any` 类型断言。

### 6. 前端文案统一

**文件**：`src/renderer/components/skill/SkillLibrary.tsx`

- 检查 GitHub 和 GitCode 推送成功/失败的提示文案，统一使用 i18n key
- 统一术语：推送结果链接统一使用 "PR" 或 "Pull Request"，不混用 "MR"/"Merge Request"
- 新增 i18n key（如需要）：
  - `skill.push.partialFailure` — "部分文件提交失败，请检查仓库"
  - `skill.push.prCreateFailed` — "PR 创建失败，分支已创建，请手动创建 PR"

## 影响范围

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/services/skill/github-skill-source.service.ts` | 逻辑修改 | `pushSkillAsPR`：分支回退 + 文件提交容错 + PR 创建降级 |
| `src/main/services/skill/gitcode-skill-source.service.ts` | 小幅修改 | 返回值字段名 `mrUrl` → `prUrl`（或做映射） |
| `src/renderer/stores/skill/skill.store.ts` | 逻辑修改 | 统一两个 handler 的返回值访问方式，移除 `as any` |
| `src/renderer/components/skill/SkillLibrary.tsx` | 文案修改 | 统一 i18n key 和术语 |
| `src/renderer/i18n/locales/*.json` | 新增 key | 如需新增提示文案 |

## 验收标准

1. **分支回退**：向默认分支为 `master` 的 GitHub 仓库推送技能，操作成功（不再因分支解析失败）
2. **文件提交容错**：GitHub 推送时，即使部分文件提交失败，已成功文件仍保留在分支中，操作返回成功并附带 warning
3. **PR 创建降级**：GitHub PR 创建失败时，返回分支 URL，操作仍报告成功并提示用户手动创建 PR
4. **返回值统一**：GitHub 和 GitCode 推送返回值结构一致（`{ success, prUrl, error, warning }`），Store 层统一使用 `result.prUrl` 访问，无 `as any`
5. **文案统一**：前端推送结果的提示文案已走 i18n，GitHub 和 GitCode 使用相同的术语和语气
6. **无回归**：原有 `main` 分支仓库的推送流程不受影响，正常情况下行为与之前一致
