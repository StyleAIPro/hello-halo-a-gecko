# PRD [Bug 修复级] — 技能市场显示非 Skill 目录

> 版本：bugfix-non-skill-dirs-shown-v1
> 日期：2026-04-24
> 指令人：用户
> 归属模块：modules/skill
> 严重程度：Major（分类目录被误显示为 skill，用户无法区分）
> 所属功能：features/skill-source + features/skill-market
> 状态：done

## 问题描述

- **期望行为**：技能市场只显示包含 `SKILL.md` 的目录作为 skill
- **实际行为**：`AICO-Ascend/Ascend-Skills` 源中 `Operation/`、`Train/` 等分类目录（其子目录才是 skill）也被显示为 skill，名称和描述均为默认值
- **复现步骤**：
  1. 配置 GitCode PAT Token，添加 `AICO-Ascend/Ascend-Skills` 源
  2. 浏览技能列表
  3. 观察到 `Operation`、`Train` 等分类目录出现在列表中，描述为 "Skill from AICO-Ascend/Ascend-Skills"

## 根因分析

### 根因 1：`findSkillDirs` 短路优化将分类目录提升为 skill 候选

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`（L379-423）、`src/main/services/skill/github-skill-source.service.ts`（L386-423）

`findSkillDirs` 的短路优化逻辑：当某个子目录（如 `Inference/ais-bench/`）确认包含 `SKILL.md` 时，将**当前层所有同级目录**提升为 skill 候选。

问题在于该优化在**所有层级**生效：
- 在 `Inference/` 层级提升 `model-compression/`、`gpu-monitor/` 等 → 正确，这些都是 skill
- 在根目录 `/` 层级，`Inference/` 返回非空结果，提升 `Operation/`、`Train/` → **错误**，这些是分类目录，不是 skill

代码注释写 "their SKILL.md will be validated later during metadata fetch"，但实际验证并未过滤无 SKILL.md 的目录（见根因 2）。

### 根因 2：`listSkillsFromRepo` 中 SKILL.md 不存在时仍创建 skill 条目

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`

三处代码存在相同问题：

1. **`listSkillsFromRepo`**（L698）：`fetchSkillFileContent` 返回 `null` 时，代码未跳过该目录，而是使用目录名作为 skill name、默认描述 "Skill from ${repo}" 创建 `RemoteSkillItem` 并推入列表
2. **`listSkillsFromRepoStreaming`**（L795）：同上
3. **`github-skill-source.service.ts` 的 `listSkillsFromRepo`**（L468）：同上（GitHub 端）

```typescript
// L698 — fetchSkillFileContent 返回 null 时未跳过
const content = await fetchSkillFileContent(repo, `${skillPath}/SKILL.md`, token);
if (content) {
  // 解析 frontmatter...
}
// content 为 null 时继续执行，用目录名创建 skill 条目
const skillName = frontmatter.name || name;
const description = frontmatter.description || description || `Skill from ${repo}`;
```

## 技术方案

在 `listSkillsFromRepo` / `listSkillsFromRepoStreaming` 的 metadata 获取循环中，当 `fetchSkillFileContent` 返回 `null`（SKILL.md 不存在）时，**跳过该目录**，不创建 skill 条目。

### `gitcode-skill-source.service.ts` 改动

**`listSkillsFromRepo`**（L697-710）：

```typescript
const content = await fetchSkillFileContent(repo, `${skillPath}/SKILL.md`, token);
if (!content) {
  // 跳过无 SKILL.md 的目录（被 findSkillDirs 短路优化提升的分类目录）
  return null;
}
```

外层将 `null` 结果过滤掉（`skills.push(item)` 改为 `if (item) skills.push(item)`）。

**`listSkillsFromRepoStreaming`**（L794-807）：同上。

### `github-skill-source.service.ts` 改动

**`listSkillsFromRepo`**（L467-480）：同上。`metadataResults` 中的 `null` 已被外层 `if (item)` 过滤，无需额外改动。

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/services/skill/gitcode-skill-source.service.ts` | 修改 | `listSkillsFromRepo` + `listSkillsFromRepoStreaming` 中 SKILL.md 不存在时跳过 |
| `src/main/services/skill/github-skill-source.service.ts` | 修改 | `listSkillsFromRepo` 中 SKILL.md 不存在时跳过 |
| `.project/modules/skill/features/skill-source/changelog.md` | 更新 | 追加变更记录 |
| `.project/modules/skill/features/skill-market/changelog.md` | 更新 | 追加变更记录 |
| `.project/modules/skill/features/skill-market/bugfix.md` | 更新 | 追加 bug 记录 |

## 开发前必读

| 分类 | 文档/文件 | 阅读目的 |
|------|----------|---------|
| 模块文档 | `.project/modules/skill/features/skill-source/changelog.md` | 了解 skill source 最近变更 |
| 模块文档 | `.project/modules/skill/features/skill-market/changelog.md` | 了解 skill market 最近变更 |
| 源码文件 | `src/main/services/skill/gitcode-skill-source.service.ts` | 理解 `findSkillDirs` L379-423 短路优化、`listSkillsFromRepo` L691-739 metadata 获取、`listSkillsFromRepoStreaming` L788-834 |
| 源码文件 | `src/main/services/skill/github-skill-source.service.ts` | 理解 GitHub 端 `findSkillDirs` L386-423、`listSkillsFromRepo` L458-504 |
| 历史PRD | `.project/prd/bugfix/skill/bugfix-skill-scan-category-dir-v1.md` | 了解 findSkillDirs 短路优化的引入背景 |

## 验收标准

- [ ] `AICO-Ascend/Ascend-Skills` 源的技能列表中不包含 `Operation`、`Train` 等分类目录
- [ ] 分类目录下的真实 skill（如 `Operation/xxx`、`Train/yyy`）正常显示
- [ ] 其他源（GitHub、标准 `skills/` 布局的 GitCode 仓库）的 skill 列表不受影响
- [ ] `npm run typecheck && npm run lint && npm run build` 通过

## 变更记录

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-24 | 初始 Bug 修复 PRD | 用户 |
