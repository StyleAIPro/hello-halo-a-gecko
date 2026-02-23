/**
 * apps/runtime -- send_notification MCP Tool
 *
 * Creates an SDK MCP server providing the `send_notification` tool.
 * This tool allows the AI to autonomously send notifications to external
 * channels (email, WeCom, DingTalk, Feishu, webhook) during automation runs.
 *
 * When to use:
 * - The AI decides mid-run that something is worth notifying about
 * - The AI wants to send to a specific channel not in the spec's output.notify
 * - The AI wants to customize the notification content per-channel
 *
 * This complements (not replaces) the system-triggered notifications in
 * output.notify, which fire automatically on run completion.
 *
 * Uses the same tool() + createSdkMcpServer() pattern as report-tool.ts.
 */

import { z } from 'zod'
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { sendToChannel, getEnabledChannels } from '../../services/notify-channels'
import { getConfig } from '../../services/config.service'
import type { NotificationChannelType } from '../../../shared/types/notification-channels'

// ============================================
// Types
// ============================================

type SdkMcpServer = ReturnType<typeof createSdkMcpServer>

/** Context for the notify tool (passed when creating the server) */
export interface NotifyToolContext {
  appId: string
  appName: string
  runId: string
}

// ============================================
// Tool Text Helper
// ============================================

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  }
}

// ============================================
// Tool Factory
// ============================================

/**
 * Create an MCP server with the `send_notification` tool.
 *
 * The tool lets the AI send notifications to any configured and enabled channel.
 * It reads the current channel configuration from HaloConfig at send time,
 * so it always uses the latest credentials.
 *
 * @param context - The current run's identity
 * @returns An SDK MCP server instance
 */
export function createNotifyToolServer(context: NotifyToolContext): SdkMcpServer {
  const sendNotification = tool(
    'send_notification',
    'Send a notification to an external channel (email, WeCom, DingTalk, Feishu, or webhook). ' +
    'Use this when you want to proactively notify the user on an external platform about something important.\n\n' +
    'The user must have configured the channel in Halo Settings first. ' +
    'Use list_notification_channels to check which channels are available before sending.\n\n' +
    'Example: { "channel": "wecom", "title": "Price Alert", "body": "AirPods Pro price dropped to ¥1199" }',
    {
      channel: z.enum(['email', 'wecom', 'dingtalk', 'feishu', 'webhook']).describe(
        'Target notification channel. Must be one of the configured and enabled channels.'
      ),
      title: z.string().describe(
        'Notification title. Keep it short and descriptive (e.g. "Price Alert", "Report Ready").'
      ),
      body: z.string().describe(
        'Notification body. The main content to deliver. Write for humans — be clear and direct.'
      ),
    },
    async (input) => {
      const runTag = context.runId.slice(0, 8)
      console.log(
        `[Runtime][${runTag}] send_notification called: channel=${input.channel}, title="${input.title}"`
      )

      // Read current config
      let config
      try {
        config = getConfig()
      } catch {
        return textResult('Failed to read notification configuration. Ensure Halo is properly initialized.', true)
      }

      const channelsConfig = config.notificationChannels
      if (!channelsConfig) {
        return textResult(
          'No notification channels configured. The user needs to set up channels in Settings > Notification Channels first.',
          true
        )
      }

      // Check if the requested channel is enabled
      const channelType = input.channel as NotificationChannelType
      const channelConfig = channelsConfig[channelType]
      if (!channelConfig?.enabled) {
        return textResult(
          `The "${input.channel}" channel is not enabled. Available channels: ${getEnabledChannels(channelsConfig).join(', ') || 'none'}. ` +
          'The user needs to enable it in Settings > Notification Channels.',
          true
        )
      }

      // Send the notification
      try {
        const result = await sendToChannel(channelType, channelsConfig, {
          title: input.title,
          body: input.body,
          appId: context.appId,
          appName: context.appName,
          timestamp: Date.now(),
        })

        if (result.success) {
          console.log(`[Runtime][${runTag}] Notification sent successfully via ${input.channel}`)
          return textResult(`Notification sent successfully via ${input.channel}.`)
        } else {
          console.warn(`[Runtime][${runTag}] Notification failed via ${input.channel}: ${result.error}`)
          return textResult(`Failed to send notification via ${input.channel}: ${result.error}`, true)
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[Runtime][${runTag}] Notification error:`, err)
        return textResult(`Error sending notification via ${input.channel}: ${errMsg}`, true)
      }
    }
  )

  const listChannels = tool(
    'list_notification_channels',
    'List all notification channels configured by the user and their enabled status. ' +
    'Call this before send_notification to check which channels are available.',
    {},
    async () => {
      const runTag = context.runId.slice(0, 8)
      console.log(`[Runtime][${runTag}] list_notification_channels called`)

      let config
      try {
        config = getConfig()
      } catch {
        return textResult('Failed to read configuration.', true)
      }

      const channelsConfig = config.notificationChannels
      if (!channelsConfig) {
        return textResult('No notification channels configured. The user needs to set up channels in Settings first.')
      }

      const enabled = getEnabledChannels(channelsConfig)
      if (enabled.length === 0) {
        return textResult('No notification channels are currently enabled. The user needs to enable at least one channel in Settings.')
      }

      return textResult(`Enabled notification channels: ${enabled.join(', ')}`)
    }
  )

  return createSdkMcpServer({
    name: 'halo-notify',
    version: '1.0.0',
    tools: [sendNotification, listChannels],
  })
}
