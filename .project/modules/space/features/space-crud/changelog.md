# 变更记录 — space-crud

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-16 | 初始设计：Space CRUD 全生命周期管理 | @moonseeker1 | 新功能 |
| 2026-04-17 | BUG-001 修复：Windows 删除空间 EBUSY 错误 — 增加重试次数和退避延迟（500ms/1s/2s），配合 session-manager 异步等待子进程退出 | @zhaoyinqi | BUG修复 |
