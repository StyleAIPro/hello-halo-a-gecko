# 变更记录 -- SDK 会话管理

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-17 | BUG-001 修复：`closeSessionsBySpaceId()` 改为 async，新增 `waitForSessionExit()` 通过 PID 轮询等待 SDK 子进程退出，解决 Windows 删除空间 EBUSY 问题 | @zhaoyinqi | bugfix-space-delete-ebusy-v1 |
| 2026-04-16 | 集成统一 SDK Patch：本地启动时执行 `scripts/patch-sdk.mjs`，确保选项转发和消息注入 | @zhaoyinqi | unified-sdk-patch-v1 |
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
| 2026-04-16 | BUG-001 修复：参数对象化重构遗漏 sessionId 引用，改为 options.sessionId | @moonseeker1 | BUG修复 |
