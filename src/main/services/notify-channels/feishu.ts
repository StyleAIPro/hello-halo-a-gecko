/**
 * Notify Channels — Feishu/Lark (飞书) Channel
 *
 * Sends notifications via Feishu self-built app API.
 * Uses tenant_access_token auth with automatic refresh.
 * Uses raw HTTP instead of @larksuiteoapi/node-sdk to avoid adding a heavy dependency.
 *
 * API docs: https://open.feishu.cn/document/
 */

import type { FeishuChannelConfig, NotificationPayload, NotifySendResult } from '../../../shared/types/notification-channels'
import { TokenManager } from './token-manager'

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis'

// Singleton token managers per appId
const tokenManagers = new Map<string, TokenManager>()

function getTokenManager(config: FeishuChannelConfig): TokenManager {
  const key = config.appId
  let manager = tokenManagers.get(key)
  if (!manager) {
    manager = new TokenManager('Feishu', async () => {
      const url = `${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: config.appId,
          app_secret: config.appSecret,
        }),
      })
      const data = await res.json() as {
        code: number
        msg: string
        tenant_access_token: string
        expire: number
      }
      if (data.code !== 0) {
        throw new Error(`Feishu get token failed: ${data.code} ${data.msg}`)
      }
      return { token: data.tenant_access_token, expiresIn: data.expire }
    })
    tokenManagers.set(key, manager)
  }
  return manager
}

/**
 * Send a notification via Feishu.
 * Supports sending to chat (group) or individual user.
 */
export async function sendFeishu(
  config: FeishuChannelConfig,
  payload: NotificationPayload
): Promise<NotifySendResult> {
  const channel = 'feishu' as const

  // Determine target
  const chatId = config.defaultChatId
  const userId = config.defaultUserId

  if (!chatId && !userId) {
    return { channel, success: false, error: 'No target configured (need defaultChatId or defaultUserId)' }
  }

  // Choose receive_id_type and receive_id
  const receiveIdType = chatId ? 'chat_id' : 'open_id'
  const receiveId = chatId || userId!

  console.log(`[NotifyChannel][Feishu] Sending to ${receiveIdType}=${receiveId}, title="${payload.title}"`)

  try {
    const manager = getTokenManager(config)
    const token = await manager.getToken()
    const timestamp = new Date(payload.timestamp).toLocaleString()

    // Build rich text (post) message — Feishu supports markdown via post type
    const content = JSON.stringify({
      zh_cn: {
        title: payload.title,
        content: [
          [
            {
              tag: 'text',
              text: payload.body,
            },
          ],
          [
            {
              tag: 'text',
              text: `${payload.appName ? `App: ${payload.appName} | ` : ''}${timestamp}`,
              style: ['italic'],
            },
          ],
        ],
      },
    })

    const url = `${FEISHU_API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: 'post',
        content,
      }),
    })

    const data = await res.json() as {
      code: number
      msg: string
      data?: { message_id?: string }
    }

    // Handle token expiry — Feishu returns code 99991668 or 99991663
    if (data.code === 99991668 || data.code === 99991663) {
      console.log(`[NotifyChannel][Feishu] Token expired (code=${data.code}), retrying...`)
      manager.invalidate()
      const freshToken = await manager.getToken()

      const retryRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${freshToken}`,
        },
        body: JSON.stringify({
          receive_id: receiveId,
          msg_type: 'post',
          content,
        }),
      })
      const retryData = await retryRes.json() as typeof data

      if (retryData.code !== 0) {
        throw new Error(`Feishu send failed after retry: ${retryData.code} ${retryData.msg}`)
      }

      console.log(`[NotifyChannel][Feishu] Sent on retry, messageId=${retryData.data?.message_id}`)
      return { channel, success: true }
    }

    if (data.code !== 0) {
      throw new Error(`Feishu send failed: ${data.code} ${data.msg}`)
    }

    console.log(`[NotifyChannel][Feishu] Sent successfully, messageId=${data.data?.message_id}`)
    return { channel, success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[NotifyChannel][Feishu] Failed:`, message)
    return { channel, success: false, error: message }
  }
}

/**
 * Test Feishu connection by fetching a tenant access token.
 */
export async function testFeishu(config: FeishuChannelConfig): Promise<{ success: boolean; error?: string }> {
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
export function clearFeishuTokenCache(): void {
  tokenManagers.clear()
}
