# PRD — Bugfix: 远程 Agent WebSocket 断网后无法重连

> 版本：v1
> 日期：2026-05-07
> 状态：done
> 指令人：@moonseeker
> 优先级：P0
> 影响范围：仅后端（主进程 remote/ws 模块）

## 问题分析

### 现象

远程 Agent WebSocket 连接因网络断开（如 WiFi 切换、VPN 断开、网络抖动）后无法自动恢复。用户必须手动刷新或重新连接远程服务器才能继续使用。

### 根因

连接池（`ws-connection-pool.ts`）和重连机制（`remote-ws-client.ts`）之间存在两个协同缺陷。

#### 缺陷 1：连接池监听了错误的事件，无法感知网络断开

| 项目 | 详情 |
|------|------|
| 文件 | `ws-connection-pool.ts` line 65 |
| 问题 | 连接池注册了 `client.once('close', ...)` 来自动清理池中的死连接 |
| 实际行为 | 网络断开时 `RemoteWsClient` 发出的是 `'disconnected'` 事件（`remote-ws-client.ts` line 215），而 `'close'` 事件**只在主动调用 `disconnect()` 时才发出**（`remote-ws-client.ts` line 759） |
| 结果 | 连接池永远不知道网络断了，一直保留着不可用的死客户端。后续 `acquireConnection()` 发现 `isConnected() === false` 时，走的是 else 分支（line 48-52），虽然会 destroy + delete，但这个触发路径本身就说明连接池状态已经过时了——如果连接池能及时感知断开，就不需要等到下次用户发消息才发现 |

#### 缺陷 2：`acquireConnection()` 杀死了正在重连的客户端

| 项目 | 详情 |
|------|------|
| 文件 | `ws-connection-pool.ts` line 48-52 |
| 问题 | 当用户在网络断开后发送新消息时，`acquireConnection()` 发现旧客户端 `isConnected() === false`，直接调用 `existing.client.destroy()` |
| `destroy()` 的行为 | `destroy()` → `disconnect()` → 设置 `shouldReconnect = false` 并清除 `reconnectTimer`（`remote-ws-client.ts` line 748-749），同时 `removeAllListeners()` |
| 后果 | 旧客户端正在后台通过指数退避努力重连，被新消息请求亲手杀死。之后创建的全新客户端只做一次 `connect()`（`ws-connection-pool.ts` line 73），没有重试机制。如果服务器还没恢复，直接失败 |
| 时序示例 | 网络 5 秒后恢复 → 重连定时器 3s 后触发 → 但用户在第 1 秒发了新消息 → destroy 杀死重连 → 新客户端第 1 秒连接失败 → 用户看到错误 |

### 次要问题：`code:undefined` 未视为异常断开

| 项目 | 详情 |
|------|------|
| 文件 | `remote-ws-client.ts` line 188-194 |
| 问题 | `ws.on('close')` 的事件 code 为 `undefined` 时（某些网络场景下出现），不匹配 `1006` 分支，走到了通用错误消息 |
| 实际含义 | `code: undefined` 与 `1006` 一样，表示异常断开（没有收到关闭帧） |

## 技术方案

### 修改 1：连接池监听 `'disconnected'` 事件（替代 `'close'`）

**文件**：`src/main/services/remote/ws/ws-connection-pool.ts`

**变更**：将 line 65 的 `client.once('close', ...)` 改为监听 `'disconnected'` 事件：

```typescript
// 修改前（line 65）
client.once('close', () => {
  const entry = connectionPool.get(serverId);
  if (entry && entry.client === client) {
    connectionPool.delete(serverId);
    log.info(`[${serverId}] Pooled connection closed, removed from pool`);
  }
});

// 修改后
client.once('disconnected', ({ code, reason }: { code: number; reason: string }) => {
  const entry = connectionPool.get(serverId);
  if (entry && entry.client === client) {
    connectionPool.delete(serverId);
    log.info(
      `[${serverId}] Pooled connection lost (code: ${code ?? 1006}, reason: ${reason}), removed from pool`,
    );
  }
});
```

**理由**：
- `'disconnected'` 是网络断开时 `RemoteWsClient` 发出的唯一事件（`remote-ws-client.ts` line 215）
- 连接池需要在断开时立即感知并清理，而不是等到下次 `acquireConnection()` 被调用时才发现
- 注意：这里用 `once` 是正确的，因为断开后连接已被清理，不会重复触发

### 修改 2：`acquireConnection()` 等待正在重连的客户端，而不是直接 destroy

**文件**：`src/main/services/remote/ws/ws-connection-pool.ts`

**变更**：在 `acquireConnection()` 的 else 分支（line 48-52），检查旧客户端是否正在重连，如果是，等待重连完成：

首先，需要在 `RemoteWsClient` 上暴露一个 `isReconnecting()` 公共方法（修改 2a），然后在连接池中使用它（修改 2b）。

#### 修改 2a：`RemoteWsClient` 暴露 `isReconnecting()` 方法

**文件**：`src/main/services/remote/ws/remote-ws-client.ts`

在 `isConnected()` 方法（line 744）附近添加：

```typescript
/**
 * Returns true if the client is currently attempting to reconnect.
 * This allows the connection pool to wait for an in-progress reconnection
 * instead of destroying the client and creating a new one.
 */
isReconnecting(): boolean {
  return this.reconnectTimer !== null;
}
```

**理由**：
- `reconnectTimer` 在 `scheduleReconnect()` 中被设置（line 704），在重连成功后（`ws.on('open')` → `connect()` 开始时 `shouldReconnect = true` 并不清除 timer，但 timer 回调执行 `connect()` 后 timer 已自然过期）或 `cancelReconnect()` 中被清除（line 738-741）
- 当 `reconnectTimer !== null` 时，说明有一个排队的重连任务正在等待执行
- 这是一个简单的、已有的状态指示器，不需要引入新的状态变量

#### 修改 2b：`acquireConnection()` 重连等待逻辑

**文件**：`src/main/services/remote/ws/ws-connection-pool.ts`

替换 else 分支（line 48-52）：

```typescript
// 修改前
} else {
  log.info(`[${serverId}] Pooled connection is dead, removing`);
  existing.client.destroy();
  connectionPool.delete(serverId);
}

// 修改后
} else {
  if (existing.client.isReconnecting()) {
    // The client is already trying to reconnect in the background.
    // Wait for it to finish rather than destroying and starting over.
    log.info(
      `[${serverId}] Pooled connection is reconnecting, waiting for reconnection to complete`,
    );
    existing.refs.add(callerId);
    try {
      // Wait for reconnection with a timeout.
      // The reconnect delay is: 3000 * 2^n ms (n = attempt number).
      // With max 5 attempts, the worst case total wait is ~93s.
      // We set a generous timeout to cover the full reconnect cycle.
      const RECONNECT_WAIT_TIMEOUT_MS = 100 * 1000; // 100 seconds
      await waitForReconnect(existing.client, RECONNECT_WAIT_TIMEOUT_MS);
      // Reconnected successfully — reuse the connection
      existing.createdAt = Date.now(); // Reset age
      log.info(
        `[${serverId}] Pooled connection reconnected successfully (refs: ${existing.refs.size})`,
      );
      return existing.client;
    } catch (err) {
      log.warn(
        `[${serverId}] Wait for reconnection failed or timed out: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Fall through to create a new connection below
    }
  } else {
    // Dead and not reconnecting — remove and create new
    log.info(`[${serverId}] Pooled connection is dead and not reconnecting, removing`);
    existing.client.destroy();
  }
  connectionPool.delete(serverId);
}
```

添加辅助函数：

```typescript
/**
 * Wait for a client to finish reconnecting.
 * Resolves when the client becomes connected again.
 * Rejects if the client emits 'reconnectFailed' or timeout is reached.
 */
function waitForReconnect(
  client: RemoteWsClient,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (result: 'resolve' | 'reject', error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result === 'resolve') {
        resolve();
      } else {
        reject(error!);
      }
    };

    const cleanup = () => {
      client.off('connected', onConnected);
      client.off('reconnectFailed', onFailed);
      clearTimeout(timer);
    };

    const onConnected = () => settle('resolve');

    const onFailed = () =>
      settle('reject', new Error('Client reconnection failed (max attempts reached)'));

    client.on('connected', onConnected);
    client.on('reconnectFailed', onFailed);

    // Already connected (race condition: reconnected between isReconnecting() check and here)
    if (client.isConnected()) {
      settle('resolve');
      return;
    }

    const timer = setTimeout(() => {
      settle('reject', new Error(`Reconnection wait timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
}
```

**理由**：
- 等待已有的重连过程，而不是杀死它再从头开始
- 设置 100 秒超时，覆盖指数退避的最坏情况（3000 + 6000 + 12000 + 24000 + 48000 = 93000ms）
- 超时或 `reconnectFailed` 后，fall through 创建全新连接（与当前行为一致）
- `existing.createdAt = Date.now()` 重置连接年龄，因为重连后的连接本质上是一个新的 TCP 连接

### 修改 3：`code:undefined` 视为 `code:1006`（异常断开）

**文件**：`src/main/services/remote/ws/remote-ws-client.ts`

在 `ws.on('close')` 处理中（line 188），将 `code: undefined` 归类为异常断开：

```typescript
// 修改前（line 188-194）
if (event.code === 1008) {
  errorMessage = `...`;
} else if (event.code === 1006) {
  errorMessage = `...`;
} else {
  errorMessage = `WebSocket disconnected (code: ${event.code}, reason: ${reason})...`;
}

// 修改后
if (event.code === 1008) {
  errorMessage = `Authentication rejected by remote proxy (invalid token). Ensure the token is registered on the remote server.`;
} else if (event.code === 1006 || event.code == null) {
  errorMessage = `Remote proxy connection lost abruptly. The agent process may have crashed or is not running on port ${port}.`;
} else {
  errorMessage = `WebSocket disconnected (code: ${event.code}, reason: ${reason}). The remote process may still be running.`;
}
```

同时更新 line 215 的 `'disconnected'` 事件 payload，将 undefined code 归一化：

```typescript
// 修改前
this.emit('disconnected', { code: event.code, reason });

// 修改后
this.emit('disconnected', { code: event.code ?? 1006, reason });
```

**理由**：
- `code: undefined` 出现在网络层异常断开时（如 TCP 连接被 RST，浏览器/Electron 的 WebSocket 实现未收到关闭帧）
- 这是 `1006` 的同义词（Abnormal Closure），应给出相同的、更有诊断价值的错误信息
- 归一化后，连接池的 `'disconnected'` 事件 handler 也能正确识别异常断开

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计文档 | `.project/modules/remote-agent/remote-agent-v1.md` | 理解 remote 模块整体架构、ws 子模块职责和对外接口 |
| 功能设计文档 | `.project/modules/remote-agent/features/websocket-client/design.md` | 理解 WebSocket 客户端的设计初衷和事件模型 |
| 功能 bugfix 记录 | `.project/modules/remote-agent/features/websocket-client/bugfix.md` | 了解已有的已知问题，避免重复 |
| 源码文件 | `src/main/services/remote/ws/ws-connection-pool.ts` | **核心修改文件** — 连接池逻辑，理解 acquire/release/destroy 流程 |
| 源码文件 | `src/main/services/remote/ws/remote-ws-client.ts` | **核心修改文件** — 重连机制、事件模型、connect/disconnect/destroy 生命周期 |
| 源码文件 | `src/main/services/remote/ws/ws-types.ts` | 理解配置和消息类型定义 |
| 调用方 | `src/main/services/agent/send-message-remote.ts` | 理解 `acquireConnection()` 的调用方式和使用模式 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript 严格模式、IPC 规范、命名规范 |

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/main/services/remote/ws/ws-connection-pool.ts` | 修改 | 监听 `'disconnected'` 替代 `'close'`；添加重连等待逻辑；添加 `waitForReconnect` 辅助函数 |
| `src/main/services/remote/ws/remote-ws-client.ts` | 修改 | 添加 `isReconnecting()` 公共方法；`code: undefined` 归一化为 `1006` |

## 验收标准

- [ ] **断网自动重连**：模拟网络断开（关闭 WiFi / 断开 VPN），等待网络恢复后，远程 Agent 能自动恢复连接，无需手动刷新
- [ ] **连接池及时清理**：网络断开后，`getPoolStats()` 不再显示已断开的连接（连接池在 `'disconnected'` 事件触发时立即清理）
- [ ] **重连不被打断**：网络断开后、恢复前，发送新消息不会杀死正在重连的客户端，而是等待重连完成后复用连接
- [ ] **重连超时兜底**：重连等待超过 100 秒或重连彻底失败（max attempts reached）后，创建全新连接（而非卡死）
- [ ] **错误信息准确**：异常断开时（`code: undefined`），错误消息与 `1006` 一致，提示"连接异常断开"而非通用错误
- [ ] **正常断开不受影响**：主动断开（`disconnect()`/`destroy()`）仍然正常工作，连接池正确清理
- [ ] **类型检查通过**：`npm run typecheck` 无错误
- [ ] **构建通过**：`npm run build` 无错误
