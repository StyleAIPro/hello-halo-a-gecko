# 功能 — 通知 UI

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/notification/notification-v1

## 描述
提供应用内通知 Toast 展示和通知状态管理。

## 依赖
- notify-channels（渠道服务）

## 实现逻辑
1. 接收通知事件
2. 展示 Toast 通知
3. 管理通知已读/未读状态

## 涉及文件
- `renderer/components/notification/NotificationToast.tsx` — Toast UI
- `renderer/stores/notification.store.ts` — 通知状态

## 变更
→ changelog.md
