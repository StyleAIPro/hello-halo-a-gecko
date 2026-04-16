# 功能 — 用户行为分析

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/observability/observability-v1

## 描述
集成 Google Analytics 和百度统计，追踪用户行为事件（页面访问、功能使用等）。

## 依赖
- config.service（分析配置开关）
- 环境变量（AICO_BOT_GA_*、AICO_BOT_BAIDU_*）

## 实现逻辑
1. 读取分析配置和环境变量
2. 初始化分析 SDK
3. 在关键用户行为点发送事件
4. 支持开关控制（默认关闭）

## 涉及文件
- `services/analytics/analytics.service.ts` — 分析服务
- `services/analytics/providers/` — 提供商适配
- `services/analytics/types.ts` — 类型定义

## 变更
→ changelog.md
