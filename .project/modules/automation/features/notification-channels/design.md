# 功能 — notification-channels

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：prd/automation-platform-v1.md
> 所属模块：modules/automation/automation-platform-v1

## 描述

通知投递服务：提供统一的多渠道通知发送能力，支持邮件（SMTP）、企业微信（WeCom）、钉钉（DingTalk）、飞书（Feishu）和通用 Webhook 五种渠道。每个渠道独立配置、独立测试、互不影响。支持 AI 自主发送通知（通过 MCP 工具）和系统自动通知（运行完成后触发）。

## 依赖

- `shared/types/notification-channels` — 通知渠道类型定义（配置、载荷、结果）
- `services/config.service` — 读取用户通知渠道配置（AicoBotConfig.notificationChannels）
- 外部依赖：`nodemailer`（邮件，动态导入）
- 外部 API：企业微信、钉钉、飞书开放平台

## 实现逻辑

### 正常流程

1. **统一入口（sendToChannel）**
   - 接收渠道类型、全局配置和通知载荷
   - 检查目标渠道是否启用
   - 委托给对应渠道的发送函数
   - 返回 `NotifySendResult`（不抛出异常）

2. **多渠道并行发送（sendToChannels）**
   - 使用 `Promise.allSettled` 并行发送到多个渠道
   - 每个渠道结果独立返回
   - 单渠道失败不影响其他渠道

3. **渠道测试（testChannel）**
   - 验证渠道启用状态
   - 调用对应渠道的测试函数
   - 返回 `ChannelTestResult`（含延迟毫秒数）

4. **启用渠道列表（getEnabledChannels）**
   - 遍历配置，返回所有 `enabled: true` 的渠道类型

5. **Token 缓存清理（clearAllTokenCaches）**
   - 配置变更时清理所有缓存的 access token

### 各渠道实现

#### 邮件（email）
- 使用 nodemailer 通过 SMTP 发送
- 支持任意 SMTP 提供商（QQ 邮箱、163、Gmail 等）
- 发送 HTML 格式邮件（渐变标题栏 + 正文区域）
- 动态导入 nodemailer（减小启动开销）
- 测试方式：`transporter.verify()` 验证连接

配置项：`smtp.host`, `smtp.port`, `smtp.secure`, `smtp.user`, `smtp.password`, `defaultTo`

#### 企业微信（wecom）
- 通过自建应用 API 发送消息
- 使用 access token 认证，自动刷新（提前 5 分钟）
- 支持 markdown（指定用户）和 text（@all）两种消息格式
- Token 错误自动重试（errcode 42001/40014）
- 按 corpId+agentId 缓存 TokenManager 单例

配置项：`corpId`, `secret`, `agentId`, `defaultToUser`, `defaultToParty`

#### 钉钉（dingtalk）
- 通过企业内部应用发送工作通知或群消息
- 两种投递模式：工作通知（1:1 推送）和群聊消息
- 优先使用群聊（配置了 defaultChatId 时），否则走工作通知
- 支持 markdown 富文本格式
- Token 错误自动重试（errcode 42001/40014/88）
- 按 appKey 缓存 TokenManager 单例

配置项：`appKey`, `appSecret`, `agentId`, `defaultChatId`

#### 飞书（feishu）
- 通过自建应用 API 发送消息
- 使用 tenant_access_token 认证
- 支持发送到群聊（chatId）或个人（userId/openId）
- 使用 post 富文本消息格式
- Token 过期自动重试（code 99991668/99991663）
- 使用原生 HTTP 请求（不依赖 @larksuiteoapi/node-sdk）
- 按 appId 缓存 TokenManager 单例

配置项：`appId`, `appSecret`, `defaultChatId`, `defaultUserId`

#### 通用 Webhook（webhook）
- 通过 HTTP POST 发送 JSON 载荷到用户指定 URL
- 支持可选的 HMAC-SHA256 签名（X-AICO-Bot-Signature 头）
- 支持自定义 HTTP 方法（默认 POST）和自定义头
- 测试方式：发送测试载荷验证响应

配置项：`url`, `method`, `secret`, `headers`

### Token 管理（TokenManager）

- 内存缓存 access token
- 提前 5 分钟刷新（避免请求过程中过期）
- 并发刷新去重（同一时刻只发一个刷新请求）
- `invalidate()` 清除缓存（用于强制刷新或配置变更）
- `withTokenRetry()` 封装 token 过期重试逻辑

### 通知载荷格式

```typescript
interface NotificationPayload {
  title: string        // 通知标题
  body: string         // 通知正文
  appId?: string       // 来源 App ID
  appName?: string     // 来源 App 名称
  timestamp: number    // 时间戳（ms）
}
```

### 结果格式

```typescript
interface NotifySendResult {
  channel: NotificationChannelType  // 渠道类型
  success: boolean                  // 是否成功
  error?: string                    // 失败原因
}
```

### 异常流程

1. **渠道未启用**：返回 `{ success: false, error: 'xxx channel not enabled' }`
2. **配置缺失**：各渠道内部检查必要字段，缺失时返回错误
3. **SMTP 连接失败**：捕获异常，返回错误消息
4. **企业微信 API 错误**：捕获 errcode，返回错误消息
5. **钉钉 API 错误**：同上
6. **飞书 API 错误**：同上
7. **Webhook HTTP 错误**：非 2xx 状态码视为失败
8. **Token 刷新失败**：返回原始错误
9. **nodemailer 导入失败**：动态导入异常向上传播

## 涉及 API

→ 无独立 HTTP API，通过以下方式调用：
- `sendToChannel()` / `sendToChannels()` — 被 notification.service 和 MCP 工具调用
- `testChannel()` — 被 IPC 处理器调用（设置页面测试连接）
- `getEnabledChannels()` — 被 MCP 工具调用（检查可用渠道）

## 涉及数据

→ 无数据库表，配置存储在 AicoBotConfig.notificationChannels

配置结构（NotificationChannelsConfig）：
- `email?: EmailChannelConfig`
- `wecom?: WecomChannelConfig`
- `dingtalk?: DingtalkChannelConfig`
- `feishu?: FeishuChannelConfig`
- `webhook?: WebhookChannelConfig`

每个渠道配置均包含 `enabled: boolean` 和渠道特有字段。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/main/services/notify-channels/index.ts` | 统一入口：发送、测试、渠道列表 |
| `src/main/services/notify-channels/token-manager.ts` | 通用 Token 缓存和刷新管理 |
| `src/main/services/notify-channels/email.ts` | 邮件渠道（SMTP/nodemailer） |
| `src/main/services/notify-channels/wecom.ts` | 企业微信渠道 |
| `src/main/services/notify-channels/dingtalk.ts` | 钉钉渠道（工作通知 + 群消息） |
| `src/main/services/notify-channels/feishu.ts` | 飞书渠道 |
| `src/main/services/notify-channels/webhook.ts` | 通用 Webhook 渠道（HMAC 签名） |
| `src/shared/types/notification-channels.ts` | 共享类型定义 |

## 变更

→ changelog.md
