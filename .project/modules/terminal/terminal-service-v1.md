# 模块 — 终端服务 terminal-service-v1

> 版本：terminal-service-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源架构：无（初始版本）

## 职责

管理应用内的终端功能，包括终端网关（主进程终端进程管理）、终端工具（SDK Agent 的 shell/bash 工具）、终端输出存储和历史记录。为 AI Agent 和用户界面提供统一的终端操作能力。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                      Terminal Module                             │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐     │
│  │ terminal-gateway│ │ terminal-tools│  │ terminal-history   │     │
│  │ (终端进程网关)  │ │ (SDK 终端工具)│  │ (历史记录存储)      │     │
│  └──────────────┘  └──────────────┘  └────────────────────┘     │
│                                                                  │
│  ┌──────────────────┐  ┌─────────────────────────────────┐      │
│  │ terminal-output   │  │    shared-terminal-service       │      │
│  │ (输出存储)        │  │  (共享终端服务)                   │      │
│  └──────────────────┘  └─────────────────────────────────┘      │
│                                                                  │
│  ┌──────────────────┐                                            │
│  │ terminal.service  │ (终端服务主入口)                           │
│  └──────────────────┘                                            │
└─────────────────────────────────────────────────────────────────┘

外部依赖:
  → agent module (SDK 终端工具集成)
  → remote-ws (远程终端输出转发)
```

## 对外接口

### IPC Handle 通道

| 方法 | 通道名 | 输入 | 输出 | 说明 |
|------|--------|------|------|------|
| getTerminalWebSocketUrl | `system:get-terminal-websocket-url` | 无 | `{ success, data: { url } }` | 获取终端 WebSocket URL |
| getTerminalOutput | `terminal:get-output` | `{ sessionId }` | `{ success, data }` | 获取终端输出 |

### Renderer Event 通道

| 通道名 | 数据 | 说明 |
|--------|------|------|
| `agent:terminal` | `TerminalOutputData` | 终端输出流（Agent SDK → 前端） |
| `terminal:output` | 终端输出数据 | 用户终端输出 |
| `terminal:exit` | `{ sessionId, code }` | 终端进程退出 |

## 内部组件

| 组件 | 职责 | 文件 |
|------|------|------|
| terminal.service | 终端服务主入口 | `services/terminal/terminal.service.ts` |
| terminal-gateway | 终端进程网关（创建/管理子进程） | `services/terminal/terminal-gateway.ts` |
| terminal-tools | SDK 终端工具（shell/bash 集成） | `services/terminal/terminal-tools.ts` |
| terminal-history-store | 终端历史记录持久化 | `services/terminal/terminal-history-store.ts` |
| terminal-output-store | 终端输出缓存 | `services/terminal/terminal-output-store.ts` |
| shared-terminal-service | 共享终端服务（多面板复用） | `services/terminal/shared-terminal-service.ts` |
| TerminalPanel | 终端面板 UI | `renderer/components/layout/TerminalPanel.tsx` |
| SharedTerminalPanel | 共享终端面板 UI | `renderer/components/layout/SharedTerminalPanel.tsx` |
| TerminalOutput | 终端输出渲染 | `renderer/components/TerminalOutput.tsx` |
| terminal.store | 用户终端状态 | `renderer/stores/terminal.store.ts` |
| user-terminal.store | 用户终端会话状态 | `renderer/stores/user-terminal.store.ts` |

### 归属 IPC Handler

| Handler | 文件 |
|---------|------|
| system (部分) | `ipc/system.ts` |

## 功能列表

| 功能 | 状态 | 文档 |
|------|------|------|
| terminal-gateway | 已完成 | features/terminal-gateway/design.md |
| terminal-ui | 已完成 | features/terminal-ui/design.md |

## 绑定的 API

- 无

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始模块文档 | @moonseeker1 |
