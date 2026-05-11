---
timestamp: 2026-05-11
status: in-progress
assignee: moonseeker
---

# Bugfix: 远程服务器新建/删除 UX 优化

## 问题描述

### 问题 1：新建服务器 SSH 连接失败时无明确通知

用户通过「添加服务器」弹窗提交 SSH 连接信息后，即使 SSH 连接失败，UI 也不会弹出错误提示。具体表现：

1. `addServer()`（`server-manager.ts`）先将服务器记录保存到配置，然后尝试 SSH 连接
2. SSH 连接失败时，服务器状态被设为 `'error'`，但 `addServer()` 仍然返回 `id`（不抛异常）
3. IPC handler（`remote-server.ts:64-76`）始终返回 `{ success: true, data: { id } }`
4. UI（`RemoteServersPage.tsx:281-283`）检测到 `result.success === true` 后仅调用 `loadServers()` 刷新列表，不显示任何错误提示
5. SSH 失败信息仅通过 `deploy-progress` 事件传递，显示在进度卡片中，但该卡片不醒目，容易被忽略

**影响**：用户添加一台连不上的服务器后以为添加成功了，需要手动发现进度卡片里的错误信息。

### 问题 2：删除未连接的服务器时长时间卡住

用户删除一个从未成功连接的服务器（状态为 `error` 或 `disconnected`）时，删除操作会卡住约 30 秒。具体表现：

1. `removeServer()`（`server-manager.ts:495-520`）在删除前始终尝试 SSH 远程清理（停止 agent、删除部署目录）
2. 第 503-506 行：调用 `getSSHManager()` 获取 SSH 管理器，然后 `connectServer(id)` 尝试连接
3. 对于从未成功连接的服务器，`connectServer()` 会尝试建立 SSH 连接并等待 `readyTimeout`（默认 30 秒）后才超时失败
4. 虽然整个远程清理被 try/catch 包裹，不会导致删除失败，但 30 秒的等待让用户误以为操作卡死了

**影响**：用户删除一台连不上的服务器需要等待 30 秒，体验极差。

## 根因分析

### 问题 1 根因

`addServer()` 的设计意图是"先保存记录，后尝试连接，连接失败不阻塞保存"。这个设计是合理的（允许用户稍后重试），但缺少一个机制让 IPC handler 区分"完全成功"和"部分成功（保存成功但连接失败）"两种状态：

- `addServer()` 的返回值只有 `id`（string），没有携带连接结果信息
- IPC handler 不检查服务器最终状态，无条件返回 `success: true`
- UI 完全依赖 IPC 返回值判断是否成功

### 问题 2 根因

`removeServer()` 的远程清理逻辑没有做前置条件检查。它无条件尝试 SSH 连接，而不是先检查服务器当前是否有活跃的 SSH 连接：

```typescript
// server-manager.ts:503-506
const manager = getSSHManager(service, id);
if (!manager.isConnected()) {
  await service.connectServer(id);  // <-- 对 error/disconnected 服务器会卡 30s
}
```

## 技术方案

### 问题 1 修复：addServer 区分完全成功与部分成功

**后端（server-manager.ts）：**

修改 `addServer()` 的返回类型，从 `Promise<string>` 改为 `Promise<{ id: string; sshConnected: boolean; error?: string }>`：

- SSH 连接成功路径：返回 `{ id, sshConnected: true }`
- SSH 连接失败路径（catch 块）：返回 `{ id, sshConnected: false, error: errorMessage }`

**IPC handler（remote-server.ts）：**

修改 `remote-server:add` handler，检查返回的 `sshConnected` 字段：

```typescript
const result = await deployService.addServer(input);
if (result.sshConnected) {
  return { success: true, data: { id: result.id } };
} else {
  // 服务器已保存，但 SSH 连接失败 —— 部分成功
  return { success: true, data: { id: result.id, partial: true, error: result.error } };
}
```

**前端（RemoteServersPage.tsx）：**

修改 `handleAddServer()` 中的结果处理，增加对 `partial` 标记的判断：

```typescript
const result = await api.addRemoteServer(newServer);
if (result.success) {
  const data = result.data as any;
  if (data?.partial) {
    // 显示 toast 提示"服务器已保存，但 SSH 连接失败"
    // 提示用户可以稍后重试
  }
  await loadServers();
  resetForm();
} else {
  // 处理完全失败
}
```

### 问题 2 修复：removeServer 跳过无活跃连接的服务器

**后端（server-manager.ts）：**

修改 `removeServer()` 的远程清理逻辑，在尝试 SSH 操作前先检查是否有活跃连接：

```typescript
export async function removeServer(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) return;

  // 清理 WebSocket 连接池
  removePooledConnection(id);

  // 仅当有活跃 SSH 连接时才执行远程清理
  const manager = (service as any).sshManagers.get(id);
  if (manager && manager.isConnected()) {
    try {
      const deployPath = getDeployPath(server);
      await manager.executeCommand(`pkill -f "node.*${deployPath}" || true`);
      await manager.executeCommand(`rm -rf ${deployPath}`);
      console.debug(`[RemoteDeployService] Cleaned up remote proxy on: ${server.name}`);
    } catch (err) {
      console.warn(`[RemoteDeployService] Remote cleanup failed for ${server.name}:`, err);
    }
  } else {
    console.debug(
      `[RemoteDeployService] Skipping remote cleanup for ${server.name}: no active SSH connection`,
    );
  }

  await service.disconnectServer(id);
  (service as any).servers.delete(id);
  await saveServers(service);
  console.debug(`[RemoteDeployService] Removed server: ${server.name} (${id})`);
}
```

关键变更：
- 不再调用 `connectServer(id)` 尝试建立新连接
- 只检查已有的 SSH manager 是否处于连接状态
- 无活跃连接时直接跳过远程清理，仅做本地清理（断开可能的残留 SSH、从 map 删除、保存配置）

## 开发前必读

| 分类 | 文件路径 | 阅读目的 |
|------|---------|---------|
| 模块设计文档 | `.project/modules/remote-agent/features/remote-deploy/design.md` | 理解 addServer/removeServer 的设计意图和正常/异常流程 |
| 功能 changelog | `.project/modules/remote-agent/features/remote-deploy/changelog.md` | 了解最近变更，特别是 SSH 超时和状态同步相关改动 |
| 功能 bugfix | `.project/modules/remote-agent/features/remote-deploy/bugfix.md` | 了解已知问题，避免重复踩坑 |
| 源码文件 | `src/main/services/remote/deploy/server-manager.ts` | addServer/removeServer 的核心实现，是本次修改的主体 |
| 源码文件 | `src/main/ipc/remote-server.ts` | IPC handler 层，需要修改 add handler 的返回值处理 |
| 源码文件 | `src/renderer/pages/RemoteServersPage.tsx` | 前端 UI 层，需要修改 add server 的结果处理逻辑 |
| 源码文件 | `src/renderer/api/index.ts` | 渲染器 API 层，确认 addRemoteServer 返回类型无需改动（已是 ApiResponse） |

## 涉及文件

| 文件路径 | 修改类型 | 说明 |
|---------|---------|------|
| `src/main/services/remote/deploy/server-manager.ts` | 修改 | addServer 返回值改为对象（含 sshConnected）；removeServer 增加活跃连接检查 |
| `src/main/ipc/remote-server.ts` | 修改 | remote-server:add handler 处理 partial 成功状态 |
| `src/renderer/pages/RemoteServersPage.tsx` | 修改 | handleAddServer 增加部分成功的 toast 提示 |

## 验收标准

### 问题 1：新建服务器 SSH 失败通知

- [ ] 当新建服务器 SSH 连接失败时，UI 显示 toast 提示（如"服务器已保存，但 SSH 连接失败：xxx。可稍后在服务器列表中重试连接。"）
- [ ] 服务器记录仍然保存在列表中（状态为 error），用户可以稍后点击连接重试
- [ ] 当新建服务器 SSH 连接成功时，行为与修改前完全一致（不显示额外提示）
- [ ] 当新建服务器因其他原因完全失败（如配置保存失败），行为与修改前一致（显示错误）

### 问题 2：删除未连接服务器

- [ ] 删除状态为 `error` 的服务器时，操作立即完成（无 30 秒等待）
- [ ] 删除状态为 `disconnected` 且无活跃 SSH 连接的服务器时，操作立即完成
- [ ] 删除状态为 `connected` 的服务器时，仍执行远程清理（停止 agent、删除部署目录）
- [ ] 控制台日志明确记录是否跳过了远程清理（`Skipping remote cleanup`）
- [ ] 远程清理失败时，本地清理（删除记录）仍正常完成
