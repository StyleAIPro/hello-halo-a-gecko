# 模块 — 通知系统 notification-v1

> 版本：notification-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源架构：无（初始版本）

## 职责

管理应用的多渠道通知能力，支持系统桌面通知以及外部通知渠道（邮件、钉钉、飞书、企业微信、Webhook）。为自动化 App 提供任务完成通知服务。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    Notification Module                            │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐     │
│  │ notification   │  │ notify-channel│ │  token-manager      │     │
│  │ .service.ts    │  │ providers     │ │  (渠道 Token 管理)  │     │
│  │ (通知服务)      │ │ (渠道适配)     │ │                     │     │
│  └──────────────┘  └──────────────┘  └────────────────────┘     │
│                                                                  │
│  渠道: email / dingtalk / feishu / wecom / webhook               │
└─────────────────────────────────────────────────────────────────┘

外部依赖:
  → config.service (渠道配置)
```

## 对外接口

### IPC Handle 通道

| 方法 | 通道名 | 输入 | 输出 | 说明 |
|------|--------|------|------|------|
| sendNotification | `notification:send` | `{ channel, message }` | `{ success }` | 发送通知 |
| getChannels | `notification-channels:list` | 无 | `{ success, data }` | 获取通知渠道列表 |
| saveChannel | `notification-channels:save` | `{ channel }` | `{ success }` | 保存渠道配置 |
| deleteChannel | `notification-channels:delete` | `{ channelId }` | `{ success }` | 删除渠道 |
| testChannel | `notification-channels:test` | `{ channel }` | `{ success }` | 测试渠道连接 |

## 内部组件

| 组件 | 职责 | 文件 |
|------|------|------|
| notification.service | 通知发送服务（统一入口） | `services/notification.service.ts` |
| notify-channels/index | 渠道管理器 | `services/notify-channels/index.ts` |
| email | 邮件通知渠道 | `services/notify-channels/email.ts` |
| dingtalk | 钉钉通知渠道 | `services/notify-channels/dingtalk.ts` |
| feishu | 飞书通知渠道 | `services/notify-channels/feishu.ts` |
| wecom | 企业微信通知渠道 | `services/notify-channels/wecom.ts` |
| webhook | Webhook 通知渠道 | `services/notify-channels/webhook.ts` |
| token-manager | 渠道 Token 管理 | `services/notify-channels/token-manager.ts` |
| NotificationToast | 通知 Toast UI | `renderer/components/notification/NotificationToast.tsx` |
| NotificationChannelsSection | 通知渠道设置 UI | `renderer/components/settings/NotificationChannelsSection.tsx` |
| notification.store | 通知状态管理 | `renderer/stores/notification.store.ts` |
| notification-channels | 通知渠道共享类型 | `shared/types/notification-channels.ts` |

### 归属 IPC Handler

| Handler | 文件 |
|---------|------|
| notification-channels | `ipc/notification-channels.ts` |

## 功能列表

| 功能 | 状态 | 文档 |
|------|------|------|
| notify-channels | 已完成 | features/notify-channels/design.md |
| notify-ui | 已完成 | features/notify-ui/design.md |

## 绑定的 API

- 无

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始模块文档 | @moonseeker1 |
