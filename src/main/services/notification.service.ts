/**
 * Notification Service — System + In-App + External channel notifications
 *
 * Triple delivery strategy:
 * 1. OS-level Electron Notification (banner + Notification Center) — when window NOT focused
 * 2. In-app toast via IPC `notification:toast` — when window IS focused
 * 3. External channels (email, WeCom, DingTalk, Feishu, webhook) — when configured in output.notify.channels
 *
 * This ensures the user always sees the notification regardless of window state,
 * and can also receive notifications on external platforms for background automation.
 *
 * Specific triggers:
 * - Task completion (config-gated, background only)
 * - Automation app events (escalation, milestone, output)
 * - Automation app completion with output.notify enabled
 */

import { Notification } from 'electron'
import { getConfig } from './config.service'
import { getMainWindow, sendToRenderer } from './window.service'
import type { NotificationChannelType } from '../../shared/types/notification-channels'
import { sendToChannels } from './notify-channels'

// ── Helpers ────────────────────────────────────────────

/**
 * Check if the main window is currently focused.
 */
function isWindowFocused(): boolean {
  const mainWindow = getMainWindow()
  return !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused())
}

/**
 * Send an in-app toast to the renderer process.
 * The renderer's NotificationToast component picks this up via the notification store.
 */
function sendInAppToast(
  title: string,
  body: string,
  options?: { appId?: string; variant?: 'default' | 'success' | 'warning' | 'error'; duration?: number }
): void {
  const sent = sendToRenderer('notification:toast', {
    title,
    body,
    variant: options?.variant ?? 'default',
    duration: options?.duration ?? 0,
    appId: options?.appId,
  })
  console.log(`[Notification] In-app toast sent=${sent}: title="${title}"`)
}

// ── Public API ─────────────────────────────────────────

/**
 * Send a system notification when a task completes.
 * Only fires if:
 * 1. Notifications are enabled in config
 * 2. The main window is not currently focused
 * 3. The Electron Notification API is supported
 */
export function notifyTaskComplete(conversationTitle: string): void {
  // Skip if notifications aren't supported
  if (!Notification.isSupported()) return

  // Skip if window is focused - user is already looking at the app
  if (isWindowFocused()) return

  // Check config preference
  try {
    const config = getConfig()
    if (!config.notifications?.taskComplete) return
  } catch {
    // Config not available, skip silently
    return
  }

  try {
    const mainWindow = getMainWindow()
    const notification = new Notification({
      title: 'Halo',
      body: `Task complete: ${conversationTitle}`,
      silent: false
    })

    notification.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
      }
    })

    notification.show()
  } catch (error) {
    console.error('[Notification] Failed to show notification:', error)
  }
}

/**
 * Options for app event notifications.
 */
interface AppNotificationOptions {
  /** App ID — enables deep navigation to the App's Activity Thread on click */
  appId?: string
  /** External notification channels to deliver to (from output.notify.channels) */
  channels?: NotificationChannelType[]
  /** Skip system/in-app notification (when output.notify.system === false) */
  skipSystem?: boolean
}

/**
 * Send a notification for an automation app event.
 *
 * Delivery strategy:
 * - System notification: OS-level (unfocused) or in-app toast (focused)
 * - External channels: fire-and-forget to configured channels (email, WeCom, etc.)
 *
 * When `appId` is provided:
 * - OS notification click → navigates to the App's Activity Thread
 * - In-app toast includes appId for the renderer to handle navigation
 *
 * @param title   - Notification title (typically the app name)
 * @param body    - Notification body text
 * @param options - Optional: appId, channels, skipSystem
 */
export function notifyAppEvent(title: string, body: string, options?: AppNotificationOptions): void {
  console.log(`[Notification] notifyAppEvent called: title="${title}", appId=${options?.appId}, channels=${options?.channels?.join(',') ?? 'none'}`)

  // ── 1. System / In-App notification ──
  if (!options?.skipSystem) {
    const focused = isWindowFocused()
    console.log(`[Notification] mainWindow focused=${focused}`)

    if (focused) {
      // Window is focused — macOS suppresses OS notifications for foreground apps.
      // Send an in-app toast instead so the user always sees it.
      sendInAppToast(title, body, { appId: options?.appId, variant: 'default' })
    } else if (!Notification.isSupported()) {
      console.warn('[Notification] Notification.isSupported() = false — falling back to in-app toast')
      sendInAppToast(title, body, { appId: options?.appId, variant: 'default' })
    } else {
      try {
        const mainWindow = getMainWindow()

        const notification = new Notification({
          title,
          body,
          silent: false,
        })

        notification.on('click', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.focus()

            // Deep navigation: tell the renderer to open this App's Activity Thread
            if (options?.appId) {
              sendToRenderer('app:navigate', { appId: options.appId })
            }
          }
        })

        notification.show()
        console.log(`[Notification] OS notification.show() called`)
      } catch (error) {
        console.error('[Notification] Failed to show app event notification:', error)
        // Fallback to in-app toast if OS notification fails
        sendInAppToast(title, body, { appId: options?.appId, variant: 'default' })
      }
    }
  }

  // ── 2. External channel notifications (fire-and-forget) ──
  if (options?.channels && options.channels.length > 0) {
    notifyExternalChannels(title, body, options.channels, options.appId)
  }
}

/**
 * Send notifications to external channels.
 * This is fire-and-forget — errors are logged but don't propagate.
 */
function notifyExternalChannels(
  title: string,
  body: string,
  channels: NotificationChannelType[],
  appId?: string
): void {
  // Read channel config from global config
  let config
  try {
    config = getConfig()
  } catch {
    console.error('[Notification] Cannot read config for external channels')
    return
  }

  const channelsConfig = config.notificationChannels
  if (!channelsConfig) {
    console.warn('[Notification] External channels requested but no notificationChannels configured')
    return
  }

  console.log(`[Notification] Dispatching to external channels: ${channels.join(', ')}`)

  // Fire-and-forget — don't await
  sendToChannels(channels, channelsConfig, {
    title,
    body,
    appId,
    appName: title, // title is typically the app name
    timestamp: Date.now(),
  }).then(results => {
    const failed = results.filter(r => !r.success)
    if (failed.length > 0) {
      console.warn(`[Notification] Some external channels failed:`, failed.map(f => `${f.channel}: ${f.error}`).join('; '))
    } else {
      console.log(`[Notification] All ${results.length} external channels delivered successfully`)
    }
  }).catch(err => {
    console.error('[Notification] External channel dispatch error:', err)
  })
}
