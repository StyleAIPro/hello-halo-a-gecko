# 变更记录 — AI 源管理器

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
| 2026-04-16 | 重构：提取 useAISources hook | @moonseeker1 | 代码审计 |
| 2026-04-16 | 修复：useAISources 改用 updateConfig 避免主题重置 | @moonseeker1 | bugfix-theme-reset-on-config-update-v1 |
| 2026-05-10 | 新增：每个 AI 源独立的网络代理开关 (useProxy)，控制是否走全局代理 | @moonseeker | ai-source-proxy-toggle-v1 |
