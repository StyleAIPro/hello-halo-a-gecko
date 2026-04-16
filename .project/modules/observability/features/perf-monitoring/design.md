# 功能 — 性能监控

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/observability/observability-v1

## 描述
监控应用性能指标，包括启动时间、内存使用、渲染性能等。

## 依赖
- 无（底层模块）

## 实现逻辑
1. 收集性能指标
2. 通过 IPC 暴露给前端
3. 前端展示性能状态

## 涉及文件
- `services/perf/perf.service.ts` — 性能监控服务
- `services/perf/types.ts` — 性能类型定义
- `renderer/stores/perf.store.ts` — 性能状态管理

## 变更
→ changelog.md
