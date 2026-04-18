# 变更记录 — 技能市场

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
| 2026-04-18 | 修复 GitCode 技能获取全面失败（rate limiter、超时、错误传播、代理缓存） | @MoonSeeker | BUG-001 |
| 2026-04-18 | 添加 asyncPool 并发控制，Promise.all 改为批次加载（并发上限 3） | @MoonSeeker | BUG-001 |
| 2026-04-18 | 综合修复 7 项问题（进度报告、死代码、preload 重复、skills.sh master 回退、GitCode validateRepo、参数透传 bug、竞态条件） | @MoonSeeker | bugfix-skill-market-cleanup-v1 |
| 2026-04-18 | UX 精修：GitCode 顺序获取进度均匀、前端源选择同步后端、GitHub 恢复并行获取 | @MoonSeeker | bugfix-skill-market-ux-v1 |
| 2026-04-18 | 平台隔离：`githubRepo`/`githubPath` → `remoteRepo`/`remotePath`、Push 流程平台校验、i18n 修复、Controller 返回值统一 | @MoonSeeker | refactor-skill-market-platform-isolation-v1 |
| 2026-04-18 | Bug 修复：Push 按钮文案动态化 + 同名仓库 select value 唯一性修复 + SkillDetail prop 传递修复 | @MoonSeeker | bugfix-skill-push-ui-and-repo-routing-v1 |
