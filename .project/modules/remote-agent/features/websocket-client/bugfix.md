# Bug 记录 — websocket-client

## 统计
| 严重程度 | 数量 |
|---------|------|
| Critical | 0 |
| Major | 1 |
| Minor | 0 |

## [Major] WebSocket 断网后无法重连

**日期**: 2026-05-07
**状态**: 已修复
**PRD**: `.project/prd/bugfix/remote/bugfix-ws-reconnect-v1.md`

**现象**: 断网后报 "WebSocket disconnected (code: undefined) while stream xxx was active"，之后无论网络是否恢复都无法重连。

**根因**: 三个缺陷叠加导致：
1. `reconnectTimer` 在 setTimeout 回调触发后未清空为 null，`scheduleReconnect()` 的防重复检查 `if (this.reconnectTimer) return` 让指数退避重连只执行 1 次而非设计中的 5 次
2. 连接池 `acquireConnection()` 发现旧客户端不在线时直接 `destroy()`，杀死正在后台重连的客户端（`destroy()` → `disconnect()` → `shouldReconnect = false`）
3. 连接池只监听 `close` 事件（仅在主动 disconnect 时触发），不监听 `disconnected`（网络断开时触发）和 `reconnectFailed`（重连耗尽时触发），导致池中一直保留死客户端
