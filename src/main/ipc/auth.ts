/**
 * Auth IPC Handlers (v2)
 *
 * Generic authentication handlers that work with any OAuth provider.
 * Provider types are configured in product.json and loaded dynamically.
 *
 * Channels:
 * - auth:start-login (providerType) - Start OAuth login for a provider
 * - auth:complete-login (providerType, state) - Complete OAuth login
 * - auth:refresh-token (sourceId) - Refresh token for a source (by ID)
 * - auth:check-token (sourceId) - Check token status (by ID)
 * - auth:logout (sourceId) - Logout from a source (by ID)
 * - auth:get-providers - Get list of available auth providers
 * - auth:get-builtin-providers - Get list of built-in providers
 */

import { ipcMain, BrowserWindow } from 'electron';
import { getAISourceManager, getEnabledAuthProviderConfigs } from '../services/ai-sources';
import { BUILTIN_PROVIDERS } from '../../shared/constants';
import type { ProviderId } from '../../shared/types';

/**
 * Register all authentication IPC handlers
 */
export function registerAuthHandlers(): void {
  const manager = getAISourceManager();

  /**
   * Get list of available authentication providers (OAuth)
   */
  ipcMain.handle('auth:get-providers', async () => {
    try {
      const providers = getEnabledAuthProviderConfigs();
      return { success: true, data: providers };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[Auth IPC] Get providers error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get list of built-in providers (for UI display)
   */
  ipcMain.handle('auth:get-builtin-providers', async () => {
    try {
      return { success: true, data: BUILTIN_PROVIDERS };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[Auth IPC] Get builtin providers error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Start OAuth login flow for a provider
   */
  ipcMain.handle('auth:start-login', async (_event, providerType: ProviderId) => {
    try {
      console.log(`[Auth IPC] Starting login for provider: ${providerType}`);
      const result = await manager.startOAuthLogin(providerType);
      return result;
    } catch (error: unknown) {
      const err = error as Error;
      console.error(`[Auth IPC] Start login error for ${providerType}:`, err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Complete OAuth login flow for a provider
   */
  ipcMain.handle('auth:complete-login', async (_event, providerType: ProviderId, state: string) => {
    try {
      console.log(`[Auth IPC] Completing login for provider: ${providerType}`);
      const mainWindow = BrowserWindow.getAllWindows()[0];

      // The manager's completeOAuthLogin handles everything including config save
      const result = await manager.completeOAuthLogin(providerType, state);

      // Send progress update on completion
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (result.success) {
          mainWindow.webContents.send('auth:login-progress', {
            provider: providerType,
            status: 'completed',
          });
        }
      }

      return result;
    } catch (error: unknown) {
      const err = error as Error;
      console.error(`[Auth IPC] Complete login error for ${providerType}:`, err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Refresh token for a source (by source ID)
   */
  ipcMain.handle('auth:refresh-token', async (_event, sourceId: string) => {
    try {
      const result = await manager.ensureValidToken(sourceId);
      return result;
    } catch (error: unknown) {
      const err = error as Error;
      console.error(`[Auth IPC] Refresh token error for ${sourceId}:`, err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Check token status for a source (by source ID)
   */
  ipcMain.handle('auth:check-token', async (_event, sourceId: string) => {
    try {
      const result = await manager.ensureValidToken(sourceId);
      if (result.success) {
        return { success: true, data: { valid: true, needsRefresh: false } };
      } else {
        return { success: true, data: { valid: false, reason: result.error } };
      }
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  /**
   * Logout from a source (by source ID)
   */
  ipcMain.handle('auth:logout', async (_event, sourceId: string) => {
    try {
      const result = await manager.logout(sourceId);
      return result;
    } catch (error: unknown) {
      const err = error as Error;
      console.error(`[Auth IPC] Logout error for ${sourceId}:`, err);
      return { success: false, error: err.message };
    }
  });

  console.log('[Auth IPC] Registered auth handlers');
}
