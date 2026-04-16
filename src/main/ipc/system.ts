/**
 * System IPC Handlers - Auto launch, window controls, and logging
 */

import { ipcMain, BrowserWindow, shell } from 'electron'
import { dirname } from 'path'
import log from 'electron-log/main.js'
import { setAutoLaunch, getAutoLaunch } from '../services/config.service'
import { getMainWindow, onMainWindowChange } from '../services/window.service'
import { getServerInfo } from '../http/server'
import { validateToken } from '../http/auth'
import { forceDwmCleanup, dwmFlush } from '../services/win32-hwnd-cleanup'

let mainWindow: BrowserWindow | null = null

export function registerSystemHandlers(): void {
  // Subscribe to window changes to set up event listeners
  onMainWindowChange((window) => {
    mainWindow = window
    if (window) {
      // Listen for maximize/unmaximize events and notify renderer
      window.on('maximize', () => {
        window.webContents.send('window:maximize-change', true)
      })
      window.on('unmaximize', () => {
        window.webContents.send('window:maximize-change', false)
      })

      // Auto force-repaint on window focus (Windows only)
      // Fixes the BrowserView HWND click-blocking bug where a transparent
      // BrowserView overlay blocks input after the view was hidden.
      // DWM re-composition on focus return clears the stale HWND.
      if (process.platform === 'win32') {
        window.on('focus', () => {
          forceRepaint(window)
        })
      }
    }
  })

  // Get auto launch status
  ipcMain.handle('system:get-auto-launch', async () => {
    console.log('[Settings] system:get-auto-launch - Getting auto launch status')
    try {
      const enabled = getAutoLaunch()
      console.log('[Settings] system:get-auto-launch - Status:', enabled)
      return { success: true, data: enabled }
    } catch (error) {
      const err = error as Error
      console.error('[Settings] system:get-auto-launch - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  // Set auto launch
  ipcMain.handle('system:set-auto-launch', async (_event, enabled: boolean) => {
    console.log('[Settings] system:set-auto-launch - Setting to:', enabled)
    try {
      setAutoLaunch(enabled)
      console.log('[Settings] system:set-auto-launch - Set successfully')
      return { success: true, data: enabled }
    } catch (error) {
      const err = error as Error
      console.error('[Settings] system:set-auto-launch - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  // Set title bar overlay (Windows/Linux only)
  ipcMain.handle(
    'window:set-title-bar-overlay',
    async (_event, options: { color: string; symbolColor: string }) => {
      try {
        // Only works on Windows/Linux with titleBarOverlay enabled
        if (process.platform !== 'darwin' && mainWindow) {
          mainWindow.setTitleBarOverlay({
            color: options.color,
            symbolColor: options.symbolColor,
            height: 40
          })
        }
        return { success: true }
      } catch (error) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    }
  )

  // Maximize window
  ipcMain.handle('window:maximize', async () => {
    try {
      if (mainWindow) {
        mainWindow.maximize()
      }
      return { success: true }
    } catch (error) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Unmaximize window
  ipcMain.handle('window:unmaximize', async () => {
    try {
      if (mainWindow) {
        mainWindow.unmaximize()
      }
      return { success: true }
    } catch (error) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Check if window is maximized
  ipcMain.handle('window:is-maximized', async () => {
    try {
      const isMaximized = mainWindow?.isMaximized() ?? false
      return { success: true, data: isMaximized }
    } catch (error) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Toggle maximize
  ipcMain.handle('window:toggle-maximize', async () => {
    try {
      if (mainWindow) {
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize()
        } else {
          mainWindow.maximize()
        }
      }
      return { success: true, data: mainWindow?.isMaximized() ?? false }
    } catch (error) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Open log folder in system file manager
  ipcMain.handle('system:open-log-folder', async () => {
    console.log('[Settings] system:open-log-folder - Opening log folder')
    try {
      const logFile = log.transports.file.getFile()
      const logDir = dirname(logFile.path)
      await shell.openPath(logDir)
      console.log('[Settings] system:open-log-folder - Opened:', logDir)
      return { success: true, data: logDir }
    } catch (error) {
      const err = error as Error
      console.error('[Settings] system:open-log-folder - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  // Get terminal WebSocket URL
  ipcMain.handle('system:get-terminal-websocket-url', async (_event, spaceId: string, conversationId: string) => {
    try {
      const serverInfo = getServerInfo()
      const token = serverInfo.token || 'local-electron-mode'
      const wsUrl = `ws://localhost:8765/terminal?spaceId=${spaceId}&conversationId=${conversationId}&token=${token}`
      console.log(`[Terminal] WebSocket URL generated for space=${spaceId}, conv=${conversationId}`)
      return { success: true, data: { wsUrl } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // Send command to user terminal
  ipcMain.handle('terminal:send-command', async (_event, { spaceId, conversationId, command }: { spaceId: string, conversationId: string, command: string }) => {
    try {
      const { terminalGateway } = await import('../services/terminal/terminal-gateway')

      // Send command to terminal gateway
      terminalGateway.onUserCommand(spaceId, conversationId, command)

      console.log(`[Terminal] Command sent: ${command}`)
      return { success: true }
    } catch (error) {
      const err = error as Error
      console.error('[Terminal] Failed to send command:', err.message)
      return { success: false, error: err.message }
    }
  })

  // Get recent terminal output
  ipcMain.handle('terminal:get-output', async (_event, { spaceId, conversationId, lines }: { spaceId: string, conversationId: string, lines?: number }) => {
    try {
      const { sharedTerminalService } = await import('../services/terminal/shared-terminal-service')

      const sessionId = `${spaceId}:${conversationId}`
      const session = sharedTerminalService.getSession(sessionId)

      if (!session) {
        return { success: false, error: 'No active terminal session' }
      }

      const outputLines = session.getRecentOutput(lines || 50)
      return { success: true, data: { lines: outputLines.map(line => line.content) } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // Force window repaint (fixes BrowserView HWND click-blocking on Windows)
  ipcMain.handle('window:force-repaint', async () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        forceRepaint(mainWindow)
      }
      return { success: true }
    } catch (error) {
      const err = error as Error
      console.error('[System] force-repaint failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  console.log('[Settings] System handlers registered')
}

/**
 * Force a window repaint to clear stale BrowserView HWND overlays.
 *
 * On Windows, Electron's removeBrowserView() can silently fail, leaving a
 * transparent HWND that blocks all pointer events.
 *
 * Strategy:
 * 1. Try native DwmFlush + SetWindowPos(SWP_FRAMECHANGED) via koffi.
 *    This directly forces the DWM to finish composition and rebuild its tree,
 *    which is the exact same mechanism that fires when opening/closing a
 *    native dialog (e.g. file picker).
 * 2. Fallback: Chromium invalidate() + tiny size change cycle.
 */
function forceRepaint(window: BrowserWindow): void {
  if (window.isDestroyed() || window.isMinimized()) return

  try {
    // Try native DWM cleanup first (most reliable)
    const nativeOk = forceDwmCleanup(window)
    if (nativeOk) {
      // Also invalidate the Chromium compositor as a belt-and-suspenders measure
      try {
        window.webContents.invalidate()
      } catch (_e) {
        // Ignore
      }
      return
    }
  } catch (_e) {
    // Native cleanup failed, fall through to fallback
  }

  // Fallback: Chromium-level tricks (less reliable than native DWM flush)
  try {
    // Tiny size change to trigger DWM re-composition
    const [width, height] = window.getSize()
    window.setSize(width, height + 1)
    setImmediate(() => {
      if (!window.isDestroyed()) {
        window.setSize(width, height)
      }
    })

    // Also invalidate renderer to force GPU redraw
    try {
      window.webContents.invalidate()
    } catch (_e) {
      // Ignore
    }
  } catch (_e) {
    // Ignore - best effort
  }
}
