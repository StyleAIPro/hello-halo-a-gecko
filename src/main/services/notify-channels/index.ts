/**
 * Notify Channels — Unified Channel Interface
 *
 * Provides a single entry point for sending notifications across all channels.
 * Each channel is lazily loaded and independently testable.
 *
 * Architecture:
 * - Each channel has a send() function and a test() function
 * - Token managers are cached per-channel and auto-refresh
 * - All functions are async and non-blocking
 * - Failures in one channel do not affect others
 */

import type {
  NotificationChannelType,
  NotificationChannelsConfig,
  NotificationPayload,
  NotifySendResult,
  ChannelTestResult,
} from '../../../shared/types/notification-channels'

import { sendEmail, testEmail } from './email'
import { sendWecom, testWecom, clearWecomTokenCache } from './wecom'
import { sendDingtalk, testDingtalk, clearDingtalkTokenCache } from './dingtalk'
import { sendFeishu, testFeishu, clearFeishuTokenCache } from './feishu'
import { sendWebhook, testWebhook } from './webhook'

/**
 * Send a notification to a specific channel.
 * Returns success/failure without throwing.
 */
export async function sendToChannel(
  channelType: NotificationChannelType,
  config: NotificationChannelsConfig,
  payload: NotificationPayload
): Promise<NotifySendResult> {
  switch (channelType) {
    case 'email': {
      const cfg = config.email
      if (!cfg?.enabled) return { channel: channelType, success: false, error: 'Email channel not enabled' }
      return sendEmail(cfg, payload)
    }
    case 'wecom': {
      const cfg = config.wecom
      if (!cfg?.enabled) return { channel: channelType, success: false, error: 'WeCom channel not enabled' }
      return sendWecom(cfg, payload)
    }
    case 'dingtalk': {
      const cfg = config.dingtalk
      if (!cfg?.enabled) return { channel: channelType, success: false, error: 'DingTalk channel not enabled' }
      return sendDingtalk(cfg, payload)
    }
    case 'feishu': {
      const cfg = config.feishu
      if (!cfg?.enabled) return { channel: channelType, success: false, error: 'Feishu channel not enabled' }
      return sendFeishu(cfg, payload)
    }
    case 'webhook': {
      const cfg = config.webhook
      if (!cfg?.enabled) return { channel: channelType, success: false, error: 'Webhook channel not enabled' }
      return sendWebhook(cfg, payload)
    }
    default:
      return { channel: channelType, success: false, error: `Unknown channel: ${channelType}` }
  }
}

/**
 * Send a notification to multiple channels in parallel.
 * Returns results for each channel.
 */
export async function sendToChannels(
  channels: NotificationChannelType[],
  config: NotificationChannelsConfig,
  payload: NotificationPayload
): Promise<NotifySendResult[]> {
  if (channels.length === 0) return []

  const results = await Promise.allSettled(
    channels.map(ch => sendToChannel(ch, config, payload))
  )

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value
    return {
      channel: channels[i],
      success: false,
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    }
  })
}

/**
 * Test a specific channel's connection/configuration.
 */
export async function testChannel(
  channelType: NotificationChannelType,
  config: NotificationChannelsConfig
): Promise<ChannelTestResult> {
  const start = Date.now()

  try {
    let result: { success: boolean; error?: string }

    switch (channelType) {
      case 'email': {
        const cfg = config.email
        if (!cfg?.enabled) return { channel: channelType, success: false, error: 'Not enabled' }
        result = await testEmail(cfg)
        break
      }
      case 'wecom': {
        const cfg = config.wecom
        if (!cfg?.enabled) return { channel: channelType, success: false, error: 'Not enabled' }
        result = await testWecom(cfg)
        break
      }
      case 'dingtalk': {
        const cfg = config.dingtalk
        if (!cfg?.enabled) return { channel: channelType, success: false, error: 'Not enabled' }
        result = await testDingtalk(cfg)
        break
      }
      case 'feishu': {
        const cfg = config.feishu
        if (!cfg?.enabled) return { channel: channelType, success: false, error: 'Not enabled' }
        result = await testFeishu(cfg)
        break
      }
      case 'webhook': {
        const cfg = config.webhook
        if (!cfg?.enabled) return { channel: channelType, success: false, error: 'Not enabled' }
        result = await testWebhook(cfg)
        break
      }
      default:
        result = { success: false, error: `Unknown channel: ${channelType}` }
    }

    return {
      channel: channelType,
      success: result.success,
      error: result.error,
      latencyMs: Date.now() - start,
    }
  } catch (err) {
    return {
      channel: channelType,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    }
  }
}

/**
 * Get the list of enabled channels from the config.
 */
export function getEnabledChannels(config: NotificationChannelsConfig | undefined): NotificationChannelType[] {
  if (!config) return []
  const enabled: NotificationChannelType[] = []
  if (config.email?.enabled) enabled.push('email')
  if (config.wecom?.enabled) enabled.push('wecom')
  if (config.dingtalk?.enabled) enabled.push('dingtalk')
  if (config.feishu?.enabled) enabled.push('feishu')
  if (config.webhook?.enabled) enabled.push('webhook')
  return enabled
}

/**
 * Clear all cached token managers.
 * Call this when notification channel config changes.
 */
export function clearAllTokenCaches(): void {
  clearWecomTokenCache()
  clearDingtalkTokenCache()
  clearFeishuTokenCache()
}
