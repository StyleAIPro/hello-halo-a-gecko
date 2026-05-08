# 变更记录 -- 流式响应处理

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-22 | bugfix: Worker 内部 SDK 子 agent 不再发送 worker:started/completed 事件到前端，避免产生多余 Worker Tab（task_started/task_notification 处理增加 workerTag 判断） | @misakamikoto | bugfix-excessive-subagents-v2 |
| 2026-04-29 | extractNetworkErrorHint 网络错误消息更新：引导到应用内"设置 > 网络"配置代理 | 用户 | bugfix-intranet-proxy-guidance-v1 |
| 2026-04-23 | bugfix: 远程代理 streamChat() 接入 isWorkerTask 过滤，Worker 内部子 Agent 的 worker:started/completed 不再发送到前端，与本地模式 v2 修复对齐 | @misakamikoto | bugfix-excessive-subagents-v3 |
| 2026-04-21 | 修复 streamChat finally 块误报子 Agent "Stream interrupted"：正常完成时静默清理未完成子 Agent，仅在用户中断时发送失败事件 — `packages/remote-agent-proxy/src/claude-manager.ts` — PRD: `prd/bugfix/agent/bugfix-remote-duplicate-subagent-v1` | @misakamikoto | bugfix-remote-duplicate-subagent-v1 |
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
| 2026-04-17 | BUG-002：SDK turn injection patch 守卫条件错误导致第二次消息卡死（`send()` 中 `firstResultReceived` → `_continueAfterResult`） — `src/main/services/agent/sdk-turn-injection-patch.ts` | @zhaoyinqi | bugfix-second-message-stuck-v1 |
| 2026-04-16 | BUG-001：移除 control.ts drain 循环防止 stream 消息竞争，增加前端 stopGeneration 10 秒安全超时 — `src/main/services/agent/control.ts`、`src/renderer/stores/chat.store.ts` | @zhaoyinqi | BUG修复 |
| 2026-04-16 | 重构：queueInjection 参数封装为 QueueInjectionOptions 对象，更新 stream-processor、ipc/agent、orchestrator 全部调用方 | @moonseeker1 | 代码审计 |
