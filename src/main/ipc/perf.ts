/**
 * Performance Monitoring IPC Handlers
 *
 * Exposes performance monitoring functionality to the renderer process.
 */

import { ipcMain, BrowserWindow } from 'electron'
import { perfService } from '../services/perf'
import type { PerfConfig, PerfSnapshot, PerfServiceState, RendererMetrics } from '../services/perf'

/**
 * Register performance monitoring IPC handlers
 */
export function registerPerfHandlers(mainWindow: BrowserWindow): void {
  // Set main window reference for event emission
  perfService.setMainWindow(mainWindow)

  // Start monitoring
  ipcMain.handle('perf:start', async (_event, config?: Partial<PerfConfig>) => {
    try {
      await perfService.start(config)
      return { success: true }
    } catch (error) {
      console.error('[Perf IPC] Start failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Stop monitoring
  ipcMain.handle('perf:stop', async () => {
    try {
      perfService.stop()
      return { success: true }
    } catch (error) {
      console.error('[Perf IPC] Stop failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Get current state
  ipcMain.handle('perf:get-state', async () => {
    try {
      return { success: true, data: perfService.getState() }
    } catch (error) {
      console.error('[Perf IPC] Get state failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Get history
  ipcMain.handle('perf:get-history', async () => {
    try {
      return { success: true, data: perfService.getHistory() }
    } catch (error) {
      console.error('[Perf IPC] Get history failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Clear history
  ipcMain.handle('perf:clear-history', async () => {
    try {
      perfService.clearHistory()
      return { success: true }
    } catch (error) {
      console.error('[Perf IPC] Clear history failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Update config
  ipcMain.handle('perf:set-config', async (_event, config: Partial<PerfConfig>) => {
    try {
      perfService.setConfig(config)
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // Export data
  ipcMain.handle('perf:export', async () => {
    try {
      return { success: true, data: perfService.export() }
    } catch (error) {
      console.error('[Perf IPC] Export failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Receive renderer metrics (one-way, no response needed)
  ipcMain.on('perf:renderer-metrics', (_event, metrics: RendererMetrics) => {
    perfService.updateRendererMetrics(metrics)
  })

  console.log('[Perf IPC] Handlers registered')
}
