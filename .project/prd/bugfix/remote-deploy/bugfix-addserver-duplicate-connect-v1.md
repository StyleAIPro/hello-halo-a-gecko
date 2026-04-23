# Bugfix: addServer 后前端重复调用 connectServer 导致连接竞态

## 元信息

- **时间**: 2026-04-22
- **状态**: done
- **优先级**: P1
- **指令人**: StyleAIPro
- **影响范围**: 前端（RemoteServersSection）
- **PRD 级别**: bugfix

## 问题描述

在 RemoteServersSection 中点击添加远程服务器后，前端在 `handleAddServer` 中连续触发两次连接操作：

1. `api.remoteServerAdd(serverInput)` — 后端 `addServer()` 内部已经调用了 `connectServer(id)`（第 496 行）并在后台启动了 `autoDetectAndDeploy(id)`
2. `addServer` 返回成功后，前端又调用 `await api.remoteServerConnect(result.data.id)` — 这是多余的第二连接

两次连接会产生竞态风险：后台 `autoDetectAndDeploy` 正在执行端口分配、检测、部署、代理启动等流程，前端的 `remoteServerConnect` 再次调用 `connectServer` 可能与之冲突，导致连接状态不一致或重复操作。

## 根因分析

### 调用链路

```
前端 handleAddServer()
├─ api.remoteServerAdd(serverInput)
│  └─ 后端 addServer()
│     ├─ connectServer(id)          ← 第 496 行，SSH 连接
│     └─ autoDetectAndDeploy(id)    ← 第 514 行，后台异步：端口分配 + 检测 + 部署 + 代理启动
├─ loadServers()
├─ api.remoteServerConnect(id)      ← 第 564 行，多余的重复连接！
└─ loadServers()
```

### 问题所在

`addServer()` 方法（`remote-deploy.service.ts` 第 456-519 行）已经完整处理了：
- SSH 连接建立（`connectServer(id)` 第 496 行）
- 后台自动部署流程（`autoDetectAndDeploy(id)` 第 514 行）

前端 `handleAddServer`（`RemoteServersSection.tsx` 第 562-564 行）在 `addServer` 成功后再次调用 `api.remoteServerConnect()`，属于冗余操作。

### 具体代码位置

**前端（冗余调用）** — `RemoteServersSection.tsx` 第 562-564 行：
```typescript
// Auto-connect the newly added server
console.log('[RemoteServersSection] Auto-connecting newly added server:', result.data.id);
await api.remoteServerConnect(result.data.id);
```

**后端（已在 addServer 内部连接）** — `remote-deploy.service.ts` 第 496 行：
```typescript
await this.connectServer(id);
```

## 技术方案

删除 `RemoteServersSection.tsx` `handleAddServer` 中多余的 `remoteServerConnect` 调用及其后续的延迟 reload。

具体改动：

1. 删除第 562-564 行的 `api.remoteServerConnect(result.data.id)` 调用及相关日志
2. 删除第 566-568 行因冗余 connect 而添加的延迟 reload（`setTimeout + loadServers`）
3. 保留第 556 行的首次 `loadServers()`，因为需要刷新服务器列表以展示新添加的卡片

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/renderer/components/settings/RemoteServersSection.tsx` | 修改 | 删除 handleAddServer 中冗余的 remoteServerConnect 调用及延迟 reload |

## 开发前必读

- `src/main/services/remote-deploy/remote-deploy.service.ts` — addServer() 方法（第 456-519 行），理解内部已包含 connectServer + autoDetectAndDeploy
- `src/renderer/components/settings/RemoteServersSection.tsx` — handleAddServer 函数（约第 520-590 行），定位冗余调用
- `.project/modules/remote-deploy/design.md` — 远程部署模块设计

## 验收标准

- [ ] 添加新服务器后，`remoteServerConnect` 仅在 `addServer` 内部被调用一次，前端不再重复调用
- [ ] 添加服务器流程正常：SSH 连接 → 自动检测 → 部署 → 代理启动，功能不受影响
- [ ] 服务器列表正常刷新，新卡片正确展示
- [ ] `npm run typecheck && npm run lint && npm run build` 通过
