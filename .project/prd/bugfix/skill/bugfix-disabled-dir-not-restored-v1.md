# PRD — Bugfix: 启用的技能模型识别不到（.disabled- 目录未被恢复为正常目录名）

> 版本：v1
> 状态：done
> 日期：2026-05-09
> 指令人：@misakamikoto
> 优先级：P0
> 模块：技能系统

## 问题描述

部分已启用的技能模型无法识别。技能库 UI 显示为启用状态，本地 skills 目录中也有对应文件（以 `.disabled-<name>` 形式存在），但模型看不到这些技能。

## 根因分析

v4 引入的 `hideDisabledSkillsInSource` 在禁用技能时将目录重命名为 `.disabled-<name>`。但启用技能时，恢复逻辑（在 `hideDisabledSkillsInSource` 中）仅在 `toggleSkill` → `refreshSkillDirectories` 流程中执行。以下场景导致 `.disabled-` 目录未被恢复：

1. 用户通过 UI 启用技能 → `toggleSkill` 写 META.json(enabled:true) → `refreshSkillDirectories` → `hideDisabledSkillsInSource` 检测到 `.disabled-` 目录中 META.json.enabled !== false → 尝试 `renameSync` 恢复 → 但如果 `ontology-reviewer` 已存在（被重新安装），`existsSync(restoredPath)` 为 true → 跳过恢复
2. 用户通过其他方式（如直接操作 CLI）启用了技能 → `.disabled-` 目录的 META.json 被修改为 enabled:true → 但 `hideDisabledSkillsInSource` 从未被调用 → 目录名保持 `.disabled-` 状态

`.disabled-` 目录中的技能虽然被 `SkillManager.loadSkills()` 正确识别（它 strip 了 `.disabled-` 前缀），但 `mergeSkillsDirs` 在上一个修复中被改为跳过 `.disabled-` 前缀目录。因此 `configSkillsDir` 中不会为这些技能创建 junction，SDK 看不到它们。

之前 `loadSkills` 的清理逻辑发现 enabled 技能有残留 `.disabled-` 目录时会**删除**它——但这是错误的，因为 `.disabled-` 目录可能是该技能的唯一存在形式，删除后技能彻底丢失。

## 技术方案

修改 `skill-manager.ts` 的 `loadSkills` 中对 `.disabled-` 目录的处理逻辑：

- 如果技能 enabled 且只有 `.disabled-` 目录（正常目录不存在）→ **重命名恢复**（`fs.rename`）
- 如果技能 enabled 且 `.disabled-` 和正常目录都存在 → 删除残留 `.disabled-` 目录

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/main/services/skill/skill-manager.ts` | 修改 | loadSkills 中 .disabled- 目录恢复逻辑（rename 代替 rm） |

## 验收标准

- [ ] 应用启动时，META.json 中 enabled:true 的 `.disabled-` 目录被自动恢复为正常目录名
- [ ] 恢复后 `mergeSkillsDirs` 能为这些技能创建 junction
- [ ] 模型能识别并调用这些技能
- [ ] 同时存在 `.disabled-` 和正常目录时，残留 `.disabled-` 目录被清理
- [ ] `npm run typecheck` 无新增错误
- [ ] `npm run build` 通过
