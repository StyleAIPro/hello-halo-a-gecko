# PRD — Bugfix: 部分已安装 Skill 未在技能库中显示（YAML frontmatter 解析失败静默跳过）

> 版本：v1
> 状态：done
> 日期：2026-05-09
> 指令人：@misakamikoto
> 优先级：P1
> 模块：技能系统

## 问题描述

技能库页面显示的已安装技能数量少于本地实际数量。部分 AICO-Bot 安装的技能未被显示。

## 根因分析

`skill-manager.ts` 的 `parseSkillMd` 解析 `SKILL.md` 的 YAML frontmatter 时，如果 frontmatter 内容包含 YAML 不兼容的语法（如嵌套映射中含冒号、flow sequence 中含非法字符），`parseYaml` 会抛出异常。`parseSkillMd` 的 `catch` 块直接 `return null`，导致 `loadSkillFromDir` 返回 `null`，`loadSkills` 静默跳过该技能。

实测 `~/.agents/skills/` 中有 23 个技能目录，其中 2 个因 YAML 解析失败被跳过：
- `ascendc-operator-code-gen`：frontmatter description 字段含 `TRIGGER when:` 导致 "Nested mappings are not allowed"
- `op-profiling`：frontmatter input 字段含括号注释 `(可选)` 导致 flow sequence 解析失败

## 技术方案

在 `parseSkillMd` 中，当 YAML frontmatter 解析失败时，不返回 `null`，而是回退到与「无 frontmatter」相同的处理逻辑：将整个内容作为 `system_prompt`，使用 `skillId` 作为默认 name。

修改 `parseSkillMd` 的 `catch` 块：

```typescript
} catch {
  // YAML frontmatter 存在但解析失败，回退到默认值（与无 frontmatter 相同）
  return {
    name: skillId,
    type: 'skill',
    description: `Skill: ${skillId}`,
    system_prompt: content,
    version: '1.0',
    author: 'Unknown',
    trigger_command: `/${skillId}`,
  };
}
```

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/main/services/skill/skill-manager.ts` | 修改 | parseSkillMd catch 块回退到默认值而非返回 null |

## 开发前必读

| 类型 | 文件 | 阅读目的 |
|------|------|----------|
| 源码文件 | `src/main/services/skill/skill-manager.ts` (L247-280) | 理解 parseSkillMd 当前逻辑 |
| 源码文件 | `src/main/services/skill/skill-manager.ts` (L193-241) | 理解 loadSkillFromDir 调用链 |

## 验收标准

- [x] 之前因 YAML 解析失败而未显示的技能现在正常显示在技能库中
- [x] 技能库显示的技能数量与本地 `~/.agents/skills/` 中的技能目录数量一致
- [x] `npm run typecheck` 无新增错误
- [x] `npm run build` 通过
