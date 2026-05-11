# PRD — Bugfix: 安装/卸载技能后模型无法识别新增或移除的技能

> 版本：v1
> 状态：done
> 日期：2026-05-09
> 指令人：@misakamikoto
> 优先级：P0
> 模块：Agent 核心 / 技能系统

## 问题描述

技能安装、导入（YAML）、卸载后，UI 中技能列表已更新，但模型（BOT）无法识别新安装的技能或仍在使用已卸载技能的旧缓存。

## 根因分析

`toggleSkill` 在切换后正确调用了 `refreshSkillDirectories()` + `clearSessionId()` + `invalidateAllSessions()` 三件套，但其他技能变更操作缺失：

| 操作 | `refreshSkillDirectories()` | `invalidateAllSessions()` | `clearSessionId()` |
|------|:---:|:---:|:---:|
| `toggleSkill` | ✅ | ✅ | ✅ |
| `installSkillFromMarket` (npx) | ❌ | ❌ | ❌ |
| `installSkillFromMarketWithInfo` (npx) | ❌ | ❌ | ❌ |
| `installSkillFromSource` (GitHub/GitCode) | ❌ | ❌ | ❌ |
| `installSkillFromYaml` | ❌ | ❌ | ❌ |
| `uninstallSkill` | ❌ | ❌ | ❌ |
| `installSkillMultiTarget` (local 部分) | ❌ | ❌ | ❌ |

后果：
1. `configSkillsDir` 中的 junctions 未更新 → SDK 子进程看不到新技能
2. 已有 SDK 会话未被失效 → 模型继续使用旧的技能列表

## 技术方案

提取 `toggleSkill` 中的三件套为公共函数 `syncSkillStateToSdk()`，在所有技能变更操作成功后调用。

### 新增函数

在 `skill.controller.ts` 中新增：

```typescript
async function syncSkillStateToSdk(): Promise<void> {
  refreshSkillDirectories();
  for (const info of Array.from(v2Sessions.values())) {
    clearSessionId(info.spaceId, info.conversationId);
  }
  invalidateAllSessions();
}
```

### 修改点

在以下函数的成功路径末尾添加 `syncSkillStateToSdk()` 调用：
1. `installSkillFromSource` — L239 `return { success: true }` 之前
2. `installSkillFromYaml` — L584 `return { success: true, skillId }` 之前
3. `uninstallSkill` — L596 成功分支

对于 `installSkillFromMarket` 和 `installSkillFromMarketWithInfo`，它们的安装路径最终都调用 `installSkillFromSource`，因此不需要额外修改（`installSkillFromSource` 覆盖）。但 npx 成功路径（L393-401）直接 return 而不经过 `installSkillFromSource`，需要在 L401 前添加调用。

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/main/controllers/skill.controller.ts` | 修改 | 提取 syncSkillStateToSdk 并在安装/卸载成功后调用 |

## 开发前必读

| 类型 | 文件 | 阅读目的 |
|------|------|----------|
| 源码文件 | `src/main/controllers/skill.controller.ts` (L881-893) | 理解 toggleSkill 三件套逻辑 |
| 源码文件 | `src/main/controllers/skill.controller.ts` (L80-245) | installSkillFromSource 成功路径 |
| 源码文件 | `src/main/controllers/skill.controller.ts` (L389-401) | installSkillFromMarket npx 成功路径 |
| 源码文件 | `src/main/controllers/skill.controller.ts` (L579-591) | installSkillFromYaml |
| 源码文件 | `src/main/controllers/skill.controller.ts` (L593-603) | uninstallSkill |

## 验收标准

- [x] 从市场安装技能后，新对话中模型能识别该技能
- [x] 从 YAML 导入技能后，新对话中模型能识别该技能
- [x] 卸载技能后，新对话中模型不再识别该技能
- [x] 已有对话发送新消息时，SDK 会话被重建并使用最新技能列表
- [x] `npm run typecheck` 无新增错误
- [x] `npm run build` 通过
