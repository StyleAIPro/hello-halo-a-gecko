# PRD — Bugfix: Skill 禁用后无法启用（v4 回归）

> 版本：v1
> 状态：done
> 日期：2026-05-09
> 指令人：@misakamikoto
> 优先级：P0
> 模块：技能系统

## 问题描述

v4 修复（`hideDisabledSkillsInSource`）引入回归：Skill 禁用后目录被重命名为 `.disabled-<name>`，但重新启用时 `toggleSkill` 仍用原路径 `path.join(baseDir, skillId)` 拼接目录，路径不存在导致 `writeFile` 抛出 ENOENT，toggle 返回 false。

## 技术方案

在 `skill-manager.ts` 的 `toggleSkill` 中，计算 `skillDir` 后检查目录是否存在。若不存在，尝试 `.disabled-<name>` 路径。

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/main/services/skill/skill-manager.ts` | 修改 | toggleSkill 中回退到 .disabled- 路径；添加 existsSync 导入 |

## 验收标准

- [ ] 禁用 Skill 后重新启用，技能恢复正常
- [ ] 禁用 → 启用 → 再禁用 循环操作正常
- [ ] `npm run typecheck` 无新增错误
