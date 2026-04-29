# 变更记录 -- 消息发送流程

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-17 | BUG-002：修复 SDK turn injection patch 的 `send()` 守卫条件错误（`firstResultReceived` → `_continueAfterResult`），解决第二次消息卡死问题 — `src/main/services/agent/sdk-turn-injection-patch.ts` | @zhaoyinqi | bugfix-second-message-stuck-v1 |
| 2026-04-29 | error-classifier 网络错误消息更新：从"设置环境变量"改为引导到应用内"设置 > 网络"配置代理 | 用户 | bugfix-intranet-proxy-guidance-v1 |
| 2026-04-17 | 回退中途发消息方案：移除立即 interrupt，改为等待当前任务自然完成后处理排队消息（修复 SDK 内部消息处理错误） | @zhaoyinqi | unified-sdk-patch-v1 |
| 2026-04-16 | 统一中途发消息：isGenerating 时立即触发 stopGeneration interrupt，由 SDK patch 消息注入机制处理排队消息 | @zhaoyinqi | unified-sdk-patch-v1 |
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
| 2026-04-16 | 重构：getOrCreateV2Session 参数封装为 GetOrCreateSessionOptions 对象，更新 send-message、orchestrator、app-chat 全部调用方 | @moonseeker1 | 代码审计 |
| 2026-04-27 | bugfix: 普通对话 buildBaseSdkOptions 添加 additionalDisallowedTools: ['Agent', 'Task']，SDK 层面强制禁止子 Agent 创建 | @misakamikoto | bugfix-excessive-subagents-v4 |
