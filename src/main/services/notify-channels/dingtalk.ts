/**
 * Notify Channels — DingTalk (钉钉) Channel
 *
 * Sends notifications via DingTalk enterprise internal app (work notification).
 * Uses access token auth with automatic refresh.
 *
 * API docs: https://open.dingtalk.com/document/
 */

import type { DingtalkChannelConfig, NotificationPayload, NotifySendResult } from '../../../shared/types/notification-channels'
import { TokenManager, withTokenRetry } from './token-manager'

const DINGTALK_API_BASE = 'https://oapi.dingtalk.com'

// Singleton token managers per appKey
const tokenManagers = new Map<string, TokenManager>()

function getTokenManager(config: DingtalkChannelConfig): TokenManager {
  const key = config.appKey
  let manager = tokenManagers.get(key)
  if (!manager) {
    manager = new TokenManager('DingTalk', async () => {
      const url = `${DINGTALK_API_BASE}/gettoken?appkey=${encodeURIComponent(config.appKey)}&appsecret=${encodeURIComponent(config.appSecret)}`
      const res = await fetch(url)
      const data = await res.json() as { errcode: number; errmsg: string; access_token: string; expires_in: number }
      if (data.errcode !== 0) {
        throw new Error(`DingTalk gettoken failed: ${data.errcode} ${data.errmsg}`)
      }
      return { token: data.access_token, expiresIn: data.expires_in }
    })
    tokenManagers.set(key, manager)
  }
  return manager
}

/**
 * Send a notification via DingTalk work notification (工作通知).
 * This pushes a message to the user's DingTalk work notification area.
 */
export async function sendDingtalk(
  config: DingtalkChannelConfig,
  payload: NotificationPayload
): Promise<NotifySendResult> {
  const channel = 'dingtalk' as const

  // Choose delivery method based on config
  if (config.defaultChatId) {
    return sendToGroupChat(config, payload)
  }
  return sendWorkNotification(config, payload)
}

/**
 * Send as work notification (1:1 push to users).
 */
async function sendWorkNotification(
  config: DingtalkChannelConfig,
  payload: NotificationPayload
): Promise<NotifySendResult> {
  const channel = 'dingtalk' as const
  console.log(`[NotifyChannel][DingTalk] Sending work notification, title="${payload.title}"`)

  try {
    const manager = getTokenManager(config)
    const timestamp = new Date(payload.timestamp).toLocaleString()

    // DingTalk markdown supports rich formatting (headings, bold, links, images, lists)
    const markdownText = [
      `# ${payload.title}`,
      '',
      payload.body,
      '',
      `> ${payload.appName ? `App: ${payload.appName} | ` : ''}${timestamp}`,
    ].join('\n')

    const body = {
      agent_id: config.agentId,
      to_all_user: true, // Default to all users; can be refined later
      msg: {
        msgtype: 'markdown' as const,
        markdown: {
          title: payload.title,
          text: markdownText,
        },
      },
    }

    const result = await withTokenRetry(manager, async (token) => {
      const url = `${DINGTALK_API_BASE}/topapi/message/corpconversation/asyncsend_v2?access_token=${token}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return res.json() as Promise<{ errcode: number; errmsg: string; task_id?: number }>
    })

    if (result.errcode !== 0) {
      throw new Error(`DingTalk send failed: ${result.errcode} ${result.errmsg}`)
    }

    console.log(`[NotifyChannel][DingTalk] Work notification sent, task_id=${result.task_id}`)
    return { channel, success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[NotifyChannel][DingTalk] Failed:`, message)
    return { channel, success: false, error: message }
  }
}

/**
 * Send to a DingTalk group chat.
 */
async function sendToGroupChat(
  config: DingtalkChannelConfig,
  payload: NotificationPayload
): Promise<NotifySendResult> {
  const channel = 'dingtalk' as const
  const chatId = config.defaultChatId!
  console.log(`[NotifyChannel][DingTalk] Sending to group chat=${chatId}, title="${payload.title}"`)

  try {
    const manager = getTokenManager(config)
    const timestamp = new Date(payload.timestamp).toLocaleString()

    const markdownText = [
      `# ${payload.title}`,
      '',
      payload.body,
      '',
      `> ${payload.appName ? `App: ${payload.appName} | ` : ''}${timestamp}`,
    ].join('\n')

    const body = {
      chatid: chatId,
      msg: {
        msgtype: 'markdown' as const,
        markdown: {
          title: payload.title,
          text: markdownText,
        },
      },
    }

    const result = await withTokenRetry(manager, async (token) => {
      const url = `${DINGTALK_API_BASE}/chat/send?access_token=${token}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return res.json() as Promise<{ errcode: number; errmsg: string; messageId?: string }>
    })

    if (result.errcode !== 0) {
      throw new Error(`DingTalk group send failed: ${result.errcode} ${result.errmsg}`)
    }

    console.log(`[NotifyChannel][DingTalk] Group message sent, messageId=${result.messageId}`)
    return { channel, success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[NotifyChannel][DingTalk] Failed:`, message)
    return { channel, success: false, error: message }
  }
}

/**
 * Test DingTalk connection by fetching a token.
 */
export async function testDingtalk(config: DingtalkChannelConfig): Promise<{ success: boolean; error?: string }> {
  try {
    const manager = getTokenManager(config)
    manager.invalidate()
    await manager.getToken()
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Clear cached token managers.
 */
export function clearDingtalkTokenCache(): void {
  tokenManagers.clear()
}
