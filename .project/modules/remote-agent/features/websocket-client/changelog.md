# 变更记录 — websocket-client

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-21 | 修复 handleClaudeChat 竞态条件：添加 per-session 处理锁防止并发 streamChat 导致重复子 Agent；顺带修复前序 PRD 遗留的 needsClosedSessionRetry/session 作用域错误 — `packages/remote-agent-proxy/src/server.ts` — PRD: `prd/bugfix/agent/bugfix-remote-duplicate-subagent-v1` | @misakamikoto | bugfix-remote-duplicate-subagent-v1 |
| 2026-04-16 | 远程 Proxy 中途发消息取消 interrupt + SDK 注入，改为纯队列存储等待 streamChat 自然完成后消费排队消息，与本地行为一致 — PRD: `prd/bugfix/remote-agent/bugfix-remote-queue-interrupt-v1` | @zhaoyinqi | bugfix-remote-queue-interrupt-v1 |
| 2026-04-16 | 统一远端中途发消息：活跃 stream 时通过 SDK patch 的 session.send()+interrupt() 注入消息，与本地行为一致 | @zhaoyinqi | unified-sdk-patch-v1 |
| 2026-04-16 | 初始设计：远程 WebSocket 客户端与连接管理 | @moonseeker1 | 新功能 |
