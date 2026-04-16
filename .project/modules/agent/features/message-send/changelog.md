# 变更记录 -- 消息发送流程

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
| 2026-04-16 | 重构：getOrCreateV2Session 参数封装为 GetOrCreateSessionOptions 对象，更新 send-message、orchestrator、app-chat 全部调用方 | @moonseeker1 | 代码审计 |
