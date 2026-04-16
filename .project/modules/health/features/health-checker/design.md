# 功能 — 健康检查

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/health/health-monitor-v1

## 描述
定期检查系统各组件健康状态，包括 SDK 连接、IPC 通道、文件系统等。异常时发出告警并触发恢复流程。

## 依赖
- 无（底层模块）

## 实现逻辑
### 正常流程
1. 编排器定期触发健康检查
2. 检查器依次检测各组件
3. 汇总结果并广播状态

## 涉及文件
- `services/health/orchestrator.ts` — 健康编排器
- `services/health/health-checker/event-listener.ts` — 健康事件监听
- `services/health/diagnostics/` — 诊断工具
- `services/health/types.ts` — 健康类型定义

## 变更
→ changelog.md
