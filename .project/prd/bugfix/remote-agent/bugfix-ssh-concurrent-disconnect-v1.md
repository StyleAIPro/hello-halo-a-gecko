# PRD [Bug 修复级] — SSH 并发操作导致连接互相断开

> 版本：bugfix-ssh-concurrent-disconnect-v1
> 日期：2026-04-17
> 指令人：@moonseeker1
> 反馈人：@moonseeker1
> 归属模块：modules/remote-agent
> 严重程度：Major

## 问题描述
- **期望行为**：多个需要 SSH 的操作（skill 下载、skill 安装、Agent 部署、健康监控）应能安全地共享 SSH 连接，互不干扰。当某一操作正在进行时，不应影响其他操作的连接。
- **实际行为**：任何调用 `ensureFreshConnection` 的操作都会无条件断开现有 SSH 连接再重连，导致正在使用同一连接的其他操作（如后台健康监控每 30s 的 `curl health`）立即报 "Not connected" 错误。
- **复现步骤**：
  1. 添加并连接一个远程服务器，确认服务器状态为 connected 且 proxy 正常运行
  2. 等待后台健康监控启动（约 30s 后会通过 SSH 执行 `curl health`）
  3. 在健康监控正在执行 SSH 命令期间，用户触发 skill 下载或 Agent 部署操作
  4. 观察控制台日志：健康监控报 "Not connected" 错误；或 skill 下载过程中被健康监控的下一轮检查打断

## 根因分析

问题由三个因素共同导致：

### 1. `ensureFreshConnection` 无条件断开重连

`src/main/services/remote-deploy/remote-deploy.service.ts` 第 3682-3705 行：

```typescript
private async ensureFreshConnection(...): Promise<SSHManager> {
    const manager = this.getSSHManager(id);
    if (manager.isConnected()) {
      manager.disconnect();  // 无条件断开！
    }
    await this.connectServer(id);
    ...
}
```

所有需要 SSH 的操作（`deployToServer`、`updateAgentCode`、`downloadSkillFromServer`、`installSkillOnServer` 等，共 5 处调用）都通过此方法获取连接，每次都先 disconnect 再重连。

### 2. `SSHManager.disconnect()` 立即销毁底层 socket

`src/main/services/remote-ssh/ssh-manager.ts` 第 606-627 行：

```typescript
disconnect(): void {
    this._ready = false;
    this.client.end();  // 关闭底层 SSH socket
    this.client = null;
    ...
}
```

`client.end()` 会关闭底层 socket，所有正在进行的 exec channel 立刻失效。

### 3. 健康监控共享同一 SSHManager 实例

`checkServerHealth()`（第 2669-2680 行）直接从 `this.sshManagers.get(id)` 获取 SSHManager 并调用 `executeCommandFull()`，与业务命令共享同一个实例，没有命令队列或互斥锁保护。

### 时序示例

```
t=0s  健康监控: curl health → SSH exec 发送中...
t=1s  用户点击下载 skill → ensureFreshConnection → disconnect()
t=1s  健康监控: → "Not connected" 报错（SSH socket 已关闭）
t=2s  connectServer 重连
t=3s  下载文件成功
t=3s  健康监控 close 事件 → _ready=false → 又触发一次断连
```

## 修复方案

### 方案：给 SSHManager 加连接状态保护 + 命令序列化

#### 修改 1：`ensureFreshConnection` 改为条件重连（remote-deploy.service.ts）

不再每次都 disconnect + 重连，改为先通过 `SSHManager.ensureConnected()` 检测连接是否仍然有效。`ensureConnected()` 已在 SSHManager 中实现（第 580-601 行），内部通过 `echo ok` ping 检测连接，只有 ping 失败时才重连。

```typescript
private async ensureFreshConnection(
  id: string,
  serverName: string,
  onOutput?: ...,
): Promise<SSHManager> {
  const manager = this.getSSHManager(id);
  const server = this.servers.get(id);
  if (!server) throw new Error(`Server not found: ${id}`);

  const sshConfig: SSHConfig = {
    host: server.host,
    port: server.port || 22,
    username: server.username,
    password: server.password,
    privateKey: server.privateKey,
  };

  const connected = await manager.ensureConnected(sshConfig);
  if (!connected) {
    throw new Error(`Failed to connect to ${serverName}`);
  }
  return manager;
}
```

**优势**：复用已有的 `ensureConnected()` 方法，不增加新代码路径，连接有效时零开销（跳过重连）。

#### 修改 2：`SSHManager` 加命令队列/互斥锁（ssh-manager.ts）

引入简单的 Promise 队列，确保同一时间只有一个 exec/SFTP 操作在进行。`disconnect()` 调用时等待当前操作完成。

```typescript
private _operationLock: Promise<void> = Promise.resolve();

private async withLock<T>(fn: () => Promise<T>): Promise<T> {
  const previousLock = this._operationLock;
  let resolveLock: () => void;
  this._operationLock = new Promise<void>(r => { resolveLock = r; });
  try {
    await previousLock;
    return await fn();
  } finally {
    resolveLock!();
  }
}
```

将 `executeCommand`、`executeCommandFull`、`executeCommandStreaming`、`uploadFile`、`downloadFile`、`initSFTP` 等方法包装在 `withLock()` 中，确保操作串行执行。

#### 修改 3：健康监控使用独立的 SSHManager 实例（可选，增强隔离）

为每个服务器维护两个 SSHManager 实例：
- **业务 SSHManager**：用于 skill 下载、Agent 部署等用户触发的操作
- **健康监控 SSHManager**：专用于 30s 周期健康检查

这样即使业务操作断开重连，健康监控的连接不受影响。

此修改为可选项，修改 1 + 修改 2 已能解决并发问题。如果希望进一步解耦，可以后续迭代引入。

### 实现优先级

| 优先级 | 修改 | 影响文件 | 效果 |
|--------|------|---------|------|
| P0 | 修改 1：ensureFreshConnection 条件重连 | remote-deploy.service.ts | 消除不必要的 disconnect 调用 |
| P0 | 修改 2：SSHManager 命令队列 | ssh-manager.ts | 防止并发 exec 互相踩 |
| P1 | 修改 3：健康监控独立实例（可选） | remote-deploy.service.ts | 进一步隔离业务与监控 |

## 影响范围
- [ ] 涉及 API 变更 → 无，修复内部 SSH 连接管理，不暴露新 IPC 端点
- [ ] 涉及数据结构变更 → 无
- [x] 涉及功能设计变更 → modules/remote-agent/features/remote-deploy/design.md

## 验证方式
1. 添加并连接一个远程服务器，确认 proxy 正常运行
2. 等待健康监控执行至少一轮（30s 后），确认日志无 "Not connected" 报错
3. 在健康监控运行期间，触发 skill 下载操作，确认两者不互相干扰
4. 在健康监控运行期间，触发 Agent 部署操作，确认两者不互相干扰
5. 模拟网络断连场景：断开远程服务器网络 10s 后恢复，确认 `ensureConnected` 能自动重连
6. 长时间运行测试：连续 5 分钟同时运行健康监控 + 业务操作，确认无报错
7. 检查 `SSHManager.disconnect()` 的调用方，确认所有调用方要么被移除、要么等待当前操作完成

## 变更
| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-17 | 初始 PRD | @moonseeker1 |
