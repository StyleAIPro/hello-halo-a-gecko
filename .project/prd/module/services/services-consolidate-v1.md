# PRD [模块级] — services 目录模块合并（remote 集群整合）

> 版本：services-consolidate-v1
> 日期：2026-05-06
> 状态：done
> 指令人：@moonseeker
> 归属模块：codebase（工程基础设施）
> 优先级：P1
> 影响范围：全栈（主进程 import 路径更新，编译验证）

## 前置 PRD

本 PRD 是 `services-refactor-v2`（已完成，大文件拆分）的后续。v2 将超大文件拆分为子文件；本 PRD 专注于将远程相关的 4 个强关联模块合并到统一父目录下，形成多级模块管理体系。

## 需求分析

### 现状

`src/main/services/` 下有 4 个 `remote-*` 一级目录在平铺，但它们之间有强依赖关系：

| 模块 A → 模块 B | 依赖方向 | 依赖强度 | 说明 |
|------------------|---------|---------|------|
| remote-deploy → remote-ssh | 单向 | **HIGH** | 6 处引用 SSHManager/SSHConfig |
| remote-deploy → remote-ws | 单向 | **HIGH** | 2 处引用连接池 |
| agent → remote-ws | 单向 | **MEDIUM** | control.ts、send-message-remote.ts 引用 |
| agent → remote-ssh | 单向 | **MEDIUM** | send-message-remote.ts 引用 |

### 问题

1. **目录碎片化**：4 个 `remote-*` 目录在一级平铺，无法从目录层级感知它们属于同一个「远程基础设施」域
2. **跨模块耦合隐式化**：`remote-deploy` 对 `remote-ssh` 有 6 处引用，但两者在目录上毫无关联

### 目标

将 4 个 remote 模块合并到统一父目录 `remote/` 下，保留子目录边界。**纯重构，功能零变更。**

## 技术方案

### 合并后目录结构

```
src/main/services/remote/
├── index.ts                         ← 新建：父级桶文件
├── access/                          ← 原 remote-access/
│   ├── index.ts                     ← 原 remote-access/index.ts
│   ├── remote.service.ts
│   └── tunnel.service.ts
├── deploy/                          ← 原 remote-deploy/
│   ├── index.ts                     ← 原 remote-deploy/index.ts
│   ├── remote-deploy.service.ts
│   ├── server-manager.ts
│   ├── agent-deployer.ts
│   ├── agent-runner.ts
│   ├── remote-skill-manager.ts
│   ├── health-monitor.ts
│   ├── machine-id.ts
│   └── port-allocator.ts
├── ssh/                             ← 原 remote-ssh/
│   ├── index.ts                     ← 原 remote-ssh/index.ts
│   ├── ssh-manager.ts
│   └── ssh-tunnel.service.ts
└── ws/                              ← 原 remote-ws/
    ├── index.ts                     ← 原 remote-ws/index.ts
    ├── remote-ws-client.ts
    ├── aico-bot-mcp-bridge.ts
    ├── ws-types.ts
    └── ws-connection-pool.ts
```

> **命名原则**：父目录名 `remote` 语义清晰；子目录保留原有模块缩写，消除 `remote-` 前缀冗余。

### 内部依赖路径更新

合并后集群内部依赖路径从 `../remote-xxx/` 变为 `../xxx/`：

| 依赖方 | 被依赖方 | 原路径 | 新路径 |
|--------|---------|--------|--------|
| `remote/deploy/agent-runner.ts` | `remote/ssh/` | `../remote-ssh/ssh-manager` | `../ssh/ssh-manager` |
| `remote/deploy/agent-runner.ts` | `remote/ws/` | `../remote-ws/remote-ws-client` | `../ws/remote-ws-client` |
| `remote/deploy/port-allocator.ts` | `remote/ssh/` | `../remote-ssh/ssh-manager` | `../ssh/ssh-manager` |
| `remote/deploy/remote-deploy.service.ts` | `remote/ssh/` | `../remote-ssh/ssh-manager` | `../ssh/ssh-manager` |
| `remote/deploy/remote-skill-manager.ts` | `remote/ssh/` | `../remote-ssh/ssh-manager` | `../ssh/ssh-manager` |
| `remote/deploy/server-manager.ts` | `remote/ssh/` | `../remote-ssh/ssh-manager` | `../ssh/ssh-manager` |

### 外部消费者 import 更新

| 文件 | 原路径 | 新路径 |
|------|--------|--------|
| `src/main/index.ts` | `./services/remote-access/remote.service` | `./services/remote/access/remote.service` |
| `src/main/ipc/remote.ts` | `../services/remote-access/remote.service` | `../services/remote/access/remote.service` |
| `src/main/controllers/skill.controller.ts` | `../services/remote-deploy/remote-deploy.service` | `../services/remote/deploy/remote-deploy.service` |
| `src/main/ipc/hyper-space.ts` | `../services/remote-deploy/remote-deploy.service` | `../services/remote/deploy/remote-deploy.service` |
| `src/main/ipc/remote-server.ts` | `../services/remote-deploy/remote-deploy.service` | `../services/remote/deploy/remote-deploy.service` |
| `src/main/ipc/space.ts` | `../services/remote-deploy/remote-deploy.service` | `../services/remote/deploy/remote-deploy.service` |
| `src/main/ipc/agent.ts` | `../services/remote-ws/remote-ws-client` | `../services/remote/ws/remote-ws-client` |
| `src/main/services/agent/control.ts` | `../remote-ws/remote-ws-client` | `../remote/ws/remote-ws-client` |
| `src/main/services/agent/send-message-remote.ts` | `../remote-ws/remote-ws-client` | `../remote/ws/remote-ws-client` |
| `src/main/services/agent/send-message-remote.ts` | `../remote-ssh/ssh-tunnel.service` | `../remote/ssh/ssh-tunnel.service` |
| `src/main/services/agent/send-message-remote.ts` | `../remote-ssh/ssh-manager` | `../remote/ssh/ssh-manager` |
| `src/main/services/terminal/shared-terminal-service.ts` | `../remote-ssh/ssh-manager` | `../remote/ssh/ssh-manager` |
| `src/main/services/terminal/shared-terminal-service.ts` | `../remote-deploy/remote-deploy.service` | `../remote/deploy/remote-deploy.service` |
| `src/main/services/terminal/terminal.service.ts` | `../remote-ssh/ssh-manager` | `../remote/ssh/ssh-manager` |
| `src/main/services/terminal/terminal-gateway.ts` | `../remote-deploy/remote-deploy.service` | `../remote/deploy/remote-deploy.service` |

### 层级变化（顶层引用）

部分文件的 import 会因为多嵌套一层目录而需要更新：

| 文件 | 原路径 | 新路径 | 说明 |
|------|--------|--------|------|
| `remote/access/tunnel.service.ts` | `../health` | `../../health` | 多嵌套一层 |
| `remote/access/tunnel.service.ts` | `../config.service` | `../../config.service` | 多嵌套一层 |
| `remote/access/remote.service.ts` | `../../http/server` | `../../../http/server` | 多嵌套一层 |
| `remote/access/remote.service.ts` | `../../http/auth` | `../../../http/auth` | 多嵌套一层 |
| `remote/deploy/index.ts` | `../../../shared/types` | `../../../../shared/types` | 多嵌套一层 |

### 实施策略

1. 创建 `services/remote/` 目录结构
2. 使用 `git mv` 移动 4 个子目录
3. 更新所有内部 import 路径
4. 更新所有外部消费者 import 路径
5. 创建 `services/remote/index.ts` 父级桶文件
6. 运行 `npm run typecheck && npm run build` 验证
7. 单次提交

## 开发前必读

| 类别 | 文件路径 | 阅读目的 |
|------|---------|---------|
| 模块设计文档 | `.project/modules/remote-agent/remote-agent-v1.md` | 理解远程模块架构和 4 个子模块的职责划分 |
| 前置 PRD | `.project/prd/module/services/services-refactor-v2.md` | 理解 v2 大文件拆分的目录结构和约定 |
| 编码规范 | `docs/Development-Standards-Guide.md` | 遵循 import 规范、命名规范 |
| 桶文件 | 各 remote-* 模块的 `index.ts` | 理解现有桶文件导出，合并后需保持导出兼容 |

## 涉及文件

### 移动的目录（4 个）

| 原路径 | 新路径 |
|--------|--------|
| `services/remote-access/` | `services/remote/access/` |
| `services/remote-deploy/` | `services/remote/deploy/` |
| `services/remote-ssh/` | `services/remote/ssh/` |
| `services/remote-ws/` | `services/remote/ws/` |

### 需要更新 import 的文件（预估 15+ 个）

见上方「内部依赖路径更新」「外部消费者 import 更新」「层级变化」三个表格。

### 新建文件

| 文件 | 说明 |
|------|------|
| `services/remote/index.ts` | 父级桶文件，re-export access、deploy、ssh、ws 的公开 API |

### 需要更新的文档

| 文件 | 变更 |
|------|------|
| `CLAUDE.md` 关键目录章节 | 更新 services 下的目录结构说明 |
| `.project/modules/remote-agent/remote-agent-v1.md` | 目录结构图更新 |

## 验收标准

- [x] `services/remote/` 目录已创建，包含 `access/`、`deploy/`、`ssh/`、`ws/` 四个子目录
- [x] 旧的 `services/remote-access/`、`services/remote-deploy/`、`services/remote-ssh/`、`services/remote-ws/` 已删除
- [x] `services/remote/index.ts` 父级桶文件已创建
- [x] 集群内部依赖路径已全部更新
- [x] 外部消费者 import 路径已全部更新
- [x] 层级变化（顶层引用）路径已全部更新
- [x] `npm run typecheck` 通过
- [x] `npm run build` 通过
- [x] 无任何外部 API / IPC 接口变更
- [x] `CLAUDE.md` 关键目录章节已更新

## 变更记录

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-06 | 初始 PRD，范围缩窄为仅 remote 集群 | @moonseeker |
