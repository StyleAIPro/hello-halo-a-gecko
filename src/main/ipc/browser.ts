/**
 * Browser IPC Handlers
 *
 * Handles IPC communication for the embedded browser functionality.
 * Connects the renderer process to the BrowserView manager.
 */

import type { BrowserWindow } from 'electron';
import { ipcMain, Menu, shell, MenuItemConstructorOptions } from 'electron';
import { browserViewManager, type BrowserViewBounds } from '../services/browser-view.service';
import type { BrowserMenuOptions, CanvasTabMenuOptions } from '../services/browser-menu.service';

/**
 * Register all browser-related IPC handlers
 */
export function registerBrowserHandlers(mainWindow: BrowserWindow | null) {
  if (!mainWindow) {
    console.warn('[Browser IPC] No main window provided, skipping registration');
    return;
  }

  // Initialize the BrowserView manager
  browserViewManager.initialize(mainWindow);

  // ============================================
  // Lifecycle
  // ============================================

  /**
   * Create a new BrowserView
   */
  ipcMain.handle(
    'browser:create',
    async (_event, { viewId, url }: { viewId: string; url?: string }) => {
      console.log(`[Browser IPC] >>> browser:create received - viewId: ${viewId}, url: ${url}`);
      try {
        const state = await browserViewManager.create(viewId, url);
        console.log(`[Browser IPC] <<< browser:create success`);
        return { success: true, data: state };
      } catch (error) {
        console.error('[Browser IPC] Create failed:', error);
        return { success: false, error: (error as Error).message };
      }
    },
  );

  /**
   * Destroy a BrowserView
   */
  ipcMain.handle('browser:destroy', async (_event, { viewId }: { viewId: string }) => {
    try {
      browserViewManager.destroy(viewId);
      return { success: true };
    } catch (error) {
      console.error('[Browser IPC] Destroy failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Show a BrowserView at specified bounds
   */
  ipcMain.handle(
    'browser:show',
    async (_event, { viewId, bounds }: { viewId: string; bounds: BrowserViewBounds }) => {
      console.log(`[Browser IPC] >>> browser:show received - viewId: ${viewId}, bounds:`, bounds);
      try {
        const result = browserViewManager.show(viewId, bounds);
        console.log(`[Browser IPC] <<< browser:show result: ${result}`);
        return { success: result };
      } catch (error) {
        console.error('[Browser IPC] Show failed:', error);
        return { success: false, error: (error as Error).message };
      }
    },
  );

  /**
   * Hide a BrowserView
   */
  ipcMain.handle(
    'browser:hide',
    async (_event, { viewId, force = false }: { viewId: string; force?: boolean }) => {
      try {
        const result = browserViewManager.hide(viewId, force);
        return { success: result };
      } catch (error) {
        console.error('[Browser IPC] Hide failed:', error);
        return { success: false, error: (error as Error).message };
      }
    },
  );

  /**
   * Resize a BrowserView
   */
  ipcMain.handle(
    'browser:resize',
    async (_event, { viewId, bounds }: { viewId: string; bounds: BrowserViewBounds }) => {
      try {
        const result = browserViewManager.resize(viewId, bounds);
        return { success: result };
      } catch (error) {
        console.error('[Browser IPC] Resize failed:', error);
        return { success: false, error: (error as Error).message };
      }
    },
  );

  // ============================================
  // Navigation
  // ============================================

  /**
   * Navigate to a URL
   */
  ipcMain.handle(
    'browser:navigate',
    async (_event, { viewId, url }: { viewId: string; url: string }) => {
      try {
        const result = await browserViewManager.navigate(viewId, url);
        return { success: result };
      } catch (error) {
        console.error('[Browser IPC] Navigate failed:', error);
        return { success: false, error: (error as Error).message };
      }
    },
  );

  /**
   * Go back in history
   */
  ipcMain.handle('browser:go-back', async (_event, { viewId }: { viewId: string }) => {
    try {
      const result = browserViewManager.goBack(viewId);
      return { success: result };
    } catch (error) {
      console.error('[Browser IPC] GoBack failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Go forward in history
   */
  ipcMain.handle('browser:go-forward', async (_event, { viewId }: { viewId: string }) => {
    try {
      const result = browserViewManager.goForward(viewId);
      return { success: result };
    } catch (error) {
      console.error('[Browser IPC] GoForward failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Reload the page
   */
  ipcMain.handle('browser:reload', async (_event, { viewId }: { viewId: string }) => {
    try {
      const result = browserViewManager.reload(viewId);
      return { success: result };
    } catch (error) {
      console.error('[Browser IPC] Reload failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Stop loading
   */
  ipcMain.handle('browser:stop', async (_event, { viewId }: { viewId: string }) => {
    try {
      const result = browserViewManager.stop(viewId);
      return { success: result };
    } catch (error) {
      console.error('[Browser IPC] Stop failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // ============================================
  // State & Tools
  // ============================================

  /**
   * Get current state
   */
  ipcMain.handle('browser:get-state', async (_event, { viewId }: { viewId: string }) => {
    try {
      const state = browserViewManager.getState(viewId);
      return { success: true, data: state };
    } catch (error) {
      console.error('[Browser IPC] GetState failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Capture screenshot
   */
  ipcMain.handle('browser:capture', async (_event, { viewId }: { viewId: string }) => {
    try {
      const dataUrl = await browserViewManager.capture(viewId);
      return { success: true, data: dataUrl };
    } catch (error) {
      console.error('[Browser IPC] Capture failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Execute JavaScript
   */
  ipcMain.handle(
    'browser:execute-js',
    async (_event, { viewId, code }: { viewId: string; code: string }) => {
      try {
        const result = await browserViewManager.executeJS(viewId, code);
        return { success: true, data: result };
      } catch (error) {
        console.error('[Browser IPC] ExecuteJS failed:', error);
        return { success: false, error: (error as Error).message };
      }
    },
  );

  /**
   * Set zoom level
   */
  ipcMain.handle(
    'browser:zoom',
    async (_event, { viewId, level }: { viewId: string; level: number }) => {
      try {
        const result = browserViewManager.setZoom(viewId, level);
        return { success: result };
      } catch (error) {
        console.error('[Browser IPC] Zoom failed:', error);
        return { success: false, error: (error as Error).message };
      }
    },
  );

  /**
   * Toggle DevTools
   */
  ipcMain.handle('browser:dev-tools', async (_event, { viewId }: { viewId: string }) => {
    try {
      const result = browserViewManager.toggleDevTools(viewId);
      return { success: result };
    } catch (error) {
      console.error('[Browser IPC] DevTools toggle failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Show native context menu for browser
   */
  ipcMain.handle('browser:show-context-menu', async (_event, options: BrowserMenuOptions) => {
    try {
      const { buildBrowserContextMenu } = await import('../services/browser-menu.service');
      const menu = buildBrowserContextMenu(options, mainWindow);
      menu.popup({ window: mainWindow || undefined });
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Show native context menu for canvas tabs
   */
  ipcMain.handle('canvas:show-tab-context-menu', async (_event, options: CanvasTabMenuOptions) => {
    try {
      const { buildCanvasTabContextMenu } = await import('../services/browser-menu.service');
      const menu = buildCanvasTabContextMenu(options, mainWindow);
      menu.popup({ window: mainWindow || undefined });
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  console.log('[Browser IPC] Handlers registered');
}
