# 功能 — 通知渠道管理

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/notification/notification-v1

## 描述
管理多渠道通知的配置和发送，支持邮件、钉钉、飞书、企业微信和 Webhook 五种渠道。

## 依赖
- config.service（渠道配置持久化）

## 实现逻辑
1. 配置通知渠道（URL/Token/密钥）
2. 保存渠道配置到加密存储
3. 发送通知到指定渠道
4. 渠道连接测试

## 涉及文件
- `services/notify-channels/` — 渠道适配器（email/dingtalk/feishu/wecom/webhook）
- `services/notify-channels/token-manager.ts` — Token 管理
- `services/notification.service.ts` — 通知服务统一入口
- `renderer/components/settings/NotificationChannelsSection.tsx` — 渠道设置 UI
- `shared/types/notification-channels.ts` — 渠道类型定义

## 变更
→ changelog.md
