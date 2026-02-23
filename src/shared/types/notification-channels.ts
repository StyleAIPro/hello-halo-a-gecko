/**
 * Notification Channels — Shared type definitions
 *
 * Used by both main process and renderer process.
 * Must NOT import any Node.js or Electron APIs.
 *
 * Defines the configuration schema for external notification channels
 * (email, WeCom, DingTalk, Feishu, webhook).
 */

// ============================================
// Channel Type Enum
// ============================================

/** All supported notification channel types */
export type NotificationChannelType = 'email' | 'wecom' | 'dingtalk' | 'feishu' | 'webhook'

/** Display metadata for each channel */
export const NOTIFICATION_CHANNEL_META: Record<NotificationChannelType, {
  labelKey: string
  descriptionKey: string
}> = {
  email: {
    labelKey: 'Email',
    descriptionKey: 'Send notifications via SMTP email',
  },
  wecom: {
    labelKey: 'WeCom',
    descriptionKey: 'Send notifications via WeChat Work (企业微信)',
  },
  dingtalk: {
    labelKey: 'DingTalk',
    descriptionKey: 'Send notifications via DingTalk (钉钉)',
  },
  feishu: {
    labelKey: 'Feishu',
    descriptionKey: 'Send notifications via Feishu/Lark (飞书)',
  },
  webhook: {
    labelKey: 'Webhook',
    descriptionKey: 'Send notifications via HTTP webhook',
  },
}

// ============================================
// Per-Channel Config Types
// ============================================

/** Email (SMTP) channel configuration */
export interface EmailChannelConfig {
  enabled: boolean
  smtp: {
    host: string         // e.g. "smtp.qq.com", "smtp.163.com"
    port: number         // e.g. 465 (SSL), 587 (STARTTLS)
    secure: boolean      // true for SSL (port 465), false for STARTTLS
    user: string         // sender email address
    password: string     // app password / authorization code (授权码)
  }
  defaultTo: string      // default recipient email
}

/** WeCom (企业微信) self-built app configuration */
export interface WecomChannelConfig {
  enabled: boolean
  corpId: string         // enterprise ID (企业ID)
  agentId: number        // app ID (应用AgentId)
  secret: string         // app secret (应用Secret)
  defaultToUser?: string // default recipient userid (optional)
  defaultToParty?: string // default recipient department id (optional)
}

/** DingTalk (钉钉) enterprise internal app configuration */
export interface DingtalkChannelConfig {
  enabled: boolean
  appKey: string         // app key from DingTalk open platform
  appSecret: string      // app secret
  agentId: number        // app agentId from DingTalk open platform (应用AgentId)
  robotCode?: string     // robot code for single-chat messages
  defaultChatId?: string // default group chat ID (optional)
}

/** Feishu/Lark (飞书) self-built app configuration */
export interface FeishuChannelConfig {
  enabled: boolean
  appId: string          // app ID from Feishu Open Platform
  appSecret: string      // app secret
  defaultChatId?: string // default group chat ID (optional)
  defaultUserId?: string // default recipient user open_id (optional)
}

/** Generic HTTP webhook channel configuration */
export interface WebhookChannelConfig {
  enabled: boolean
  url: string            // target URL
  method?: 'POST' | 'PUT' // default: POST
  headers?: Record<string, string> // custom headers
  secret?: string        // HMAC signing secret (optional)
}

// ============================================
// Aggregate Config
// ============================================

/** All notification channels configuration — stored in HaloConfig */
export interface NotificationChannelsConfig {
  email?: EmailChannelConfig
  wecom?: WecomChannelConfig
  dingtalk?: DingtalkChannelConfig
  feishu?: FeishuChannelConfig
  webhook?: WebhookChannelConfig
}

// ============================================
// Output Notify Config (for App Spec)
// ============================================

/**
 * Extended output notification config.
 * Replaces the old `output.notify: boolean` in App Spec.
 */
export interface OutputNotifyConfig {
  /** Send system desktop notification (default: true) */
  system?: boolean
  /** External channels to notify on completion */
  channels?: NotificationChannelType[]
}

// ============================================
// Notification Payload (internal)
// ============================================

/** Standard payload passed to channel adapters */
export interface NotificationPayload {
  title: string
  body: string
  appId?: string
  appName?: string
  /** Timestamp (epoch ms) when the event occurred */
  timestamp: number
}

// ============================================
// Send Result
// ============================================

export interface NotifySendResult {
  channel: NotificationChannelType
  success: boolean
  error?: string
}

// ============================================
// Channel Test Result (for Settings UI)
// ============================================

export interface ChannelTestResult {
  channel: NotificationChannelType
  success: boolean
  error?: string
  latencyMs?: number
}
