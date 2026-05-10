# PRD [功能级] -- 双向心跳检测 + 断连保留 Session

> 版本：v1
> 日期：2026-05-09
> 指令人：@moonseeker
> 归属模块：modules/remote-agent
> 状态：done
> 级别：feature
> 优先级：P0
> 影响范围：仅后端（remote-agent-proxy 服务端 + Electron 主进程 WS 客户端）

---

## 需求分析

### 背景

当前远程 Agent 系统的心跳是**单向的**：只有客户端向服务端发 ping，服务端被动回复 pong。服务端**完全没有客户端存活检测**能力。

### 问题

1. **客户端静默死亡无法检测**：如果客户端进程 kill -9 或网络中断无 TCP FIN，服务端无法感知，会持续向死 socket 推流，session 锁永不释放，重连后消息被 queue 永远挂起
2. **断连时 pending promise 未清理**：WebSocket 断开时只清理了 `pendingMcpToolCalls`，`pendingHyperSpaceTools` 和 `pendingAskQuestions` 未被清理，导致悬空 Promise
3. **SDK session 不保留**：断连时直接放弃 SDK session，无法供断点续传使用

### 目标

- 服务端主动检测客户端存活，心跳超时后双方都能感知并中断连接
- 断连时清理所有 pending promise（MCP、HyperSpace Tools、AskQuestions）
- 保留 SDK session 供断点续传（2h 空闲超时兜底）

## 技术方案

### 设计原则

1. **双向检测**：客户端和服务端都能独立检测对方死亡
2. **Session 保留**：心跳超时断连时标记 session 为 interrupted + force abort stream，但不关闭 SDK session
3. **最小修改**：不改变现有重连机制，只增加服务端主动检测和断连清理增强

### Fix #1：服务端心跳检测

**文件**：`packages/remote-agent-proxy/src/server.ts`

**1a. clients Map 添加 `lastClientActivityAt` 字段**

在所有 `this.clients.set()` 调用中添加 `lastClientActivityAt: Date.now()`。

**1b. handleMessage() 更新活跃时间**

在 `handleMessage()` 顶部（auth 检查之后）更新 `client.lastClientActivityAt = Date.now()`，确保客户端的**任何消息**都刷新活跃时间。

**1c. 新增 `startHeartbeatCheck()` / `stopHeartbeatCheck()`**

- 每 15s 检查所有已认证客户端的 `lastClientActivityAt`
- 超过 30s 无活动 → 发送服务端 ping 催促客户端回复
- 超过 90s 无活动 → 判定客户端死亡，`ws.close(4002, 'Heartbeat timeout')`
- 构造函数中启动，`close()` 方法中停止

### Fix #2：客户端响应服务端 ping

**文件**：`src/main/services/remote/ws/remote-ws-client.ts`

在 `handleMessage()` 的 switch 中添加 `case 'ping'`，回复 `pong`。

客户端已有的 `lastPongTime` + 90s 超时机制已能检测服务端死亡，无需额外修改。

### Fix #3：断连清理增强

**文件**：`packages/remote-agent-proxy/src/server.ts`

提取 `handleClientDisconnect(ws)` 方法，在断连时：

1. 如果有活跃 session（`sessionProcessingLocks.has`），调用 `markAsInterrupted()` + `forceAbortStreamIterator()` 释放锁
2. **不关闭 SDK session**（保留供断点续传，2h 空闲超时兜底）
3. 清理所有 3 类 pending promise：`pendingMcpToolCalls`、`pendingHyperSpaceTools`、`pendingAskQuestions`

### Fix #4：类型定义更新

**文件**：`packages/remote-agent-proxy/src/types.ts` — `ClientMessage.type` 加 `'pong'`
**文件**：`src/main/services/remote/ws/ws-types.ts` — `ServerMessage.type` 加 `'ping'`

## 断开场景分析

### 场景 A：客户端静默死亡（网络中断无 TCP FIN）

```
0s   客户端正常，每 30s 发 ping
30s  网络中断，客户端 ping 无法到达服务端
60s  服务端 30s 内未收到任何消息 → 发送服务端 ping（也到不了客户端）
90s  服务端心跳超时 → ws.close(4002)
     → handleClientDisconnect:
       → markAsInterrupted + forceAbortStreamIterator（释放 session 锁）
       → 清理 pendingMcpToolCalls / pendingHyperSpaceTools / pendingAskQuestions
       → SDK session 保留
```

### 场景 B：服务端静默死亡（进程崩溃）

```
0s   服务端正常，回复客户端 pong
30s  服务端进程崩溃
60s  客户端 pong 超时（90s 内连续 2 次未收到 pong）→ ws.close(4001)
     → 本地: reject activeStreamSessions, scheduleReconnect, saveSessionId
```

### 场景 C：SSH 隧道半开（TCP 连接在但数据不通）

```
SSH 隧道进入半开状态
→ 客户端 ping 发不到服务端 → 客户端 90s 后 close(4001)
→ 服务端 ping 发不到客户端 → 服务端 90s 后 close(4002)
→ 先到的一方触发 close，另一方收到 close frame 后也走 close handler
→ 双方 cleanup 幂等（Map.delete、Set.add、forceAbort 都是幂等的）
```

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `packages/remote-agent-proxy/src/types.ts` | 修改 | `ClientMessage.type` 加 `'pong'` |
| `packages/remote-agent-proxy/src/server.ts` | 修改 | 服务端心跳检测 + `handleClientDisconnect` 提取 + pending promise 全面清理 |
| `src/main/services/remote/ws/ws-types.ts` | 修改 | `ServerMessage.type` 加 `'ping'` |
| `src/main/services/remote/ws/remote-ws-client.ts` | 修改 | 响应服务端 ping（case 'ping' → send pong） |

## 验收标准

- [x] **服务端检测客户端死亡**：模拟客户端静默断开（断网不关 WebSocket），90s 内服务端日志出现 "Client timeout"，session 锁释放
- [x] **服务端 ping 催促**：客户端 30s 不发消息后，服务端日志出现发送 ping 的记录
- [x] **客户端响应服务端 ping**：客户端收到服务端 ping 后回复 pong，服务端 `lastClientActivityAt` 刷新
- [x] **Session 保留**：心跳超时断开后，客户端重连发送消息，能通过 `sdkSessionId` 恢复 SDK 会话上下文
- [x] **pending promise 清理**：断开时 `pendingMcpToolCalls`、`pendingHyperSpaceTools`、`pendingAskQuestions` 全部被 reject，无悬空 Promise
- [x] **无重复 cleanup**：场景 C（双方同时检测超时）下，不会出现重复 abort 或 double-free
- [x] **正常流程不受影响**：正常连接下双向 ping/pong 正常工作，不触发误判
- [x] **构建通过**：`npm run build` 无错误
