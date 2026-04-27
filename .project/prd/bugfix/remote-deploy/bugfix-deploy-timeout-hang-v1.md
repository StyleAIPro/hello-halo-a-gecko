# PRD [Bug 修复级] — 远程部署 SSH 超时缺失导致操作卡死 + 离线部署架构选择无校验

> 版本：bugfix-deploy-timeout-hang-v1
> 日期：2026-04-27
> 指令人：@MoonSeeker
> 反馈人：@MoonSeeker
> 归属模块：modules/remote-agent
> 严重程度：Critical
> 状态：done

## 问题描述

本 PRD 覆盖三个相互关联的远程部署问题，根因均为 SSH 操作缺少超时保护或预检校验。

### BUG-1：离线部署选错架构（arm64/x64）无预检

- **期望行为**：离线部署前自动检测远端服务器 CPU 架构，若用户选择的架构与实际不符，应立即报错并阻止上传。
- **实际行为**：`deployAgentCodeOffline()` 直接接受 UI 传入的 `platform` 参数（默认 `'x64'`），不对远端服务器实际架构做校验。用户在 ARM 服务器上选择 x64 离线包时，约 50MB 的离线包上传并解压均成功，直到 `node --version` 才报出晦涩的 "Exec format error"。若服务器离线，后续回退到在线部署也会失败。
- **复现步骤**：
  1. 添加一台 ARM 架构（aarch64）的远程服务器
  2. UI 中默认 deployPlatform 为 `'x64'`（`RemoteServersSection.tsx:81`）
  3. 点击离线部署
  4. 观察：~50MB 离线包上传成功、解压成功
  5. `node --version` 执行时报 "Exec format error"
  6. 回退到在线部署，若服务器离线则二次失败

### BUG-2：添加服务器操作卡死

- **期望行为**：添加服务器时，若 SSH 连接或命令执行失败/超时，应在合理时间后返回错误，UI 正常提示。
- **实际行为**：SSH 命令执行无超时，Promise 仅在 SSH stream `close` 事件时 resolve。若连接静默断开或命令挂起，Promise 永不 resolve，UI 无限等待。更严重的是，`_operationLock`（`ssh-manager.ts:33-49`）串行化所有 SSH 操作，一个挂起的操作会阻塞后续所有操作（包括 `disconnect()`），形成死锁。
- **复现步骤**：
  1. 添加一台远程服务器，SSH 连接建立
  2. 网络异常（防火墙丢包、中间路由超时等），SSH 连接进入半开状态
  3. 触发添加服务器流程，执行 `ensureSshConnectionHealthy`（`remote-deploy.service.ts:731`）中的 `echo ok`
  4. `echo ok` 无超时，Promise 挂起
  5. 用户尝试断开连接 → `disconnect()` 排在 `_operationLock` 后面 → 死锁
  6. UI 永远显示"正在连接..."或空白状态

### BUG-3：更新卡在 50%

- **期望行为**：部署/更新操作中的 npm install 等长命令应有超时保护和进度反馈，卡住时用户可手动取消。
- **实际行为**：更新流程在 50% 处（`deployAgentCode` L1118 npm config 和 L1131 rm -rf node_modules）之后的 npm install（L1140-1149）通过 `executeCommandStreaming` 执行，无超时保护。`UpdateOperationState` 无 TTL/看门狗，`inProgress: true` 永久持续。UI 无取消按钮。
- **复现步骤**：
  1. 对远程服务器执行更新操作
  2. 进度条到达 50%（npm install 开始）
  3. npm install 因网络问题挂起（如 registry 不可达、依赖解析死锁）
  4. 进度条永久停在 50%，无任何超时或错误反馈
  5. 用户无法取消操作，只能强杀应用

## 根因分析

### 根因 1：`SSHManager` 三个执行方法无超时保护

`src/main/services/remote-ssh/ssh-manager.ts` 中：

- `executeCommand()`（L136-178）：Promise 仅在 stream `close` 事件时 resolve/reject，无超时
- `executeCommandFull()`（L183-221）：同上，无超时
- `executeCommandStreaming()`（L228+）：同上，无超时

三个方法均被 `withLock()` 包装（L137、L184、L232），在 `withLock` 内部创建无超时的 `new Promise()`。若 SSH 连接静默断开（非 error 事件），stream 永远不会触发 `close` 或 `error` 事件，Promise 永不 resolve。

**对比**：`remote-deploy.service.ts:3728` 已有 `executeWithTimeout()` 辅助方法，但仅在 `installRemoteSkill` 流程中使用（L3811、L3951、L4004、L4255），部署/更新流程未使用。

### 根因 2：`_operationLock` 不可中断，`disconnect()` 排队等待

`ssh-manager.ts:33-49` 的 `withLock` 实现中，`disconnect()`（L663）通过 `this._operationLock.then(doDisconnect, doDisconnect)` 排在操作队列后面。如果当前有挂起的操作（如无超时的 `executeCommand`），`disconnect()` 永远得不到执行，形成死锁。

```typescript
// ssh-manager.ts L662-663
this._operationLock = this._operationLock.then(doDisconnect, doDisconnect);
```

### 根因 3：`deployAgentCodeOffline()` 无架构预检

`remote-deploy.service.ts:4348` 的 `deployAgentCodeOffline()` 接受 UI 传入的 `platform` 参数后，直接定位离线包并上传（L4360-4394），未检测远端 CPU 架构。对比在线部署 `deployAgentCode()` 在 L978 通过 `uname -m` 检测架构来安装正确版本的 Node.js。

UI 侧 `RemoteServersSection.tsx:81` 默认值为 `'x64'`，用户手动切换无任何验证。

### 根因 4：`UpdateOperationState` 无 TTL，`startUpdate` 无看门狗

`remote-deploy.service.ts:187-189` 的 `startUpdate()` 仅设置 `{ inProgress: true }`，无超时时间戳。`completeUpdate()` 和 `failUpdate()` 仅在正常流程结束时调用。若操作挂起，`inProgress` 永久为 `true`，UI 无法恢复。

### 根因 5：IPC 层无超时，UI 无取消机制

`src/main/ipc/remote-server.ts:63` 的 `remote-server:add` handler 调用 `deployService.addServer(input)` 无超时保护。IPC 使用 `ipcMain.handle`，返回 Promise，UI 端无限等待。`RemoteServersSection.tsx` 无取消按钮。

### 关键挂起点（添加服务器流程）

| 步骤 | 位置 | 无超时的 SSH 调用 |
|------|------|------------------|
| 连接健康检查 | `ensureSshConnectionHealthy` L731 | `executeCommand('echo ok')` |
| 端口分配 | `port-allocator.ts` L61-84 | 最多 20 次 `executeCommandFull` 循环（每次检测端口占用） |
| 部署健康检查 | `deployAgentCode` L946 | `ensureSshConnectionHealthy` |
| npm install | `deployAgentCode` L1140 | `executeCommandStreaming` |

## 修复方案

### 修改 1：SSH 命令默认超时（P0）

**文件**：`src/main/services/remote-ssh/ssh-manager.ts`

为三个执行方法添加默认超时参数：

```typescript
// executeCommand 和 executeCommandFull 默认 30s
async executeCommand(command: string, options?: { timeoutMs?: number }): Promise<string> {
  const timeout = options?.timeoutMs ?? 30_000;
  return this.withLock(async () => {
    // ... 现有逻辑 ...
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => {
        stream.destroy(); // 终止 SSH stream
        reject(new Error(`SSH command timed out after ${timeout / 1000}s: ${command.slice(0, 100)}`));
      }, timeout),
    );
    return Promise.race([commandPromise, timeoutPromise]);
  });
}
```

类似地为 `executeCommandFull()` 和 `executeCommandStreaming()` 添加超时。`executeCommandStreaming` 默认超时更长（600s），适用于 npm install 等长时间操作。

**注意**：超时触发时必须调用 `stream.destroy()` 终止底层 SSH channel，否则远端进程继续运行。

### 修改 2：操作锁可中断（P0）

**文件**：`src/main/services/remote-ssh/ssh-manager.ts`

将 `_operationLock` 改为可中断模式。`disconnect()` 不再排队等待，而是强制关闭底层 socket：

```typescript
disconnect(): void {
  console.log('[SSHManager] disconnect called');
  this._ready = false;

  // 强制关闭底层 socket，不等操作完成
  if (this.client) {
    try {
      this.client.end();
    } catch (e) {
      console.log('[SSHManager] Error closing connection:', e);
    }
    this.client = null;
    this.sftp = null;
    this.config = null;
    this.interactiveShell = null;
  }

  // 重置操作锁，让排队的 Promise 立即 reject
  // 当前挂起的 withLock 内部会因 client=null 而自然失败
}
```

关键变更：移除 `this._operationLock = this._operationLock.then(doDisconnect, doDisconnect)`，改为直接执行断连逻辑。当前挂起的 `withLock` 操作会因 `this.client` 被置为 `null` 而在后续操作中抛出 "Not connected"。

### 修改 3：部署/更新流程使用超时包装（P0）

**文件**：`src/main/services/remote-deploy/remote-deploy.service.ts`

在部署和更新流程的关键 SSH 调用处添加超时保护：

```typescript
// L1118: npm config — 使用 executeWithTimeout
await this.executeWithTimeout(manager, `npm config set registry https://registry.npmmirror.com`, 30_000);

// L1131: rm -rf node_modules — 使用 executeWithTimeout
await this.executeWithTimeout(manager, `rm -rf ${deployPath}/node_modules`, 30_000);

// L1140: npm install — 使用带超时的 streaming 执行
// 为 executeCommandStreaming 添加超时包装
```

需创建 streaming 感知的超时包装器（现有 `executeWithTimeout` 仅支持 `executeCommandFull`）：

```typescript
private async executeStreamingWithTimeout(
  manager: SSHManager,
  command: string,
  timeoutMs: number,
  onOutput: (type: 'stdout' | 'stderr', data: string) => void,
): Promise<SSHExecuteResult> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`SSH streaming command timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      manager.executeCommandStreaming(command, onOutput),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
```

### 修改 4：离线部署 uname -m 架构预检（P1）

**文件**：`src/main/services/remote-deploy/remote-deploy.service.ts`

在 `deployAgentCodeOffline()` 上传离线包之前，增加架构检测：

```typescript
async deployAgentCodeOffline(id: string, platform: 'x64' | 'arm64'): Promise<void> {
  // ... 现有的 server/bundle 检查 ...

  // 新增：架构预检
  this.emitDeployProgress(id, 'prepare', '正在检测远端服务器架构...', 8);
  const archResult = await manager.executeCommand('uname -m');
  const detectedArch = archResult.trim(); // "x86_64" 或 "aarch64"

  const expectedArch = platform === 'x64' ? 'x86_64' : 'aarch64';
  if (detectedArch !== expectedArch) {
    throw new Error(
      `远端服务器为 ${detectedArch} 架构，但选择了 ${platform} 离线包。` +
      `请选择 ${detectedArch === 'x86_64' ? 'x64' : 'arm64'} 离线包后重试。`,
    );
  }

  // 架构匹配，继续上传...
  this.emitCommandOutput(id, 'output', `架构确认: ${detectedArch} (${platform}) ✓`);

  // ... 后续上传逻辑 ...
}
```

### 修改 5：UI 架构自动检测 + 显示（P1）

**文件**：`src/shared/types/index.ts`、`src/renderer/components/settings/RemoteServersSection.tsx`

1. 在 `RemoteServer` 接口中添加 `detectedArch` 字段：

```typescript
export interface RemoteServer {
  // ... 现有字段 ...
  detectedArch?: 'x64' | 'arm64'; // 远端服务器实际检测到的 CPU 架构
}
```

2. 在连接成功后自动检测架构（`addServer` 或 `connectServer` 流程中），将结果存入 `server.detectedArch` 并通过 `statusCallbacks` 通知 UI。

3. UI 连接服务器后显示远端架构信息，并根据 `detectedArch` 自动预选 `deployPlatform`：

```typescript
// RemoteServersSection.tsx
const [deployPlatform, setDeployPlatform] = React.useState<'x64' | 'arm64'>(
  server?.detectedArch ?? 'x64'
);
```

### 修改 6：操作看门狗 + 取消按钮（P1）

**文件**：`src/main/services/remote-deploy/remote-deploy.service.ts`、`src/main/ipc/remote-server.ts`、`src/preload/index.ts`、`src/renderer/api/transport.ts`、`src/renderer/api/index.ts`、`src/renderer/components/settings/RemoteServersSection.tsx`

1. 在 `startUpdate()` 中记录开始时间，添加看门狗定时器：

```typescript
private static readonly OPERATION_MAX_DURATION_MS = 10 * 60 * 1000; // 10 分钟
private operationWatchdogs: Map<string, ReturnType<typeof setTimeout>> = new Map();

startUpdate(id: string): void {
  this.updateOperations.set(id, { inProgress: true, _startedAt: Date.now() });

  // 看门狗：超时自动标记失败
  const watchdog = setTimeout(() => {
    const op = this.updateOperations.get(id);
    if (op?.inProgress) {
      this.failUpdate(id, `操作超时（超过 ${this.OPERATION_MAX_DURATION_MS / 1000}s 未完成）`);
    }
  }, RemoteDeployService.OPERATION_MAX_DURATION_MS);

  this.operationWatchdogs.set(id, watchdog);
}
```

2. 添加取消操作的 IPC 通道：

```typescript
// remote-server.ts
ipcMain.handle('remote-server:cancel-operation', async (_event, id: string) => {
  const manager = deployService.getSSHManager(id);
  if (manager) {
    manager.disconnect(); // 强制断开，中断挂起的操作
  }
  deployService.failUpdate(id, '用户取消了操作');
  return { success: true };
});
```

3. Preload 和 API 层暴露取消接口。

4. UI 在部署/更新进行中显示取消按钮：

```typescript
{updateStatus?.inProgress && (
  <button onClick={() => api.cancelOperation(server.id)}>
    取消操作
  </button>
)}
```

### 修改 7：端口分配使用超时命令（P0）

**文件**：`src/main/services/remote-deploy/port-allocator.ts`

`resolvePort()` 内部的 `isPortFree()` 和 `isPortOwnedByClient()` 各调用 `executeCommandFull`，最多循环 20 次。需确保这些调用使用超时。由于修改 1 已为 `executeCommandFull` 添加默认 30s 超时，此处自动受益。但 20 次 × 30s = 最长 600s 的极端情况仍需防范，可在 `resolvePort` 层面加总超时：

```typescript
export async function resolvePort(sshManager: SSHManager, clientId: string): Promise<number> {
  // ... 现有逻辑 ...
  const totalTimeout = setTimeout(() => {
    throw new Error(`端口分配超时：${maxAttempts} 次尝试在 ${maxAttempts * 30}s 内未完成`);
  }, 120_000); // 总超时 2 分钟
  try {
    // ... 端口分配循环 ...
  } finally {
    clearTimeout(totalTimeout);
  }
}
```

## 实现优先级

| 优先级 | 修改 | 影响文件 | 效果 |
|--------|------|---------|------|
| P0 | SSH 命令默认超时 | ssh-manager.ts | 所有 SSH 操作有超时保护，不再无限挂起 |
| P0 | 操作锁可中断 | ssh-manager.ts | disconnect() 强制断开，不排队等待 |
| P0 | 部署/更新流程使用超时包装 | remote-deploy.service.ts | npm install 等长操作有超时 |
| P0 | 端口分配总超时 | port-allocator.ts | 防止 20 次端口检测的极端累积 |
| P1 | 离线部署 uname -m 架构预检 | remote-deploy.service.ts | 防止选错架构浪费 ~50MB 带宽 |
| P1 | UI 架构自动检测与预选 | RemoteServersSection.tsx, shared/types | 减少用户手动选择出错的概率 |
| P1 | 操作看门狗 + 取消按钮 | remote-deploy.service.ts, remote-server.ts, preload, api, UI | 超时自动失败 + 用户可手动取消 |

## 影响范围

- [x] 涉及 API 变更 → 新增 `remote-server:cancel-operation` IPC 通道
- [x] 涉及数据结构变更 → `RemoteServer` 接口新增 `detectedArch` 字段（向后兼容，可选字段）
- [x] 涉及功能设计变更 → modules/remote-agent/features/remote-deploy/design.md（超时机制、架构预检、取消操作）

## 开发前必读

| 类别 | 文档/文件 | 阅读目的 |
|------|----------|---------|
| 模块设计 | `.project/modules/remote-agent/features/remote-deploy/design.md` | 理解部署流程整体架构 |
| 源码 | `src/main/services/remote-ssh/ssh-manager.ts` | 理解 SSH 执行方法和操作锁实现 |
| 源码 | `src/main/services/remote-deploy/remote-deploy.service.ts` | 理解部署/更新流程和现有超时工具 |
| 源码 | `src/main/services/remote-deploy/port-allocator.ts` | 理解端口分配逻辑 |
| 源码 | `src/main/ipc/remote-server.ts` | 理解 IPC handler 注册模式 |
| 源码 | `src/shared/types/index.ts` | 理解 RemoteServer 接口定义 |
| 源码 | `src/preload/index.ts` | 理解 API 暴露模式（新增取消接口时参考） |
| 源码 | `src/renderer/api/transport.ts` + `src/renderer/api/index.ts` | 理解前端 API 适配层（新增取消接口时参考） |
| 源码 | `src/renderer/components/settings/RemoteServersSection.tsx` | 理解 UI 状态管理和取消按钮放置 |
| 相关 PRD | `.project/prd/bugfix/remote-agent/bugfix-ssh-concurrent-disconnect-v1.md` | 了解已有的 SSH 并发修复（操作锁即自此 PRD 引入） |
| 相关 PRD | `.project/prd/bugfix/remote-deploy/bugfix-sdk-version-check-v1.md` | 了解已有 PRD 格式和修复模式 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、IPC 通道常量化等 |

## 涉及文件预估

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/services/remote-ssh/ssh-manager.ts` | 修改 | 三个执行方法加超时参数 + 默认值；disconnect() 改为强制断开不排队 |
| `src/main/services/remote-deploy/remote-deploy.service.ts` | 修改 | 部署/更新流程用超时包装；离线架构预检；操作看门狗；新增 streaming 超时工具方法 |
| `src/main/services/remote-deploy/port-allocator.ts` | 修改 | resolvePort 添加总超时 |
| `src/main/ipc/remote-server.ts` | 修改 | 新增 `remote-server:cancel-operation` IPC handler |
| `src/shared/types/index.ts` | 修改 | RemoteServer 接口新增 `detectedArch?: 'x64' \| 'arm64'` |
| `src/shared/constants/` | 修改 | 新增 `REMOTE_SERVER_CANCEL_OPERATION` IPC 通道常量 |
| `src/preload/index.ts` | 修改 | 暴露 cancelOperation API |
| `src/renderer/api/transport.ts` | 修改 | 添加 cancelOperation 方法 |
| `src/renderer/api/index.ts` | 修改 | 导出 cancelOperation |
| `src/renderer/components/settings/RemoteServersSection.tsx` | 修改 | 取消按钮 + 架构自动检测显示 + deployPlatform 联动 |

## 验收标准

- [ ] **AC-1**：SSH 命令默认 30s 超时，超时后抛出明确错误 `SSH command timed out after 30s` 而非卡死
- [ ] **AC-2**：npm install 等长命令使用 600s 超时，超时后自动失败并提示
- [ ] **AC-3**：`disconnect()` 在操作卡死时仍能立即执行，不排队等待挂起的 `_operationLock`
- [ ] **AC-4**：离线部署前自动执行 `uname -m` 检测远端 CPU 架构，选错时立即报错（不先上传 ~50MB 包）
- [ ] **AC-5**：UI 连接服务器后自动显示远端架构信息，`deployPlatform` 根据检测到的架构自动预选
- [ ] **AC-6**：部署/更新操作超过 10 分钟无进度，看门狗自动标记失败
- [ ] **AC-7**：UI 在部署/更新进行中显示取消按钮，点击后中断当前操作并提示"用户取消了操作"
- [ ] **AC-8**：端口分配有总超时保护（建议 2 分钟），不会因 20 次端口检测累积到 10 分钟
- [ ] **AC-9**：现有功能回归 — 在线部署、离线部署（正确架构）、更新操作、添加服务器在正常网络下均正常工作

## 验证方式

### 基础验证

1. **正常部署流程回归**：正常网络环境下，执行添加服务器 → 在线部署 → 更新全流程，确认功能不受影响
2. **正常离线部署回归**：在 x64 服务器上选择 x64 离线包部署，确认流程正常完成
3. **架构预检验证**：在 ARM 服务器上选择 x64 离线包，确认立即报错且未上传离线包

### 超时验证

4. **SSH 超时验证**：模拟网络断连（防火墙 drop），执行添加服务器，确认 30s 内返回超时错误
5. **npm install 超时验证**：配置一个不可达的 npm registry，执行部署，确认 600s 后超时失败
6. **disconnect 中断验证**：在 npm install 执行过程中，点击取消按钮，确认立即断开而非等待
7. **端口分配超时验证**：模拟所有端口被占用（或 SSH 无响应），确认 2 分钟内超时返回

### UI 验证

8. **架构显示验证**：连接服务器后，UI 显示远端架构信息（如 "aarch64"），deployPlatform 自动切换
9. **取消按钮验证**：部署进行中显示取消按钮，点击后操作中断，状态更新为"已取消"
10. **看门狗验证**：模拟操作挂起（无法完成），10 分钟后确认状态自动更新为失败

### 自测命令

```bash
npm run typecheck && npm run lint && npm run build
```

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-27 | 初始 Bug 修复 PRD，覆盖 SSH 超时、操作锁死锁、离线架构预检三个问题 | @MoonSeeker |
