# 变更记录 -- SDK 会话管理

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-22 | bugfix: buildBaseSdkOptions 新增 additionalDisallowedTools 参数，支持按角色动态禁用 SDK 工具 | @misakamikoto | bugfix-excessive-subagents-v1 |
| 2026-04-23 | bugfix: 远程代理 ChatOptions.isWorkerTask 字段在 streamChat() 中实际生效，Worker 任务不再为内部 SDK 子 Agent 发送多余事件 | @misakamikoto | bugfix-excessive-subagents-v3 |
| 2026-04-17 | BUG-001 修复：`closeSessionsBySpaceId()` 改为 async，新增 `waitForSessionExit()` 通过 PID 轮询等待 SDK 子进程退出，解决 Windows 删除空间 EBUSY 问题 | @zhaoyinqi | bugfix-space-delete-ebusy-v1 |
| 2026-04-16 | 集成统一 SDK Patch：本地启动时执行 `scripts/patch-sdk.mjs`，确保选项转发和消息注入 | @zhaoyinqi | unified-sdk-patch-v1 |
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
| 2026-04-16 | BUG-001 修复：参数对象化重构遗漏 sessionId 引用，改为 options.sessionId | @moonseeker1 | BUG修复 |
