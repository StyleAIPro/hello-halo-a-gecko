# PRD — Bugfix: 禁用技能仍被模型识别（mergeSkillsDirs 清理逻辑在 Windows 上完全失效）

> 版本：v1
> 状态：done
> 日期：2026-05-09
> 指令人：@misakamikoto
> 优先级：P0
> 模块：Agent 核心 / 技能系统

## 问题描述

技能禁用后，模型仍然能识别并看到这些技能。之前的修复（v1-v5 + mergeSkillsDirs 跳过 .disabled- 目录）均未彻底解决。

## 根因分析

`mergeSkillsDirs` 的清理阶段遍历 `configSkillsDir` 时，使用 `entry.isDirectory()` 判断条目类型：

```typescript
for (const entry of existingEntries) {
  if (!entry.isDirectory()) continue;  // ← BUG
  // ... cleanup logic (remove stale .disabled- junctions, etc.)
}
```

在 Windows 上，`readdirSync` 将 **junctions 报告为 symbolic links**（`isDirectory() === false, isSymbolicLink() === true`），而非 directories。因此 `!entry.isDirectory()` 对所有 junctions 返回 true，清理逻辑被完全跳过——`.disabled-` junctions 和过期 junctions 永远不会被删除。

注意：扫描阶段（L292）在 **source 目录**（`~/.agents/skills/`）上运行，其中的条目是真实目录，`isDirectory()` 正常返回 true。只有清理阶段（在 target 目录 `configSkillsDir` 上运行）受此 bug 影响。

## 技术方案

将清理阶段的目录检查从 `!entry.isDirectory()` 改为 `!entry.isDirectory() && !entry.isSymbolicLink()`，确保 Windows 上的 junctions（被报告为 symbolic links）也能被清理。

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/main/services/agent/sdk-config.ts` | 修改 | mergeSkillsDirs 清理阶段兼容 Windows junctions |

## 验收标准

- [x] 禁用技能后，configSkillsDir 中对应的 junction 被清理
- [x] .disabled- 前缀的 junction 被清理
- [x] 模型不再识别已禁用的技能
- [x] `npm run typecheck` 无新增错误
- [x] `npm run build` 通过
