# 变更记录 — websocket-client

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-05-09 | 双向心跳检测：服务端每 15s 检查客户端活跃时间，30s 无活动发 ping 催促，90s 超时关闭(4002)；客户端响应服务端 ping（case 'ping' → pong）；断连时清理所有 pending promise（McpToolCalls/HyperSpaceTools/AskQuestions），保留 SDK session 供断点续传 — `server.ts`、`remote-ws-client.ts`、`ws-types.ts` — PRD: `prd/feature/remote-agent/feature-bidirectional-heartbeat-v1` | @moonseeker | feature-bidirectional-heartbeat-v1 |
| 2026-05-08 | SSH 隧道断开时联动失效连接池：acquireConnection 添加隧道存活检查（isServerTunnelAlive），隧道已死时跳过 waitForReconnect 直接创建新连接；`close` handler 中增加 client.destroy() 彻底停止旧 client 重连 — `ws-connection-pool.ts` — PRD: `prd/bugfix/remote/bugfix-tunnel-pool-invalidation-v1` | @moonseeker | bugfix-tunnel-pool-invalidation-v1 |
| 2026-04-21 | 修复 handleClaudeChat 竞态条件：添加 per-session 处理锁防止并发 streamChat 导致重复子 Agent；顺带修复前序 PRD 遗留的 needsClosedSessionRetry/session 作用域错误 — `packages/remote-agent-proxy/src/server.ts` — PRD: `prd/bugfix/agent/bugfix-remote-duplicate-subagent-v1` | @misakamikoto | bugfix-remote-duplicate-subagent-v1 |
| 2026-04-16 | 远程 Proxy 中途发消息取消 interrupt + SDK 注入，改为纯队列存储等待 streamChat 自然完成后消费排队消息，与本地行为一致 — PRD: `prd/bugfix/remote-agent/bugfix-remote-queue-interrupt-v1` | @zhaoyinqi | bugfix-remote-queue-interrupt-v1 |
| 2026-04-16 | 统一远端中途发消息：活跃 stream 时通过 SDK patch 的 session.send()+interrupt() 注入消息，与本地行为一致 | @zhaoyinqi | unified-sdk-patch-v1 |
| 2026-04-16 | 初始设计：远程 WebSocket 客户端与连接管理 | @moonseeker1 | 新功能 |
