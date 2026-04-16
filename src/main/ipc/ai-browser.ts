/**
 * AI Browser IPC Handlers
 *
 * Handles IPC communication for the AI Browser functionality.
 * Provides endpoints for:
 * - Getting tool names and system prompt
 * - Managing AI Browser state
 *
 * NOTE: Tool execution is handled by SDK MCP Server, not IPC.
 * These handlers are only for metadata and state management.
 *
 * LAZY INITIALIZATION:
 * This module uses lazy initialization to improve startup performance.
 * The AI Browser module is only loaded when first needed.
 */

import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { onMainWindowChange } from '../services/window.service';

// Lazy-loaded module references
let aiBrowserModule: typeof import('../services/ai-browser') | null = null;
let mainWindowRef: BrowserWindow | null = null;
let initialized = false;

/**
 * Ensure AI Browser module is loaded and initialized
 * Called on first use of any AI Browser functionality
 */
async function ensureInitialized(): Promise<typeof import('../services/ai-browser')> {
  if (!aiBrowserModule) {
    console.log('[AI Browser IPC] Lazy loading AI Browser module...');
    const start = performance.now();

    // Dynamic import to defer module loading
    aiBrowserModule = await import('../services/ai-browser');

    const duration = performance.now() - start;
    console.log(`[AI Browser IPC] Module loaded in ${duration.toFixed(1)}ms`);
  }

  if (!initialized && mainWindowRef) {
    console.log('[AI Browser IPC] Initializing AI Browser...');
    aiBrowserModule.initializeAIBrowser(mainWindowRef);
    initialized = true;
  }

  return aiBrowserModule;
}

/**
 * Register all AI Browser IPC handlers
 *
 * NOTE: This function only registers IPC handlers for metadata and state.
 * Actual tool execution is handled by SDK MCP Server (createAIBrowserMcpServer).
 */
export function registerAIBrowserHandlers(): void {
  // Subscribe to window changes
  onMainWindowChange((window) => {
    mainWindowRef = window;
  });

  // ============================================
  // Tool Information
  // ============================================

  /**
   * Get all AI Browser tool names
   * Used by SDK to populate allowedTools
   */
  ipcMain.handle('ai-browser:get-tool-names', async () => {
    try {
      const module = await ensureInitialized();
      const toolNames = module.getAIBrowserToolNames();
      return { success: true, data: toolNames };
    } catch (error) {
      console.error('[AI Browser IPC] Get tool names failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get AI Browser system prompt addition
   * Used to augment system prompt when AI Browser is enabled
   */
  ipcMain.handle('ai-browser:get-system-prompt', async () => {
    try {
      const module = await ensureInitialized();
      return { success: true, data: module.AI_BROWSER_SYSTEM_PROMPT };
    } catch (error) {
      console.error('[AI Browser IPC] Get system prompt failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Check if a tool is an AI Browser tool
   */
  ipcMain.handle(
    'ai-browser:is-browser-tool',
    async (_event, { toolName }: { toolName: string }) => {
      try {
        const module = await ensureInitialized();
        return { success: true, data: module.isAIBrowserTool(toolName) };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  );

  // ============================================
  // State Management
  // ============================================

  /**
   * Set the active browser view for AI operations
   */
  ipcMain.handle('ai-browser:set-active-view', async (_event, { viewId }: { viewId: string }) => {
    try {
      const module = await ensureInitialized();
      module.setActiveBrowserView(viewId);
      return { success: true };
    } catch (error) {
      console.error('[AI Browser IPC] Set active view failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  console.log('[AI Browser IPC] Handlers registered (lazy initialization enabled)');
}

/**
 * Cleanup AI Browser resources
 */
export function cleanupAIBrowserHandlers(): void {
  // Only cleanup if module was actually loaded
  if (aiBrowserModule && initialized) {
    aiBrowserModule.cleanupAIBrowser();
    console.log('[AI Browser IPC] Module cleaned up');
  }

  // Reset state
  aiBrowserModule = null;
  mainWindowRef = null;
  initialized = false;

  console.log('[AI Browser IPC] Handlers cleaned up');
}
