# PRD — Bugfix: 技能库显示数量与本地目录数量不一致（残留 .disabled- 目录导致去重）

> 版本：v1
> 状态：done
> 日期：2026-05-09
> 指令人：@misakamikoto
> 优先级：P1
> 模块：技能系统

## 问题描述

技能库页面显示的已安装技能数量（如 20）少于本地 `~/.agents/skills/` 中的目录数量（如 22）。用户滚动到底部后确认部分技能未被显示。

## 根因分析

v4 引入的 `hideDisabledSkillsInSource` 在禁用技能时将目录重命名为 `.disabled-<name>`，启用时重命名回来。但存在以下场景会产生残留的 `.disabled-` 目录：

1. 用户禁用技能 A → 目录变为 `.disabled-A`
2. 用户重新安装技能 A（或从其他来源同步）→ 创建新的 `A` 目录
3. 此时 `.disabled-A` 和 `A` 同时存在

`loadSkills` 按 `skillId` 去重（取 mtime 最新），最终只保留一个。但残留的 `.disabled-` 目录占用了文件系统空间，且导致目录数与技能数不一致。

此外，`hideDisabledSkillsInSource` 在恢复 `.disabled-<name>` 时检查 `if (!existsSync(restoredPath))`，发现目标已存在后跳过，残留目录永远不会被清理。

## 技术方案

在 `skill-manager.ts` 的 `loadSkills` 中，加载完所有候选技能后，检查是否存在残留的 `.disabled-` 目录。对于每个已加载的技能，如果其对应 `.disabled-` 目录也存在于同一 `skillsDir` 中，删除残留的 `.disabled-` 目录。

```typescript
// 在 loadSkills 的 candidates 写入缓存之后
for (const [skillId, candidate] of candidates) {
  // 清理残留的 .disabled- 目录
  for (const skillsDir of this.skillsDirs) {
    const staleDir = path.join(skillsDir, `.disabled-${skillId}`);
    if (existsSync(staleDir)) {
      fs.rm(staleDir, { recursive: true, force: true })
        .catch(() => {});
    }
  }
  // ...existing code...
}
```

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/main/services/skill/skill-manager.ts` | 修改 | loadSkills 中清理残留 .disabled- 目录 |

## 开发前必读

| 类型 | 文件 | 阅读目的 |
|------|------|----------|
| 源码文件 | `src/main/services/skill/skill-manager.ts` (L113-186) | 理解 loadSkills 加载和去重逻辑 |
| 源码文件 | `src/main/services/agent/sdk-config.ts` (L447-491) | 理解 hideDisabledSkillsInSource 重命名逻辑 |

## 验收标准

- [x] 技能库显示的技能数量与本地唯一技能数量一致
- [x] 残留的 `.disabled-` 目录在 loadSkills 时被自动清理
- [x] 正常的 `.disabled-` 目录（对应已禁用技能）不受影响
- [x] `npm run typecheck` 无新增错误
- [x] `npm run build` 通过
