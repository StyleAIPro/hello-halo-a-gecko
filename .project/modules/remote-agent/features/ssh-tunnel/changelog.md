# 变更记录 — ssh-tunnel

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-05-08 | cleanupTunnel 末尾调用 removePooledConnection 通知 WS 连接池失效；新增 isServerTunnelAlive() 供连接池检查隧道存活状态 — `ssh-tunnel.service.ts` — PRD: `prd/bugfix/remote/bugfix-tunnel-pool-invalidation-v1` | @moonseeker | bugfix-tunnel-pool-invalidation-v1 |
| 2026-04-16 | 初始设计：SSH 隧道建立与管理 | @moonseeker1 | 新功能 |
