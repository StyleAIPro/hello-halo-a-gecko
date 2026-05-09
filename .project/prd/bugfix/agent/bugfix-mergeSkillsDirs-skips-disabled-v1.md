# PRD — Bugfix: 启用的技能模型识别不到（mergeSkillsDirs 未过滤 .disabled- 目录）

> 版本：v1
> 状态：done
> 日期：2026-05-09
> 指令人：@misakamikoto
> 优先级：P0
> 模块：Agent 核心 / 技能系统

## 问题描述

部分已启用的技能（如 ontology-reviewer）模型无法识别和调用。技能库中显示为启用状态，但 BOT 不知道这些技能的存在。

## 根因分析

`mergeSkillsDirs` 在扫描源目录时，**不跳过 `.disabled-` 前缀的目录**。`SkillManager.loadSkills()` 已经正确处理了 `.disabled-` 前缀（strip 前缀后加载），但 `mergeSkillsDirs` 直接使用 `entry.name`（含 `.disabled-` 前缀）作为 candidates map 的 key 和 junction 名称。

后果：
1. `.disabled-<name>` 目录被当作名为 `.disabled-<name>` 的技能，创建 junction 到 configSkillsDir
2. configSkillsDir 中同时存在 `<name>` 和 `.disabled-<name>` 两个 junction
3. 这些 `.disabled-` junctions 指向的目录可能已被后续操作删除（变为断链 junction），SDK 扫描时可能因断链报错影响整体技能发现
4. 即使不断链，SDK 也会将 `.disabled-ontology-reviewer` 作为一个独立的"技能"注入系统提示，造成混乱

## 技术方案

在 `mergeSkillsDirs` 中跳过 `.disabled-` 前缀的目录，并在清理阶段删除已有的 `.disabled-` junctions。

### 修改点

**文件：`src/main/services/agent/sdk-config.ts`**

在 `mergeSkillsDirs` 的扫描循环中，跳过 `.disabled-` 前缀的目录：

```typescript
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  if (entry.name.startsWith('.disabled-')) continue;  // 跳过隐藏的禁用技能目录
  // ...existing logic...
}
```

在清理阶段，删除 `.disabled-` 前缀的 junction：

```typescript
for (const entry of existingEntries) {
  if (!entry.isDirectory()) continue;
  if (entry.name.startsWith('.disabled-')) {
    unlinkSync(path.join(targetDir, entry.name));
    continue;
  }
  if (!candidates.has(entry.name)) {
    unlinkSync(path.join(targetDir, entry.name));
  }
}
```

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/main/services/agent/sdk-config.ts` | 修改 | mergeSkillsDirs 跳过 .disabled- 目录 + 清理 .disabled- junctions |

## 开发前必读

| 类型 | 文件 | 阅读目的 |
|------|------|----------|
| 源码文件 | `src/main/services/agent/sdk-config.ts` (L283-356) | 理解 mergeSkillsDirs 扫描和 junction 创建逻辑 |
| 源码文件 | `src/main/services/skill/skill-manager.ts` (L127-132) | 参考 loadSkills 如何处理 .disabled- 前缀 |

## 验收标准

- [x] `mergeSkillsDirs` 不再为 `.disabled-` 目录创建 junction
- [x] 已有的 `.disabled-` junctions 被清理
- [x] 启用的技能模型能正常识别和调用
- [x] `npm run typecheck` 无新增错误
- [x] `npm run build` 通过
