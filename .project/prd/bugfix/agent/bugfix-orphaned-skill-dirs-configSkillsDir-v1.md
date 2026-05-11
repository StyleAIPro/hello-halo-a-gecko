# PRD — Bugfix: configSkillsDir 中残留孤儿目录导致已禁用技能仍被模型识别

> 版本：v1
> 状态：done
> 日期：2026-05-09
> 指令人：@misakamikoto
> 优先级：P0
> 模块：Agent 核心 / 技能系统

## 问题描述

已禁用的技能模型仍然能识别。共性：这些技能都从同一仓库同一文件夹下载安装。

## 根因分析

`mergeSkillsDirs` 的清理阶段使用 `unlinkSync` 删除过期条目：

```typescript
const targetPath = path.join(targetDir, entry.name);
try { unlinkSync(targetPath); } catch {}
```

`unlinkSync` 只能删除文件和符号链接/junction，**不能删除真实目录**。

之前的 `disable-model-invocation` 修复（已被回退）会将 junction 替换为**真实目录**（复制源文件 + 去除字段）。代码回退后，这些真实目录残留在了 `configSkillsDir`（`~/.agents/claude-config/skills/`）中。

后续 `mergeSkillsDirs` 运行时：
1. 扫描源目录：`.disabled-ontology-extractor` 被跳过（`.disabled-` 前缀）
2. 清理阶段：发现 `ontology-extractor` 在 `configSkillsDir` 中存在但不在 candidates 中
3. 尝试 `unlinkSync` 删除 → **静默失败**（是真实目录，不是 junction）
4. 孤儿目录永久残留，SDK 扫描时正常发现并注入这些技能

## 技术方案

修改 `mergeSkillsDirs` 清理阶段的删除逻辑：

- 先 `lstatSync` 判断条目是否为符号链接
- 符号链接（junction）→ `unlinkSync`
- 真实目录 → `rmSync(path, { recursive: true, force: true })`

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/main/services/agent/sdk-config.ts` | 修改 | mergeSkillsDirs 清理阶段区分 junction 和真实目录 |

## 验收标准

- [x] configSkillsDir 中残留的真实目录被正确清理
- [x] 禁用技能后模型不再识别这些技能
- [x] 正常 junction 类型的技能不受影响
- [x] `npm run typecheck` 无新增错误
- [x] `npm run build` 通过
