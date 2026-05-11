# PRD [Bug 修复级] — 创建远程空间时不校验工作目录是否存在

> 版本：bugfix-remote-space-dir-check-v1
> 日期：2026-05-10
> 指令人：@moonseeker
> 归属模块：modules/space、modules/remote-agent
> 严重程度：Major
> 状态：done

## 问题描述

- **期望行为**：创建远程空间时，如果用户指定的工作目录（`remotePath`）在远程服务器上不存在，应在创建阶段提前校验并给出用户友好的提示，支持一键自动创建目录。
- **实际行为**：创建远程空间时不校验 `remotePath` 是否存在，错误仅在后续发送消息时才暴露，且是 Claude SDK 子进程抛出的通用错误信息，用户无法理解具体原因。
- **复现步骤**：
  1. 打开创建空间对话框，选择"远程"类型
  2. 选择一台已部署 Agent 的远程服务器
  3. 在"工作目录"输入一个远程服务器上不存在的路径（如 `/home/test/nonexistent`）
  4. 点击创建 — 创建成功，无任何错误
  5. 进入该空间，发送一条消息
  6. 收到来自 Claude SDK 的通用错误，提示模糊，用户无法定位问题

## 根因分析

创建远程空间的完整链路：

1. **前端** `src/renderer/pages/HomePage.tsx` 第 715-727 行：用户填写 `remotePath`，默认值 `/home`，无前端校验
2. **IPC** `src/main/ipc/space.ts` 第 62-105 行 `space:create` handler：仅校验服务器存在、SDK 已安装、Proxy 运行中，**不校验 `remotePath`**
3. **服务层** `space.service.ts` `createSpace()`：直接存储 `remotePath`，不做远程校验
4. **运行时** `send-message-remote.ts`：将 `remotePath` 作为 `workDir` 传给远程 Proxy
5. **远程 Proxy** `packages/remote-agent-proxy/src/server.ts`：Claude SDK 以不存在的 `workDir` 启动，产生通用错误

**根因**：`space:create` handler 缺少远程目录存在性校验环节，现有的 `fs:*` 消息类型（`fs:list`、`fs:read` 等）都需要活跃的 SDK session，无法用于创建前的预检场景。

## 修复方案

### 核心思路

在远程 Agent Proxy 上新增 **无 session 依赖** 的 `fs:stat` 和 `fs:mkdir` 消息类型，客户端新增对应的请求方法，IPC handler 在创建远程空间前通过 WebSocket 临时连接远程服务器校验目录是否存在，不存在时返回特定错误码让前端弹出确认对话框。

### 流程变更

```
当前流程:
  前端 → IPC space:create → 校验服务器就绪 → createSpace() → 返回成功

修复后流程:
  前端 → IPC space:create → 校验服务器就绪
       → WebSocket 连接远程服务器 → fs:stat(remotePath)
       → 目录存在 → createSpace() → 返回成功
       → 目录不存在 → 返回 { success: false, error: 'REMOTE_DIR_NOT_FOUND', data: { remotePath } }
         → 前端弹出确认对话框 "目录 {remotePath} 不存在，是否自动创建？"
           → 用户确认 → IPC space:create-dir → fs:mkdir(remotePath) → 重试 space:create
           → 用户取消 → 不做任何操作
```

### 文件变更

#### 1. 远程 Agent Proxy — 消息类型定义

**文件**：`packages/remote-agent-proxy/src/types.ts`

在 `ClientMessage.type` 联合类型中新增：
- `'fs:stat'` — 检查路径是否存在及其类型
- `'fs:mkdir'` — 递归创建目录

在 `ServerMessage.type` 联合类型中新增：
- `'fs:stat:result'` — stat 检查结果
- `'fs:mkdir:result'` — mkdir 操作结果

在 `ClientMessage.payload` 中增加对应字段：
- `path?: string` — `fs:stat` 和 `fs:mkdir` 共用

在 `ServerMessage.data` 中增加对应字段：
- `fs:stat:result` 的 `data`：`{ exists: boolean, isDirectory: boolean }`
- `fs:mkdir:result` 的 `data`：`{ success: boolean, error?: string }`

#### 2. 远程 Agent Proxy — 消息处理

**文件**：`packages/remote-agent-proxy/src/server.ts`

在 `handleMessage()` 方法中（约第 458 行 `fs:list` 判断之前），新增两个分支：

```typescript
// fs:stat — 无需 session，直接用 Node.js fs 模块检查
} else if (message.type === 'fs:stat') {
  const path = message.payload?.path
  if (!path) {
    this.sendMessage(ws, {
      type: 'fs:stat:result',
      data: { exists: false, isDirectory: false, error: 'Path is required' }
    })
    return
  }
  try {
    const stat = fs.statSync(path)
    this.sendMessage(ws, {
      type: 'fs:stat:result',
      data: { exists: true, isDirectory: stat.isDirectory() }
    })
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      this.sendMessage(ws, {
        type: 'fs:stat:result',
        data: { exists: false, isDirectory: false }
      })
    } else {
      this.sendMessage(ws, {
        type: 'fs:stat:result',
        data: { exists: false, isDirectory: false, error: err.message }
      })
    }
  }

// fs:mkdir — 无需 session，递归创建目录
} else if (message.type === 'fs:mkdir') {
  const path = message.payload?.path
  if (!path) {
    this.sendMessage(ws, {
      type: 'fs:mkdir:result',
      data: { success: false, error: 'Path is required' }
    })
    return
  }
  try {
    fs.mkdirSync(path, { recursive: true })
    this.sendMessage(ws, {
      type: 'fs:mkdir:result',
      data: { success: true }
    })
  } catch (err: any) {
    this.sendMessage(ws, {
      type: 'fs:mkdir:result',
      data: { success: false, error: err.message }
    })
  }
```

**注意**：`fs:stat` 和 `fs:mkdir` 不需要 sessionId，它们是系统级操作而非 SDK 会话操作。但仅认证后的客户端可调用（已有 `message.type !== 'auth' && !client.authenticated` 拦截）。

#### 3. 客户端 WebSocket 类型定义

**文件**：`src/main/services/remote/ws/ws-types.ts`

在 `ClientMessage.type` 联合类型中新增：
- `'fs:stat'`
- `'fs:mkdir'`

在 `ServerMessage.type` 联合类型中新增：
- `'fs:stat:result'`
- `'fs:mkdir:result'`

#### 4. 客户端 WebSocket 客户端 — 新增请求方法

**文件**：`src/main/services/remote/ws/remote-ws-client.ts`

新增两个基于 Promise 的方法（区别于现有的 fire-and-forget 的 `listFs` 等方法）：

```typescript
/**
 * Check if a path exists on the remote server and whether it's a directory.
 * Does NOT require an SDK session.
 */
statPath(path: string): Promise<{ exists: boolean; isDirectory: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('fs:stat request timed out (10s)'));
    }, 10_000);

    const handler = (data: any) => {
      clearTimeout(timeout);
      this.off('fs:stat:result', handler);
      resolve(data);
    };

    this.once('fs:stat:result', handler);
    this.send({ type: 'fs:stat', payload: { path } });
  });
}

/**
 * Create a directory on the remote server (recursive).
 * Does NOT require an SDK session.
 */
mkdir(path: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('fs:mkdir request timed out (10s)'));
    }, 10_000);

    const handler = (data: any) => {
      clearTimeout(timeout);
      this.off('fs:mkdir:result', handler);
      resolve(data);
    };

    this.once('fs:mkdir:result', handler);
    this.send({ type: 'fs:mkdir', payload: { path } });
  });
}
```

需要在 `handleMessage()` 的消息路由中添加 `fs:stat:result` 和 `fs:mkdir:result` 的事件转发：

```typescript
// 在 handleMessage() 的 switch/if-else 中新增：
} else if (message.type === 'fs:stat:result' || message.type === 'fs:mkdir:result') {
  this.emit(message.type, message.data);
}
```

#### 5. IPC Handler — 远程目录校验

**文件**：`src/main/ipc/space.ts`

在 `space:create` handler（第 76-105 行）中，在校验服务器就绪之后、调用 `createSpace()` 之前，新增远程目录校验逻辑：

```typescript
if (input.claudeSource === 'remote' && input.remoteServerId && input.remotePath) {
  // ... 现有校验（server 存在、sdkInstalled、proxyRunning）...

  // 远程目录存在性校验
  const { acquireConnection, releaseConnection } = await import('../services/remote/ws/remote-ws-client');
  const { sshTunnelService } = await import('../services/remote/ssh/ssh-tunnel.service');

  let client: any = null;
  try {
    // 获取服务器配置以构建连接参数
    const server = remoteDeployService.getServer(input.remoteServerId);
    const serverConfig = {
      serverId: input.remoteServerId,
      host: server.host,
      port: server.assignedPort || 30000,
      authToken: server.authToken,
      useSshTunnel: true, // 使用 SSH 隧道以确保可连接
    };

    // 建立 SSH 隧道（如需要）
    if (serverConfig.useSshTunnel) {
      const localPort = await sshTunnelService.establishTunnel({
        serverId: input.remoteServerId,
        host: server.host,
        port: server.sshPort,
        username: server.username,
        password: server.password,
        remotePort: serverConfig.port,
      });
      serverConfig.port = localPort;
    }

    // 临时创建客户端连接
    const { RemoteWsClient } = await import('../services/remote/ws/remote-ws-client');
    client = new RemoteWsClient(serverConfig);
    await client.connect();

    const statResult = await client.statPath(input.remotePath);
    await client.disconnect();

    if (!statResult.exists || !statResult.isDirectory) {
      return {
        success: false,
        error: 'REMOTE_DIR_NOT_FOUND',
        data: { remotePath: input.remotePath },
      };
    }
  } catch (error: any) {
    // 连接失败时不应阻止创建（网络波动等场景）
    console.warn('[SpaceIPC] Remote dir check failed (non-blocking):', error.message);
  } finally {
    if (client) {
      try { await client.disconnect(); } catch {}
    }
  }
}
```

**新增 IPC 通道 `space:create-dir`**：

```typescript
wrapIpcHandle(
  'space:create-dir',
  async (_event, input: { remoteServerId: string; remotePath: string }) => {
    try {
      const server = remoteDeployService.getServer(input.remoteServerId);
      if (!server) {
        return { success: false, error: 'Remote server not found' };
      }

      // 建立连接并创建目录（逻辑同上，复用连接建立代码）
      const { sshTunnelService } = await import('../services/remote/ssh/ssh-tunnel.service');
      const serverConfig = {
        serverId: input.remoteServerId,
        host: server.host,
        port: server.assignedPort || 30000,
        authToken: server.authToken,
        useSshTunnel: true,
      };

      if (serverConfig.useSshTunnel) {
        const localPort = await sshTunnelService.establishTunnel({
          serverId: input.remoteServerId,
          host: server.host,
          port: server.sshPort,
          username: server.username,
          password: server.password,
          remotePort: serverConfig.port,
        });
        serverConfig.port = localPort;
      }

      const { RemoteWsClient } = await import('../services/remote/ws/remote-ws-client');
      const client = new RemoteWsClient(serverConfig);
      await client.connect();

      try {
        const result = await client.mkdir(input.remotePath);
        return { success: result.success, error: result.error };
      } finally {
        await client.disconnect();
      }
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  },
);
```

**优化建议**：将"建立远程连接"的逻辑抽取为公共函数 `createTempRemoteClient(serverId)` 供 `space:create` 和 `space:create-dir` 共用，避免代码重复。

#### 6. Preload 脚本

**文件**：`src/preload/index.ts`

新增暴露 `space:create-dir` IPC 通道。

#### 7. 前端 API 层

**文件**：`src/renderer/api/transport.ts`

在 `methodMap` 中新增 `space:create-dir`。

**文件**：`src/renderer/api/index.ts`

新增 `createRemoteDir` 方法导出。

#### 8. 前端页面 — 确认对话框

**文件**：`src/renderer/pages/HomePage.tsx`

修改 `handleCreateSpace` 函数（第 197-216 行）：

```typescript
const handleCreateSpace = async () => {
  if (!newSpaceName.trim()) return;

  const input: CreateSpaceInput = {
    name: newSpaceName.trim(),
    icon: newSpaceIcon,
    customPath: useCustomPath && customPath ? customPath : undefined,
    claudeSource,
    remoteServerId: claudeSource === 'remote' ? remoteServerId : undefined,
    remotePath: claudeSource === 'remote' ? remotePath : undefined,
    useSshTunnel: claudeSource === 'remote' ? useSshTunnel : undefined,
    systemPrompt: claudeSource === 'remote' ? systemPrompt : undefined,
  };

  const result = await createSpace(input);

  if (!result && /* 检测 REMOTE_DIR_NOT_FOUND 错误 */) {
    // 弹出确认对话框：目录不存在，是否自动创建？
    const confirmed = window.confirm(
      `Directory "${remotePath}" does not exist on the remote server. Create it?`
    );
    if (confirmed) {
      // 调用 space:create-dir 创建目录
      // 创建成功后重试 createSpace
    }
    return;
  }

  if (result) {
    resetDialog();
  }
};
```

**注意**：对话框文案需使用 `t()` 国际化，确认对话框应使用项目内的 UI 组件（而非 `window.confirm`），保持与整体 UI 风格一致。需在 `src/renderer/i18n/` 相关文件中添加新的翻译 key。

## 开发前必读

| 分类 | 文件路径 | 阅读目的 |
|------|---------|---------|
| 模块设计文档 | `.project/modules/remote-agent/remote-agent-v1.md` | 理解 Remote Agent 模块架构、WebSocket 通信层、SSH 隧道层 |
| 模块设计文档 | `.project/modules/remote-agent/features/websocket-client/design.md` | 理解 RemoteWsClient 连接流程、消息路由、事件机制 |
| 模块设计文档 | `.project/modules/space/space-management-v1.md` | 理解 Space 管理模块架构、IPC 通道定义 |
| 功能变更记录 | `.project/modules/remote-agent/features/websocket-client/changelog.md` | 了解 WebSocket 客户端最近变更，避免回归 |
| 源码文件 | `packages/remote-agent-proxy/src/types.ts` | 理解 ClientMessage/ServerMessage 类型定义，新增消息类型 |
| 源码文件 | `packages/remote-agent-proxy/src/server.ts` (handleMessage ~第 403-470 行) | 理解消息路由逻辑，新增 fs:stat/fs:mkdir 分支 |
| 源码文件 | `src/main/services/remote/ws/ws-types.ts` | 理解客户端消息类型定义，同步新增类型 |
| 源码文件 | `src/main/services/remote/ws/remote-ws-client.ts` | 理解 connect/send/事件机制，新增 statPath/mkdir 方法 |
| 源码文件 | `src/main/ipc/space.ts` (space:create handler ~第 62-105 行) | 理解创建空间 IPC 流程，新增目录校验 |
| 源码文件 | `src/renderer/pages/HomePage.tsx` (handleCreateSpace ~第 197-216 行) | 理解前端创建空间流程，新增错误处理和确认对话框 |
| 源码文件 | `src/renderer/stores/space.store.ts` (createSpace ~第 106-128 行) | 理解 createSpace store 方法的错误处理 |
| 源码文件 | `src/preload/index.ts` | 理解 preload 暴露方式，新增 space:create-dir |
| 源码文件 | `src/renderer/api/transport.ts` | 理解 methodMap 注册，新增 space:create-dir |
| 源码文件 | `src/renderer/api/index.ts` | 理解 api 对象导出，新增 createRemoteDir |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、IPC 通道常量化、错误处理规范 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `packages/remote-agent-proxy/src/types.ts` | 修改 | ClientMessage type 新增 `fs:stat`、`fs:mkdir` |
| `packages/remote-agent-proxy/src/server.ts` | 修改 | handleMessage() 新增 `fs:stat` 和 `fs:mkdir` 分支（session-less） |
| `src/main/services/remote/ws/ws-types.ts` | 修改 | ClientMessage type 同步新增 |
| `src/main/services/remote/ws/remote-ws-client.ts` | 修改 | 新增 Promise 化 `statPath()` 和 `mkdir()` 方法 |
| `src/main/ipc/space.ts` | 修改 | 新增 `createTempRemoteClient` 辅助函数；space:create 新增远程目录校验；新增 space:create-dir handler |
| `src/preload/index.ts` | 修改 | 暴露 space:create-dir IPC 通道 |
| `src/renderer/api/index.ts` | 修改 | 导出 createRemoteDir 方法 |
| `src/renderer/stores/space.store.ts` | 修改 | createSpace 返回类型改为 `{ space? } | { error, data? }` |
| `src/renderer/pages/HomePage.tsx` | 修改 | handleCreateSpace 新增 REMOTE_DIR_NOT_FOUND 确认对话框逻辑 |

## 验收标准

- [ ] 创建远程空间时，如果 `remotePath` 在远程服务器上不存在，弹出确认对话框提示用户
- [ ] 确认对话框文案已国际化（i18n）
- [ ] 用户确认后自动创建目录并成功创建空间
- [ ] 用户取消后不创建空间，无报错
- [ ] 如果 `remotePath` 已存在且是目录，正常创建空间，无多余弹窗
- [ ] 如果 `remotePath` 已存在但是文件（非目录），给出明确错误提示
- [ ] 远程目录校验失败（如网络问题）时，不阻止空间创建（非阻塞降级）
- [ ] `fs:stat` 和 `fs:mkdir` 仅认证后的客户端可调用
- [ ] TypeScript 类型检查通过（`npm run typecheck`）
- [ ] 构建通过（`npm run build`）
- [ ] 国际化提取和翻译通过（`npm run i18n`）
