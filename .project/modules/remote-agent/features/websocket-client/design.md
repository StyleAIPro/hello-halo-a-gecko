# 功能 — websocket-client

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（初始文档化）
> 所属模块：modules/remote-agent/remote-agent-v1

## 描述
远程 WebSocket 客户端，负责与远程 Agent Proxy 服务器建立和维护双向通信。基于 `ws` 库实现 WebSocket 连接，支持 Token 认证、自动重连（指数退避，最多 5 次）、心跳检测（30 秒 ping/90 秒 pong 超时）、流式消息传输和中断控制。通过连接池（`connectionPool`）复用同一服务器的连接，支持引用计数和过期回收（30 分钟）。`RemoteWsClient` 继承 `EventEmitter`，将服务端消息解耦为独立事件，供上层 `send-message.ts` 和 `chat.store.ts` 消费。

## 依赖
- `ws` — WebSocket 客户端库
- Node.js `events` — `EventEmitter` 基类
- `src/main/utils/logger.ts` — 统一日志
- `src/main/services/remote-ssh/ssh-tunnel.service.ts` — SSH 隧道提供本地端口转发

## 实现逻辑

### 正常流程

**连接与认证（`connect()`）**
1. 检查已有连接状态，避免重复连接
2. 根据 `useSshTunnel` 决定连接目标：`localhost:{localPort}`（隧道模式）或 `{host}:{port}`（直连模式）
3. 创建 WebSocket 实例，设置 `Authorization: Bearer {token}` 请求头和 `perMessageDeflate` 压缩
4. WebSocket `open` 后先发送 `register-token-disk` 消息注册 Token（避免 fs.watch 时序问题），再发送 `auth` 消息
5. 等待 `auth:success` 事件（10 秒超时），认证成功后 Promise resolve
6. 启动心跳定时器（`startPing()`），每 30 秒发送 `ping`

**流式聊天（`sendChatWithStream()`）**
1. 注册事件监听器：`claude:stream`、`claude:usage`、`claude:complete`、`claude:error`、`thought`、`thought:delta`、`terminal:output`
2. 发送 `claude:chat` 消息（含 sessionId、messages、options）
3. 每个 stream 事件追加内容到 `chunks[]`，emit `stream` 事件供 UI 实时更新
4. 活动检测：任何 stream/thought/terminal 事件重置空闲计时器（默认 30 分钟超时）
5. `claude:complete` 时 resolve Promise，返回完整内容和 token 用量
6. 注册到 `activeStreamSessions` 以支持中断

**消息路由（`handleMessage()`）**
- 按消息类型分发到对应 EventEmitter 事件
- 支持的消息类型：`auth:success/failed`、`claude:stream/complete/error/session/usage`、`tool:call/delta/result/error`、`terminal:output`、`thought/thought:delta`、`mcp:status/tool:call/tool:response`、`compact:boundary`、`text:block-start`、`task:update/list/get/cancel/spawn`、`worker:started/completed`、`ask:question`、`fs:result/error`、`pong`

**中断控制（`interrupt()`）**
1. 向远程发送 `claude:interrupt` + `close:session` 消息
2. 若已断开则尝试短暂重连发送
3. 等待 300ms 让已排队的消息处理完毕
4. 设置 `isInterrupted` 标志阻止后续流式事件转发
5. 直接 reject 所有 `activeStreamSessions` 中的 Promise
6. 断开连接

**连接池（`acquireConnection()` / `releaseConnection()`）**
1. 按服务器 ID 查找已有连接，检查存活和过期（30 分钟）
2. 引用计数管理（`refs: Set<callerId>`），支持多调用方共享连接
3. 认证失败时自动重试一次（500ms 延迟，等待多 PC Token 同步）
4. 连接关闭时自动从池中移除

**自动重连（`scheduleReconnect()`）**
1. 指数退避：3s * 2^attempt（3s → 6s → 12s → 24s → 48s）
2. 最多 5 次尝试
3. 故意断开（`shouldReconnect = false`）不触发重连

### 异常流程
1. **认证超时** — 10 秒内未收到 `auth:success`，reject 连接 Promise，提示检查 proxy 运行状态
2. **认证失败（code 1008）** — Token 无效，reject 并提示注册 Token
3. **连接丢失（code 1006）** — 远程进程可能崩溃，reject 所有活跃 stream session
4. **Pong 超时** — 90 秒未收到 pong，主动关闭连接（code 4001）
5. **连接超时** — 30 秒未建立连接，关闭并 reject
6. **发送失败** — WebSocket 非 OPEN 状态时 send 返回 `false`，调用方处理

## 涉及 API
- WebSocket 消息协议：`ClientMessage`（客户端→服务端）和 `ServerMessage`（服务端→客户端）类型定义

## 涉及数据
- `RemoteWsClientConfig` — 连接配置（serverId、host、port、authToken、useSshTunnel、apiKey、model 等）
- `activeClients` Map — sessionId -> RemoteWsClient 运行时注册表
- `connectionPool` Map — serverId -> PooledConnection 连接池

## 变更
-> changelog.md
