# 模块 — 健康监控 health-monitor-v1

> 版本：health-monitor-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源架构：无（初始版本）

## 职责

监控应用和系统健康状况，包括进程守护、健康检查、异常诊断和自动恢复。保障 AICO-Bot 运行时的稳定性和可观测性。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                      Health Module                               │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐     │
│  │  orchestrator  │  │ health-checker│ │ process-guardian   │     │
│  │ (健康编排器)   │  │ (健康检查器)  │ │ (进程守护)          │     │
│  └──────────────┘  └──────────────┘  └────────────────────┘     │
│                                                                  │
│  ┌──────────────────┐  ┌─────────────────────────────────┐      │
│  │ diagnostics       │  │     recovery-manager              │      │
│  │ (诊断工具)        │  │   (恢复管理)                     │      │
│  └──────────────────┘  └─────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────┘

外部依赖:
  → config.service (配置读取)
  → agent module (Agent 进程状态)
```

## 对外接口

### IPC Handle 通道

| 方法 | 通道名 | 输入 | 输出 | 说明 |
|------|--------|------|------|------|
| getHealthStatus | `health:get-status` | 无 | `{ success, data: HealthStatus }` | 获取健康状态 |
| runDiagnostics | `health:run-diagnostics` | 无 | `{ success, data: DiagnosticResult }` | 运行诊断 |

### Renderer Event 通道

| 通道名 | 数据 | 说明 |
|--------|------|------|
| `health:status` | `HealthStatus` | 健康状态广播 |
| `health:alert` | `HealthAlert` | 健康告警 |

## 内部组件

| 组件 | 职责 | 文件 |
|------|------|------|
| orchestrator | 健康监控编排器（全局协调） | `services/health/orchestrator.ts` |
| event-listener | 健康事件监听与分发 | `services/health/health-checker/event-listener.ts` |
| diagnostics | 系统诊断工具 | `services/health/diagnostics/` |
| process-guardian | 进程守护（检测 Agent 进程存活） | `services/health/process-guardian/` |
| recovery-manager | 自动恢复管理 | `services/health/recovery-manager/` |

### 归属 IPC Handler

| Handler | 文件 |
|---------|------|
| health | `ipc/health.ts` |

## 功能列表

| 功能 | 状态 | 文档 |
|------|------|------|
| health-checker | 已完成 | features/health-checker/design.md |
| process-guardian | 已完成 | features/process-guardian/design.md |

## 绑定的 API

- 无

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始模块文档 | @moonseeker1 |
