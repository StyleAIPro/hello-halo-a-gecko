/**
 * platform/background -- Main entry point
 *
 * Provides the initBackground() and shutdownBackground() functions
 * that wire together the keep-alive, tray, and daemon browser subsystems
 * into a single BackgroundService instance.
 *
 * Usage (from bootstrap/extended.ts):
 *   import { initBackground } from '../platform/background'
 *   const backgroundService = initBackground()
 *
 * The returned BackgroundService is the sole public API.
 */

import { app, BrowserWindow } from 'electron'
import { KeepAliveManager } from './keep-alive'
import { TrayManager } from './tray'
import { DaemonBrowserManager } from './daemon-browser'
import type {
  BackgroundService,
  BackgroundStatus,
  StatusChangeHandler,
  Unsubscribe
} from './types'

// ═══════════════════════════════════════════════════
// Module-level singleton state
// ═══════════════════════════════════════════════════

let service: BackgroundService | null = null
let keepAlive: KeepAliveManager | null = null
let tray: TrayManager | null = null
let daemonBrowser: DaemonBrowserManager | null = null

// Online/offline status
let currentStatus: BackgroundStatus = 'online'
const statusChangeHandlers: StatusChangeHandler[] = []

/**
 * Initialize the background service.
 *
 * Creates the keep-alive manager, tray, and daemon browser subsystems.
 * Returns the BackgroundService interface that is consumed by apps/runtime.
 *
 * This function is idempotent: calling it multiple times returns the same
 * service instance.
 */
export function initBackground(): BackgroundService {
  if (service) {
    return service
  }

  keepAlive = new KeepAliveManager()
  tray = new TrayManager()
  daemonBrowser = new DaemonBrowserManager()

  service = {
    // ── Tray ──────────────────────────────────

    initTray(): void {
      tray!.init({
        onShowWindow: showMainWindow,
        onGoOnline: () => service!.goOnline(),
        onGoOffline: () => service!.goOffline(),
        onQuit: () => {
          // Clear all keep-alive reasons so the process can exit cleanly
          keepAlive!.clearAll()
          app.quit()
        },
        getStatus: () => currentStatus,
        getActiveReasons: () => keepAlive!.getActiveReasons()
      })
    },

    // ── Keep-Alive ───────────────────────────

    shouldKeepAlive(): boolean {
      return keepAlive!.shouldKeepAlive()
    },

    registerKeepAliveReason(reason: string): Unsubscribe {
      const unregister = keepAlive!.register(reason)

      // Update tray menu to reflect new reason count
      tray?.updateMenu()

      return () => {
        unregister()
        tray?.updateMenu()
      }
    },

    // ── Daemon Browser ───────────────────────

    async getDaemonBrowserWindow(url: string): Promise<BrowserWindow> {
      return daemonBrowser!.getDaemonBrowserWindow(url)
    },

    releaseDaemonBrowserWindow(): void {
      daemonBrowser!.releaseDaemonBrowserWindow()
    },

    // ── Online / Offline ─────────────────────

    getStatus(): BackgroundStatus {
      return currentStatus
    },

    goOnline(): void {
      if (currentStatus === 'online') return
      currentStatus = 'online'
      console.log('[Background] Status changed to: online')
      notifyStatusChange()
      tray?.updateMenu()
    },

    goOffline(): void {
      if (currentStatus === 'offline') return
      currentStatus = 'offline'
      console.log('[Background] Status changed to: offline')
      notifyStatusChange()
      tray?.updateMenu()
    },

    onStatusChange(handler: StatusChangeHandler): Unsubscribe {
      statusChangeHandlers.push(handler)
      return () => {
        const index = statusChangeHandlers.indexOf(handler)
        if (index > -1) {
          statusChangeHandlers.splice(index, 1)
        }
      }
    }
  }

  console.log('[Background] Service initialized')
  return service
}

/**
 * Shutdown the background service.
 * Destroys the daemon browser, clears keep-alive reasons, and destroys the tray.
 *
 * Called from cleanupExtendedServices() during app shutdown.
 */
export function shutdownBackground(): void {
  console.log('[Background] Shutting down...')

  // Destroy daemon browser first (rejects queued requests)
  daemonBrowser?.destroy()
  daemonBrowser = null

  // Clear all keep-alive reasons
  keepAlive?.clearAll()
  keepAlive = null

  // Destroy tray
  tray?.destroy()
  tray = null

  // Clear status handlers
  statusChangeHandlers.length = 0

  service = null
  console.log('[Background] Shutdown complete')
}

/**
 * Get the current background service instance, or null if not initialized.
 * Used internally (e.g., by the modified window-all-closed handler).
 */
export function getBackgroundService(): BackgroundService | null {
  return service
}

// ═══════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════

/**
 * Notify all status change subscribers.
 */
function notifyStatusChange(): void {
  for (const handler of statusChangeHandlers) {
    try {
      handler(currentStatus)
    } catch (error) {
      console.error('[Background] Status change handler error:', error)
    }
  }
}

/**
 * Show the main window. Creates a new one if it was closed.
 * This is triggered by clicking "Show Halo" in the tray menu
 * or by clicking the tray icon on Windows.
 */
function showMainWindow(): void {
  const windows = BrowserWindow.getAllWindows()

  // Find a visible (non-daemon) window
  const mainWindow = windows.find(w => !w.isDestroyed() && w.isVisible())
    || windows.find(w => !w.isDestroyed())

  if (mainWindow) {
    if (!mainWindow.isVisible()) {
      mainWindow.show()
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.focus()

    // On macOS, also show in dock
    if (process.platform === 'darwin') {
      app.dock?.show()
    }
  } else {
    // No existing window. On macOS, this triggers the 'activate' event
    // which recreates the window via the handler in index.ts.
    // On other platforms, emit 'activate' manually.
    app.emit('activate')
  }
}

// Re-export types for convenience
export type { BackgroundService, BackgroundStatus, StatusChangeHandler, Unsubscribe } from './types'
