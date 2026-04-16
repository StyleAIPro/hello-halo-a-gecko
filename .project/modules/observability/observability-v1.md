# 模块 — 可观测性 observability-v1

> 版本：observability-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源架构：无（初始版本）

## 职责

提供应用的监控和分析能力，包括用户行为分析（GA/百度统计）和性能监控。帮助了解应用使用情况和性能瓶颈。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    Observability Module                          │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐     │
│  │  analytics     │  │    perf       │  │   perf.store        │     │
│  │  (用户分析)    │  │  (性能监控)   │  │   (前端性能状态)     │     │
│  └──────────────┘  └──────────────┘  └────────────────────┘     │
│                                                                  │
│  分析提供商:                                                     │
│  ├── Google Analytics                                            │
│  └── 百度统计                                                    │
```

## 对外接口

### IPC Handle 通道

| 方法 | 通道名 | 输入 | 输出 | 说明 |
|------|--------|------|------|------|
| getPerfMetrics | `perf:get-metrics` | 无 | `{ success, data }` | 获取性能指标 |

## 内部组件

| 组件 | 职责 | 文件 |
|------|------|------|
| analytics.service | 用户分析服务（GA/百度统计集成） | `services/analytics/analytics.service.ts` |
| providers | 分析提供商适配器 | `services/analytics/providers/` |
| perf.service | 性能监控服务 | `services/perf/perf.service.ts` |
| perf.store | 前端性能状态管理 | `renderer/stores/perf.store.ts` |

### 归属 IPC Handler

| Handler | 文件 |
|---------|------|
| perf | `ipc/perf.ts` |

## 功能列表

| 功能 | 状态 | 文档 |
|------|------|------|
| analytics | 已完成 | features/analytics/design.md |
| perf-monitoring | 已完成 | features/perf-monitoring/design.md |

## 绑定的 API

- 无

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始模块文档 | @moonseeker1 |
