# 变更记录 -- 流式响应处理

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-21 | 修复 streamChat finally 块误报子 Agent "Stream interrupted"：正常完成时静默清理未完成子 Agent，仅在用户中断时发送失败事件 — `packages/remote-agent-proxy/src/claude-manager.ts` — PRD: `prd/bugfix/agent/bugfix-remote-duplicate-subagent-v1` | @misakamikoto | bugfix-remote-duplicate-subagent-v1 |
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
| 2026-04-17 | BUG-002：SDK turn injection patch 守卫条件错误导致第二次消息卡死（`send()` 中 `firstResultReceived` → `_continueAfterResult`） — `src/main/services/agent/sdk-turn-injection-patch.ts` | @zhaoyinqi | bugfix-second-message-stuck-v1 |
| 2026-04-16 | BUG-001：移除 control.ts drain 循环防止 stream 消息竞争，增加前端 stopGeneration 10 秒安全超时 — `src/main/services/agent/control.ts`、`src/renderer/stores/chat.store.ts` | @zhaoyinqi | BUG修复 |
| 2026-04-16 | 重构：queueInjection 参数封装为 QueueInjectionOptions 对象，更新 stream-processor、ipc/agent、orchestrator 全部调用方 | @moonseeker1 | 代码审计 |
