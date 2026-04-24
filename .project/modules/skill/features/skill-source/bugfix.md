# Bug 记录 — 技能源管理

---

## 统计
| 严重程度 | 数量 |
|---------|------|
| Critical | 0 |
| Major | 1 |
| Minor | 0 |

---

## BUG-001: 分类目录结构仓库扫描超时

| 字段 | 内容 |
|------|------|
| 严重程度 | Major |
| 状态 | 已修复 |
| PRD | `.project/prd/bugfix/skill/bugfix-skill-scan-category-dir-v1.md` |
| 修复日期 | 2026-04-22 |

**现象**：添加无 `skills/` 目录的 GitCode 仓库（如 `AICO-Ascend/Ascend-Skills`，使用 `Inference/skill-name/SKILL.md` 分类结构）时，`validateRepo` 和 `listSkillsFromRepo` 递归扫描耗时 60-90 秒，UI 无进度反馈，看起来卡死。

**根因**：`findSkillDirs` 对每个子目录逐一递归检查 SKILL.md（深度 3 层），配合 1s 请求间隔 + 3 并发限制，导致大量 API 调用串行排队。`validateRepo` 调用完整 `listSkillsFromRepo` 进行全量扫描，放大了延迟。

**修复**：
1. `findSkillDirs` 短路优化：检测到首个含 SKILL.md 的子目录后，将该层所有同级目录提升为 skill 候选，跳过剩余递归
2. `validateRepo` 轻量化：改为采样探测（最多 ~7 次 API 调用），从 60-90 秒降至 5-10 秒
3. GitCode/GitHub 双端同步修复
