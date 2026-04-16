# PRD [模块级] — 文档模块精简

> 版本：doc-module-merge-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 归属模块：codebase（跨模块文档）

## 背景

初始文档模块对齐时为 14 个业务模块建立了独立文档，但 observability（analytics/perf）和 notification（notify-channels）两个模块体量小、职责单一，且代码已归属到其他业务模块（platform/automation）。维护独立文档模块增加文档同步负担，收益不大。

## 需求

### 删除 2 个独立文档模块

| 模块 | 删除原因 | 代码归属 |
|------|---------|---------|
| observability | analytics/perf 体量小，归属基础设施 | 基础设施层，无需独立模块文档 |
| notification | notify-channels 归属 automation 模块 | `automation/features/notification-channels/` 已有文档 |

### 同步更新受影响文档

- 架构文档：模块划分表移除 2 个模块，基础设施表新增 analytics/perf/notify-channels 说明
- 全局 CHANGELOG：Added 段移除 2 个模块条目
- CLAUDE.md：新增基础设施不建独立文档规则
- vibecoding-doc-standard.md：新增基础设施不建独立文档规则

## 约束

- 不修改任何代码
- 不修改已有功能的设计文档

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 PRD | @moonseeker1 |
| 2026-04-16 | 完成：删除 observability/notification 模块，更新架构文档/CHANGELOG/CLAUDE.md/vibececoding 规范 | @moonseeker1 |
