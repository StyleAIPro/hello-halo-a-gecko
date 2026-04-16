# 功能 — 新手引导流程

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/onboarding/onboarding-v1

## 描述
首次使用时的引导流程，通过 Spotlight 高亮和步骤提示帮助用户了解应用功能。

## 依赖
- onboarding.service（引导状态管理）

## 实现逻辑
1. 检测是否首次使用
2. 显示引导覆盖层
3. 按步骤高亮各功能区域
4. 用户完成或跳过引导

## 涉及文件
- `services/onboarding.service.ts` — 引导服务
- `renderer/components/onboarding/OnboardingOverlay.tsx` — 覆盖层
- `renderer/components/onboarding/Spotlight.tsx` — 聚焦高亮
- `renderer/components/onboarding/onboardingData.tsx` — 引导数据
- `renderer/stores/onboarding.store.ts` — 引导状态

## 变更
→ changelog.md
