# PRD — Bugfix: 同一仓库同一文件夹的技能模型无法识别（disable-model-invocation 导致 SDK 不注入技能列表）

> 版本：v1
> 状态：done
> 日期：2026-05-09
> 指令人：@misakamikoto
> 优先级：P0
> 模块：Agent 核心 / 技能系统

## 问题描述

从同一仓库同一文件夹下载安装的技能（如 ontology-extractor、ontology-reviewer、rule-extractor、rule-reviewer），在 UI 中显示为已启用，本地 skills 文件夹中有完整文件，但模型无法识别这些技能。其他来源的技能（如 ais-bench）正常工作。

## 根因分析

这些技能的 SKILL.md frontmatter 中包含 `disable-model-invocation: true` 字段。这是 Claude Code 的标准 SKILL.md 字段，作用是告诉 SDK 不要自动调用该技能（需要用户显式输入 `/skill-name` 触发）。

但 SDK 对此字段的处理方式是：**不将带有此字段的技能注入系统提示词的可用技能列表**。这意味着模型完全不知道这些技能的存在。

从用户视角来看，这些技能是"已启用"的（META.json.enabled=true），但在技能列表中"隐形"了。

## 技术方案

在 `mergeSkillsDirs` 创建 junction 后，检查技能的 SKILL.md 是否包含 `disable-model-invocation: true`。如果是，则：
1. 删除 junction
2. 创建真实目录（非 junction）
3. 复制源目录所有文件到新目录
4. 写入去除 `disable-model-invocation` 字段的 SKILL.md 副本

这样 SDK 扫描时能发现技能并注入列表，而源目录的 SKILL.md 保持原样不变。

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/main/services/agent/sdk-config.ts` | 修改 | mergeSkillsDirs 中对 disable-model-invocation 技能用目录复制+字段移除 |

## 验收标准

- [x] 同一仓库同一文件夹的技能模型能正常识别
- [x] 源目录 SKILL.md 中 disable-model-invocation 字段不被修改
- [x] 其他技能（无此字段）不受影响，仍使用 junction 方式
- [x] `npm run typecheck` 无新增错误
- [x] `npm run build` 通过
