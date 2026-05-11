---
timestamp: 2026-05-10
status: done
type: bugfix
module: remote-deploy
assignee: moonseeker
priority: P1
---

# PRD: 远程服务器断连后状态显示过期

## 问题描述

远程服务器 SSH 连接断开后（网络中断、服务器宕机、OS 休眠等），UI 仍显示 SDK 和 Bot Proxy 状态为"正常"（绿色指示灯）。用户看到的 `sdkInstalled`、`proxyRunning` 字段保持断连前的值，不会随 SSH 连接丢失而更新。

**影响**：用户误以为远程 Agent 可用，发送消息后才会发现连接已断开。

## 根因分析

### 1. SSH 断开无通知链路

`SSHManager`（`src/main/services/remote/ssh/ssh-manager.ts`）的 `connect()` 方法中注册了 `'close'` 和 `'error'` 事件监听（第 146-151 行、第 140-143 行），但只设置 `_ready = false`，没有回调通知上层 `RemoteDeployService`：

```typescript
// ssh-manager.ts 第 140-143 行
this.client.on('error', (err) => {
  this._ready = false;
  console.error('[SSHManager] Connection error:', err);
  reject(err);  // reject 只在 connect() 的 Promise 作用域内有效
});

// ssh-manager.ts 第 146-151 行
this.client.on('close', (reason) => {
  this._ready = false;
  console.log('[SSHManager] Connection closed, reason:', reason);
  this.client = null;
  this.sftp = null;
  // 没有任何通知回调
});
```

`SSHManager` 类没有提供 `onDisconnect` 回调机制（搜索 `onDisconnect|onClose|onError|_onDisconnect` 无结果），导致 `RemoteDeployService` 无法感知 SSH 断开事件。

### 2. 健康监控跳过已断开的服务器

`health-monitor.ts`（`src/main/services/remote/deploy/health-monitor.ts`）的 `runHealthCheck()`（第 53-75 行）通过 `manager.isConnected()` 过滤服务器：

```typescript
// health-monitor.ts 第 60-68 行
for (const [id, server] of svc.servers) {
  if (server.status === 'connected' && server.assignedPort) {
    const manager = svc.sshManagers.get(id);
    if (manager?.isConnected()) {  // SSH 断开后这里返回 false
      eligibleServers.push({ id, server });
    }
  }
}
```

`checkServerHealth()`（第 80-116 行）也依赖 `manager.isConnected()` 提前返回（第 85 行）。SSH 断开后，`isConnected()` 返回 `false`，健康检查完全跳过该服务器，`proxyRunning` 字段永远不会被更新为 `false`。

**注意**：`server.status` 字段仍然是 `'connected'`，因为 SSH 断开时没有更新它。

### 3. 运行时状态被持久化到配置文件

`saveServers()`（`server-manager.ts` 第 86-102 行）通过 `toSharedConfig()` 将服务器对象序列化。`toSharedConfig()`（第 44-63 行）使用展开运算符 `...rest` 传递所有字段，包括 `sdkInstalled`、`proxyRunning` 等运行时状态：

```typescript
// server-manager.ts 第 44-63 行
export function toSharedConfig(...) {
  const { ssh, lastConnected, ...rest } = config as any;
  return {
    ...rest,  // 包含 sdkInstalled, proxyRunning, apiReachable 等运行时字段
    host: ssh.host,
    sshPort: ssh.port,
    username: ssh.username,
    password: ssh.password,
  };
}
```

虽然 `saveServers()` 在保存时强制 `status: 'disconnected'`，但 `sdkInstalled` 和 `proxyRunning` 被原样持久化。下次 `loadServers()` 时这些字段恢复为过时值，且 SSH 未连接时健康监控不运行，导致 UI 一直显示旧状态。

### 4. loadServers 不清理运行时状态

`loadServers()`（`server-manager.ts` 第 68-81 行）从配置文件加载服务器后只重置 `status` 为 `'disconnected'`：

```typescript
// server-manager.ts 第 72-78 行
for (const server of servers) {
  const internalConfig = toInternalConfig(service, server);
  (service as any).servers.set(server.id, {
    ...internalConfig,
    status: 'disconnected',  // 只重置 status
    // sdkInstalled, proxyRunning 仍然保留
  });
}
```

## 技术方案

### 方案 A：SSH 断开事件回调 + 清理运行时状态

**核心思路**：在 `SSHManager` 上增加断开回调机制，让 `RemoteDeployService` 在 SSH 断开时立即清理运行时状态。

#### 步骤 A1：SSHManager 支持断开回调

**文件**：`src/main/services/remote/ssh/ssh-manager.ts`

在 `SSHManager` 类中增加一个可选的 `onDisconnect` 回调属性：

```typescript
// 新增属性
private _onDisconnectCallback: (() => void) | null = null;

/** 注册 SSH 断开回调（仅支持单个回调，覆盖式注册） */
onDisconnect(callback: (() => void) | null): void {
  this._onDisconnectCallback = callback;
}
```

在 `'close'` 事件处理中触发回调（第 146-151 行区域）：

```typescript
this.client.on('close', (reason) => {
  this._ready = false;
  console.log('[SSHManager] Connection closed, reason:', reason);
  this.client = null;
  this.sftp = null;
  // 触发断开回调
  this._onDisconnectCallback?.();
});
```

在 `disconnect()` 方法中（第 723-758 行），断开连接后也触发回调（因为主动断开也应该通知）：

```typescript
// 在 disconnect() 最后、重置 _forceDisconnected 之后
this._onDisconnectCallback?.();
```

#### 步骤 A2：RemoteDeployService 注册断开回调并清理状态

**文件**：`src/main/services/remote/deploy/server-manager.ts`

在 `connectServer()` 函数中，SSH 连接建立后注册 `onDisconnect` 回调（约第 621 行之后，`ensureSshConnectionInternal` 成功后）：

```typescript
// 在 connectServer 中，ensureSshConnectionInternal 成功后
const manager = (service as any).sshManagers.get(id);
manager.onDisconnect(() => {
  // SSH 断开时同步清理运行时状态
  (service as any).servers.set(id, {
    ...(service as any).servers.get(id),
    status: 'disconnected',
    proxyRunning: false,
    apiReachable: false,
  });
  // 通知 UI
  (service as any).notifyStatusChange(id, (service as any).servers.get(id));
  console.debug(`[RemoteDeployService] SSH disconnected for ${server.name}, cleared runtime status`);
});
```

#### 步骤 A3：健康监控对 "status=disconnected" 服务器不更新 proxyRunning

**文件**：`src/main/services/remote/deploy/health-monitor.ts`

当前逻辑已经跳过 `isConnected() === false` 的服务器，方案 A2 已将 `status` 更新为 `'disconnected'`，所以不需要额外修改。但需确认 `checkServerHealth()` 中如果 SSH 恢复后能重新开始检查——这已由 `server.status === 'connected'` 过滤条件保证（ reconnect 后 status 会变为 connected）。

**无需修改此文件**。

### 方案 B：运行时状态不持久化

**核心思路**：`sdkInstalled`、`proxyRunning`、`apiReachable` 是运行时状态，不应写入配置文件。应用启动时应全部重置为 `undefined`。

#### 步骤 B1：saveServers 过滤运行时字段

**文件**：`src/main/services/remote/deploy/server-manager.ts`

在 `saveServers()` 函数（第 86-102 行）中，构建 `serverList` 时显式剔除运行时字段：

```typescript
const RUNTIME_ONLY_FIELDS = ['sdkInstalled', 'sdkVersion', 'sdkVersionMismatch', 'proxyRunning', 'apiReachable'];

const serverList = Array.from((service as any).servers.values()).map((s: any) => {
  const shared = toSharedConfig(service, s);
  const cleaned: Record<string, any> = {
    ...shared,
    status: 'disconnected' as const,
  };
  for (const field of RUNTIME_ONLY_FIELDS) {
    delete cleaned[field];
  }
  return cleaned;
});
```

#### 步骤 B2：loadServers 清理运行时状态

**文件**：`src/main/services/remote/deploy/server-manager.ts`

在 `loadServers()` 函数（第 68-81 行）中，加载后显式清理运行时字段：

```typescript
const RUNTIME_ONLY_FIELDS = ['sdkInstalled', 'sdkVersion', 'sdkVersionMismatch', 'proxyRunning', 'apiReachable'];

for (const server of servers) {
  const internalConfig = toInternalConfig(service, server);
  const cleaned: Record<string, any> = { ...internalConfig, status: 'disconnected' as const };
  for (const field of RUNTIME_ONLY_FIELDS) {
    delete cleaned[field];
  }
  (service as any).servers.set(server.id, cleaned);
}
```

这样应用重启后，`sdkInstalled` 和 `proxyRunning` 不会被加载，UI 显示为"未知"状态。用户点击"连接"后，`connectServer()` 末尾的 `detectAgentInstalled()` 会重新检测并更新这些字段。

### 两个方案的配合

方案 A 解决实时断连通知（SSH 断开后立即更新 UI），方案 B 解决持久化带来的启动过时数据。两个方案应同时实施。

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计 | `.project/modules/remote-agent/remote-agent-v1.md` | 理解远程部署模块架构和组件职责 |
| 源码 | `src/main/services/remote/ssh/ssh-manager.ts` | 理解 SSH 连接生命周期、`close`/`error` 事件处理、`_ready` 状态 |
| 源码 | `src/main/services/remote/deploy/server-manager.ts` | 理解 `connectServer`/`disconnectServer` 流程、`saveServers`/`loadServers` 持久化逻辑 |
| 源码 | `src/main/services/remote/deploy/health-monitor.ts` | 理解健康监控的过滤条件和检查逻辑 |
| 源码 | `src/main/services/remote/deploy/remote-deploy.service.ts` | 理解服务聚合层，确认 `servers`/`sshManagers` Map 的结构 |
| 源码 | `src/shared/types/index.ts`（RemoteServer 接口） | 理解哪些字段是运行时状态（`sdkInstalled`、`proxyRunning` 等） |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/remote/ssh/ssh-manager.ts` | 修改 | 新增 `onDisconnect` 回调机制，在 `close` 事件和 `disconnect()` 中触发 |
| `src/main/services/remote/deploy/server-manager.ts` | 修改 | 1) `connectServer` 中注册 `onDisconnect` 回调清理运行时状态；2) `saveServers` 过滤运行时字段；3) `loadServers` 清理运行时字段 |

## 验收标准

- [x] SSH 连接断开后（网络断开 / 服务器宕机），UI 立即或数秒内将服务器状态更新为"断开"，SDK 和 Proxy 状态不再显示绿色
- [x] `proxyRunning` 在 SSH 断开后被设为 `false` 或 `undefined`
- [x] `sdkInstalled` 在应用重启后不从配置文件恢复旧值，UI 显示为"未知"或"未检测"
- [x] 正常连接服务器后，`detectAgentInstalled()` 能正确检测并更新 SDK/Proxy 状态
- [x] 用户主动断开连接（点击"断开"按钮），运行时状态同样被清理
- [x] `npm run typecheck` 通过（本次修改文件无新增类型错误）
- [x] `npm run build` 通过
