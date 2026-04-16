# 功能 — AI 源提供商

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/ai-sources/ai-sources-v1

## 描述
定义 AI 模型提供商的统一接口和适配器，支持 GitHub Models、GitCode AI、OpenAI 兼容 API 等多种提供商。

## 依赖
- config.service（配置读取）

## 实现逻辑
1. 定义 AI 源提供商接口
2. 为每个提供商实现适配器
3. 处理认证和 API 调用

## 涉及文件
- `services/ai-sources/providers/` — 提供商适配器
- `services/ai-sources/auth-loader.ts` — 认证加载
- `shared/interfaces/ai-source-provider.ts` — 接口定义
- `shared/types/ai-sources.ts` — 类型定义

## 变更
→ changelog.md
