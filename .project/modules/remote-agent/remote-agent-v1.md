# 模块 — Remote Agent remote-agent-v1

> 版本：remote-agent-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源架构：无（初始版本）

## 职责

提供远程 AI Agent 的完整连接和执行能力，包括 SSH 隧道建立与端口转发、WebSocket 双向通信、远程 Agent 自动部署与启动、会话恢复、MCP 工具桥接和流式事件转发。使本地 AICO-Bot 可以在远程服务器上执行 Claude Code Agent。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    Remote Agent Module                            │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              remote-ws (WebSocket 通信层)                 │    │
│  │                                                          │    │
│  │  ┌──────────────────┐  ┌──────────────────────────────┐ │    │
│  │  │ remote-ws-client  │  │  aico-bot-mcp-bridge         │ │    │
│  │  │ (WS 连接池/事件)  │  │  (本地 MCP 工具注册到远端)    │ │    │
│  │  └──────────────────┘  └──────────────────────────────┘ │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              remote-ssh (SSH 隧道层)                      │    │
│  │                                                          │    │
│  │  ┌──────────────────┐  ┌──────────────────────────────┐ │    │
│  │  │ ssh-tunnel.service│  │  ssh-manager                 │ │    │
│  │  │ (端口转发管理)     │  │  (SSH2 连接管理)              │ │    │
│  │  └──────────────────┘  └──────────────────────────────┘ │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              remote-deploy (部署层)                       │    │
│  │                                                          │    │
│  │  ┌───────────────────────────────────────────────────┐  │    │
│  │  │ remote-deploy.service                             │  │    │
│  │  │ (服务器配置管理、Agent 代码部署、进程启停)          │  │    │
│  │  └───────────────────────────────────────────────────┘  │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘

数据流:
  本地 AICO-Bot
      │
      ├─ SSH 隧道 (ssh-tunnel.service) ── 本地端口转发
      │    ssh -L localhost:LOCAL_PORT:localhost:REMOTE_PORT user@host
      │
      ▼
  WebSocket 连接 (remote-ws-client)
      │
      ├─► claude:chat     → 发送消息到远程 Agent
      ├─◄ claude:stream   ← 接收流式文本
      ├─◄ thought         ← 接收思考过程
      ├─◄ tool:call/result← 接收工具调用
      ├─► mcp:tools:register → 注册本地 MCP 工具
      ├─◄ mcp:tool:call  ← 远端调用本地工具
      └─► mcp:tool:response → 返回工具结果
```

## 对外接口

### IPC Handle 通道（渲染进程 → 主进程）

| 方法 | 通道名 | 输入 | 输出 | 说明 |
|------|--------|------|------|------|
| listServers | `remote-server:list` | 无 | `{ success, data: RemoteServer[] }` | 列出远程服务器 |
| addServer | `remote-server:add` | `RemoteServerConfigInput` | `{ success, data }` | 添加远程服务器 |
| updateServer | `remote-server:update` | `serverId, updates` | `{ success, data }` | 更新服务器配置 |
| deleteServer | `remote-server:delete` | `serverId` | `{ success }` | 删除服务器 |
| connectServer | `remote-server:connect` | `serverId` | `{ success }` | 连接到远程服务器 |
| disconnectServer | `remote-server:disconnect` | `serverId` | `{ success }` | 断开连接 |
| testConnection | `remote-server:test` | `serverId` | `{ success }` | 测试连接 |

### 内部函数（被 send-message.ts 调用）

| 函数 | 输入 | 输出 | 说明 |
|------|------|------|------|
| `RemoteWsClient` 构造 | `RemoteWsClientConfig` | `RemoteWsClient` | 创建 WebSocket 客户端 |
| `acquireConnection` | `serverId, config, conversationId` | `RemoteWsClient` | 获取池化连接 |
| `releaseConnection` | `serverId, conversationId` | `void` | 释放池化连接 |
| `registerActiveClient` | `conversationId, client` | `void` | 注册活跃客户端（用于中断） |
| `sshTunnelService.establishTunnel` | `SshTunnelConfig` | `number` (本地端口) | 建立 SSH 隧道 |
| `sshTunnelService.createReverseTunnel` | 反向隧道配置 | `number` (远程端口) | 建立反向隧道 |
| `deployService.deployAgentCode` | `serverId` | `void` | 部署 Agent 代码到远端 |
| `deployService.startAgent` | `serverId` | `void` | 启动远端 Agent 进程 |

## 内部组件

| 组件 | 职责 | 文件 |
|------|------|------|
| remote-ws-client | WebSocket 客户端（连接池管理、事件收发、消息类型路由、MCP 工具注册） | `services/remote-ws/remote-ws-client.ts` |
| aico-bot-mcp-bridge | MCP 工具桥接（收集本地 MCP 工具定义、处理远端工具调用请求） | `services/remote-ws/aico-bot-mcp-bridge.ts` |
| ssh-tunnel.service | SSH 端口转发服务（动态端口分配、冲突解决、自动清理、健康检查） | `services/remote-ssh/ssh-tunnel.service.ts` |
| ssh-manager | SSH2 连接管理器（连接建立、命令执行、文件操作） | `services/remote-ssh/ssh-manager.ts` |
| remote-deploy.service | 远程部署服务（服务器配置管理、代码部署、进程启停、技能同步、网络预检） | `services/remote-deploy/remote-deploy.service.ts` |
| remote-agent-proxy | 远程 Agent Proxy 独立 Node.js 服务（SDK 集成、WebSocket 服务、运行时 SDK Patch） | `packages/remote-agent-proxy/` |

## 功能列表

| 功能 | 状态 | 文档 |
|------|------|------|
| websocket-client | 已完成 | features/websocket-client/design.md |
| ssh-tunnel | 已完成 | features/ssh-tunnel/design.md |
| remote-deploy | 已完成 | features/remote-deploy/design.md |
| mcp-bridge | 已完成 | features/mcp-bridge/design.md |
| offline-deploy | 已完成 | features/offline-deploy/design.md |

## 绑定的 API

- 无（通过 IPC 通道和内部函数调用暴露接口）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始模块文档 | @moonseeker1 |
| 2026-04-16 | 统一 SDK 版本常量管理（`src/shared/constants/sdk.ts`），清理 0.2.87 遗留物，记录 SDK Patch 机制 | @StyleAIPro |
