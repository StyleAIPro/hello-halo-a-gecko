# 变更记录 — 技能源管理

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-24 | findSkillDirectoryPath fallback 递归扫描 maxDepth 降至 2 + 15s 超时 + 诊断日志 | 用户 | bugfix-skill-install-hang-v1 |
| 2026-04-22 | findSkillDirs 短路优化：检测到 SKILL.md 时将同级目录批量提升为候选 skill，减少递归 API 调用；validateRepo 改为轻量采样探测，避免完整扫描 | @moonseeker1 | bugfix-skill-scan-category-dir-v1 |
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
