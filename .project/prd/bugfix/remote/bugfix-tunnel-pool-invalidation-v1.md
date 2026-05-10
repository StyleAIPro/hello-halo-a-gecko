# PRD — Bugfix: SSH 隧道断开未通知 WebSocket 连接池导致新消息卡死

> 版本：v1
> 日期：2026-05-08
> 状态：done
> 指令人：@moonseeker
> 优先级：P0
> 影响范围：仅后端（主进程 `remote/ws` + `remote/ssh` 模块）

## 问题分析

### 现象

SSH 隧道因网络异常（ECONNRESET）断开后，用户发送新消息，UI 永久卡在"生成中"状态。日志显示：
1. SSH 隧道重建成功
2. `checkRemoteAgentRunning`（`pgrep` + `ss`）通过
3. 之后只有 health check 日志，无任何 `agent:remote` / `remote-ws` / `remote-ws-pool` 日志
4. 新消息既不收到响应，也不报错退出

### 根因

**SSH 隧道服务与 WebSocket 连接池之间存在生命周期通知缺失。** 当 SSH 隧道断开时，`cleanupTunnel()` 只清理了隧道自身状态，没有通知 WebSocket 连接池失效对应的池化连接。

#### 故障链路

```
1. SSH ECONNRESET
   └─ ssh-tunnel.service.ts:331  client.on('close') → cleanupTunnel()
      ├─ 从 tunnels Map 删除
      ├─ 释放 usedPorts
      └─ 关闭本地 TCP Server
      ✗ 未通知 ws-connection-pool.ts！

2. WebSocket 1006 close（隧道已死，TCP 连接被 RST）
   └─ remote-ws-client.ts:175  ws.on('close') → scheduleReconnect()
      └─ reconnectTimer 设置（3s 指数退避）

3. 用户发新消息（~9 秒后）
   ├─ sshTunnelService.establishTunnel() → 新隧道建立成功 ✅
   └─ acquireConnection(serverId, wsConfig, conversationId)
      ├─ pool 中有旧 entry（reconnecting 状态）
      ├─ isReconnecting() === true（reconnectTimer 非 null）
      └─ waitForReconnect(15000) ← 卡在这里

4. 内部重连竞争
   ├─ 旧 client 的 reconnect 以 3s→6s→12s 指数退避尝试连接
   ├─ 每次尝试可能：
   │   ├─ 隧道还没建好 → 失败 → 继续退避
   │   ├─ 隧道已建好 → 成功 → 返回旧 client（内部状态不确定）
   │   └─ 端口已变（cleanupTunnel 释放端口后 getOrAssignLocalPort 分配新端口）→ 连接错误地址
   └─ waitForReconnect 15s 超时后才创建新 client

5. 即使最终连接成功
   ├─ 旧 client 的 scheduleReconnect 和新消息的 connect 存在竞争
   ├─ 旧 client 可能已被 destroy()（removeAllListeners）但 reconnect timer 仍触发
   └─ 最坏情况：acquireConnection 永远无法返回有效连接
```

#### 关键证据（日志）

```
20:34:21  [SshTunnel] SSH connection closed → cleanupTunnel() → 隧道删除
20:34:21  [Agent] WebSocket disconnected (code: 1006) while stream active
          ※ 此刻 pool 中旧 entry 仍在，reconnectTimer 被设置

20:34:30  [Agent] Calling executeRemoteMessage...
20:34:31  [SshTunnel] Tunnel established（新隧道，同一端口 32713）
          ※ acquireConnection 发现旧 entry isReconnecting()=true
          ※ 进入 waitForReconnect(15000)...

20:34:38  [SSHManager] checkRemoteAgentRunning 完成 ← checkAndStartAgent() 已返回
          ※ Promise.all 等待 acquireConnection...

20:34:53+ 仅 health check，无 agent:remote 日志 ← acquireConnection 未返回
```

### 与已有 PRD 的关系

| PRD | 状态 | 关系 |
|-----|------|------|
| `bugfix-ws-reconnect-v1` | done | 修复了连接池监听 `disconnected` 事件 + 等待重连逻辑。但**未解决 SSH 隧道断开导致池化连接失效的问题**——当隧道断开时 WS 1006 触发 `scheduleReconnect()`，连接池监听 `disconnected` 事件删除了 pool entry，但 `scheduleReconnect()` 的 timer 仍然运行。当新消息到来时，如果 timer 重新创建了一个 pool entry（通过 reconnect 成功），这个 entry 的 config 可能指向错误的端口。 |
| `bugfix-interrupted-session-lock-v1` | in-progress | 修复服务端 session 锁卡死。与本文互补——本文修复**客户端侧**连接获取卡死，该 PRD 修复**服务端侧**会话锁卡死。两者都是断网后卡死的必要条件。 |

## 技术方案

### 设计原则

1. **SSH 隧道断开时，立即失效对应的 WebSocket 连接池条目**——不依赖 WS 层的 1006 事件时序
2. **acquireConnection 快速失败，快速恢复**——不做长时间等待，直接创建新连接
3. **最小化修改，不改变现有重连机制的内部逻辑**——只增加隧道-池联动

### Fix #1：SSH 隧道关闭时通知连接池

**文件**：`src/main/services/remote/ssh/ssh-tunnel.service.ts`

**变更**：在 `cleanupTunnel()` 中，清理隧道后通知 WebSocket 连接池删除对应 server 的池化连接。

```typescript
// ssh-tunnel.service.ts 顶部新增 import
import { removePooledConnection } from '../ws/ws-connection-pool';

// cleanupTunnel() 方法末尾，在 this.tunnels.delete(tunnelKey) 之后添加
private cleanupTunnel(tunnelKey: string): boolean {
  const tunnel = this.tunnels.get(tunnelKey);
  if (!tunnel) return false;

  const serverId = tunnel.config.serverId; // ← 新增：保存 serverId

  this.usedPorts.delete(tunnel.config.localPort);

  if (tunnel.server) {
    try {
      tunnel.server.close();
      console.log(`[SshTunnel] Local server closed for ${tunnelKey}`);
    } catch (err) {
      console.error(`[SshTunnel] Error closing local server for ${tunnelKey}:`, err);
    }
  }

  try {
    tunnel.client.end();
    tunnel.client.destroy();
  } catch (err) {
    console.error(`[SshTunnel] Error closing tunnel ${tunnelKey}:`, err);
  }

  this.tunnels.delete(tunnelKey);
  console.log(`[SshTunnel] Tunnel ${tunnelKey} closed and removed`);

  // 新增：通知 WebSocket 连接池失效对应 server 的池化连接
  // SSH 隧道是 WebSocket 连接的传输层，隧道死亡意味着所有通过该隧道的
  // WebSocket 连接都已不可用，必须立即清理
  removePooledConnection(serverId);

  return true;
}
```

**理由**：
- `cleanupTunnel()` 是隧道生命周期的唯一清理入口（被 `closeTunnel()`、`client.on('close')`、server error 三处调用）
- 在这里添加通知，保证无论隧道因何种原因死亡，连接池都能及时感知
- `removePooledConnection()` 是已有的 API（`ws-connection-pool.ts:121-128`），调用 `destroy()` + `delete()`
- `destroy()` 会调用 `disconnect()` → `shouldReconnect = false` + `cancelReconnect()`，彻底停止旧 client 的重连尝试

### Fix #2：acquireConnection 添加隧道存活检查

**文件**：`src/main/services/remote/ws/ws-connection-pool.ts`

**变更**：在 `acquireConnection()` 中，检查池化连接对应的 SSH 隧道是否仍然存活。如果隧道已死，直接跳过等待重连。

```typescript
// ws-connection-pool.ts 顶部新增 import
import sshTunnelService from '../../remote/ssh/ssh-tunnel.service';

// acquireConnection() 中，在 existing 分支内部，isReconnecting() 检查之前添加隧道验证
export async function acquireConnection(
  serverId: string,
  config: RemoteWsClientConfig,
  callerId: string,
): Promise<RemoteWsClient> {
  const existing = connectionPool.get(serverId);

  if (existing) {
    if (existing.client.isConnected()) {
      // ... 原有逻辑不变 ...
    } else if (existing.client.isReconnecting()) {
      // 新增：检查 SSH 隧道是否仍然存活
      // 如果隧道已死，旧 client 的重连必然失败（连接目标不可达），
      // 没必要等待 waitForReconnect，直接销毁并创建新连接
      if (config.useSshTunnel && !sshTunnelService.isTunnelActive(existing.config.serverId ? existing.config.serverId : serverId, callerId)) {
        log.info(
          `[${serverId}] SSH tunnel is down, skipping reconnect wait — destroying stale connection`,
        );
        existing.client.destroy();
        connectionPool.delete(serverId);
        // fall through 到下面的 "创建新连接" 逻辑
      } else {
        // 原有逻辑：等待重连
        log.info(
          `[${serverId}] Pooled connection is reconnecting, waiting up to 15s...`,
        );
        const reconnected = await existing.client.waitForReconnect(15000);
        if (reconnected && existing.client.isConnected()) {
          existing.createdAt = Date.now();
          existing.refs.add(callerId);
          log.info(`[${serverId}] Reconnected successfully, reusing connection`);
          return existing.client;
        }
        log.info(
          `[${serverId}] Reconnect did not succeed, creating new connection`,
        );
        existing.client.destroy();
        connectionPool.delete(serverId);
      }
    } else {
      log.info(`[${serverId}] Pooled connection is dead, removing`);
      existing.client.destroy();
      connectionPool.delete(serverId);
    }
  }

  // ... 后续创建新连接逻辑不变 ...
}
```

**注意**：`isTunnelActive` 需要 `spaceId` 参数，但在 `acquireConnection` 中我们只有 `serverId` 和 `callerId`（通常是 `conversationId`）。有两个处理方式：

**方案 A（推荐）**：给 `SshTunnelService` 添加一个不依赖 spaceId 的隧道检查方法：

```typescript
// ssh-tunnel.service.ts 新增方法
/**
 * Check if a tunnel exists and its SSH connection is alive for a server.
 * Does not require spaceId — only checks transport-level connectivity.
 */
isServerTunnelAlive(serverId: string): boolean {
  const tunnel = this.tunnels.get(serverId);
  return tunnel !== undefined && isClientConnected(tunnel.client);
}
```

然后在 `acquireConnection` 中使用：

```typescript
if (config.useSshTunnel && !sshTunnelService.isServerTunnelAlive(serverId)) {
  // 隧道已死，跳过重连等待
}
```

**理由**：
- Fix #1 已经在隧道关闭时通知了连接池，正常情况下 pool entry 已被删除
- Fix #2 是**防御性兜底**——处理 race condition（隧道关闭事件和 acquireConnection 调用几乎同时发生时）
- 使用简单的 `isServerTunnelAlive()` 而非 `isTunnelActive(spaceId, serverId)`，因为连接池层不应该关心 space 维度
- 不改变现有 `waitForReconnect` 的 15s 超时——正常网络波动（隧道存活）时仍然等待重连

### Fix #3：连接池 `disconnected` 事件处理中停止旧 client 的重连

**文件**：`src/main/services/remote/ws/ws-connection-pool.ts`

**变更**：强化现有的 `disconnected` 事件 handler（由 `bugfix-ws-reconnect-v1` 引入），确保删除 pool entry 时旧 client 的重连被彻底停止。

当前代码（`bugfix-ws-reconnect-v1` 修改后）：

```typescript
client.once('disconnected', ({ code, reason }) => {
  const entry = connectionPool.get(serverId);
  if (entry && entry.client === client) {
    connectionPool.delete(serverId);
    log.info(`[${serverId}] Pooled connection lost (code: ${code}), removed from pool`);
  }
});
```

这段代码只从 pool 中删除了 entry，但没有 destroy client。如果 WS 1006 后 `scheduleReconnect()` 已被调用，旧 client 的 reconnect timer 仍在运行。后续 `acquireConnection` 会因为 pool entry 已被删除而走"创建新连接"路径，但旧 client 的 timer 可能与新 client 产生竞争。

**修改为**：

```typescript
client.once('disconnected', ({ code, reason }) => {
  const entry = connectionPool.get(serverId);
  if (entry && entry.client === client) {
    connectionPool.delete(serverId);
    // 同时销毁旧 client，停止其内部的重连定时器
    // 防止旧 client 的 scheduleReconnect 与新消息的 acquireConnection 竞争
    client.destroy();
    log.info(
      `[${serverId}] Pooled connection lost (code: ${code}), removed and destroyed`,
    );
  }
});
```

**理由**：
- `client.once('disconnected')` 是 `once`，只会触发一次，不会重复 destroy
- `destroy()` 内部调用 `disconnect()` → `shouldReconnect = false` + `cancelReconnect()`，彻底停止重连
- 这样无论 WS 断开的原因是什么（SSH 隧道死亡、网络波动、proxy 崩溃），连接池都能干净地清理
- 后续 `acquireConnection` 调用时 pool 为空，直接创建新连接——**零等待**

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计文档 | `.project/modules/remote-agent/remote-agent-v1.md` | 理解 remote 模块整体架构 |
| 功能设计文档 | `.project/modules/remote-agent/features/websocket-client/design.md` | 理解 WS 客户端设计：连接池、重连机制、事件模型 |
| 功能设计文档 | `.project/modules/remote-agent/features/ssh-tunnel/design.md` | 理解 SSH 隧道设计：生命周期事件、cleanupTunnel 入口 |
| 相关 PRD | `.project/prd/bugfix/remote/bugfix-ws-reconnect-v1.md` | 理解已有的连接池 `disconnected` 事件修复，避免冲突 |
| 相关 PRD | `.project/prd/bugfix/remote/bugfix-interrupted-session-lock-v1.md` | 理解服务端 session 锁修复（互补关系） |
| 源码文件 | `src/main/services/remote/ws/ws-connection-pool.ts` | **核心修改文件** — acquire/release/remove 流程 |
| 源码文件 | `src/main/services/remote/ws/remote-ws-client.ts` | 理解 disconnect/destroy 生命周期、scheduleReconnect 机制 |
| 源码文件 | `src/main/services/remote/ssh/ssh-tunnel.service.ts` | **核心修改文件** — cleanupTunnel、isTunnelActive |
| 源码文件 | `src/main/services/agent/send-message-remote.ts` | 理解 acquireConnection 的调用上下文（Promise.all） |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript 严格模式、命名规范 |

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/main/services/remote/ssh/ssh-tunnel.service.ts` | 修改 | `cleanupTunnel()` 末尾调用 `removePooledConnection()`；新增 `isServerTunnelAlive()` 方法 |
| `src/main/services/remote/ws/ws-connection-pool.ts` | 修改 | `disconnected` handler 中添加 `client.destroy()`；`acquireConnection()` 添加隧道存活检查 |

## 验收标准

- [ ] **隧道断开立即失效池化连接**：SSH 隧道 ECONNRESET 后，`getPoolStats()` 不再显示对应 server 的连接（`removePooledConnection` 被调用）
- [ ] **新消息不卡死**：SSH 隧道断开后发新消息，新隧道建立后 WebSocket 连接立即创建（不走 waitForReconnect），日志在隧道建立后 5 秒内出现 "Created new pooled connection" 或 "Connecting to"
- [ ] **旧 client 重连被彻底停止**：隧道断开后，日志中不再出现旧 client 的 "Scheduling reconnect" 或 "Reconnect failed"（destroy() 取消了 reconnectTimer）
- [ ] **正常重连不受影响**：非 SSH 隧道原因的 WS 断开（如 proxy 重启），连接池的 waitForReconnect 逻辑仍然正常工作
- [ ] **无竞争条件**：快速连续发送两条消息（第一条触发隧道断开，第二条紧跟），第二条消息能正常获取连接并发送
- [ ] **类型检查通过**：`npm run typecheck` 无错误
- [ ] **构建通过**：`npm run build` 无错误
