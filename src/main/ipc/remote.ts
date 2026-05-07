/**
 * Remote Access IPC Handlers
 * Allows renderer to control remote access features
 */

import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import {
  enableRemoteAccess,
  disableRemoteAccess,
  enableTunnel,
  disableTunnel,
  getRemoteAccessStatus,
  generateQRCode,
  onRemoteAccessStatusChange,
  setCustomPassword,
  regeneratePassword,
} from '../services/remote/access/remote.service';
import { getMainWindow, onMainWindowChange } from '../services/window.service';

let mainWindow: BrowserWindow | null = null;

export function registerRemoteHandlers(): void {
  // Subscribe to window changes
  onMainWindowChange((window) => {
    mainWindow = window;
  });

  // Enable remote access
  ipcMain.handle('remote:enable', async (_event, port?: number) => {
    console.log('[Settings] remote:enable - Enabling remote access', port ? `on port ${port}` : '');
    try {
      const status = await enableRemoteAccess(port);
      console.log('[Settings] remote:enable - Enabled, port:', status.port);
      return { success: true, data: status };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[Settings] remote:enable - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Disable remote access
  ipcMain.handle('remote:disable', async () => {
    console.log('[Settings] remote:disable - Disabling remote access');
    try {
      await disableRemoteAccess();
      console.log('[Settings] remote:disable - Disabled');
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[Settings] remote:disable - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Enable tunnel
  ipcMain.handle('remote:tunnel:enable', async () => {
    console.log('[Settings] remote:tunnel:enable - Enabling tunnel');
    try {
      const url = await enableTunnel();
      console.log('[Settings] remote:tunnel:enable - Enabled, url:', url);
      return { success: true, data: { url } };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[Settings] remote:tunnel:enable - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Disable tunnel
  ipcMain.handle('remote:tunnel:disable', async () => {
    console.log('[Settings] remote:tunnel:disable - Disabling tunnel');
    try {
      await disableTunnel();
      console.log('[Settings] remote:tunnel:disable - Disabled');
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[Settings] remote:tunnel:disable - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Get status
  ipcMain.handle('remote:status', async () => {
    try {
      const status = getRemoteAccessStatus();
      return { success: true, data: status };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[Settings] remote:status - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Generate QR code
  ipcMain.handle('remote:qrcode', async (_event, includeToken?: boolean) => {
    console.log('[Settings] remote:qrcode - Generating QR code, includeToken:', includeToken);
    try {
      const qrCode = await generateQRCode(includeToken);
      console.log('[Settings] remote:qrcode - Generated');
      return { success: true, data: { qrCode } };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[Settings] remote:qrcode - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Set up status change listener
  onRemoteAccessStatusChange((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('remote:status-change', status);
    }
  });

  // Set custom password
  ipcMain.handle('remote:set-password', async (_event, password: string) => {
    console.log('[Settings] remote:set-password - Setting custom password');
    try {
      const result = setCustomPassword(password);
      if (result.success) {
        console.log('[Settings] remote:set-password - Set successfully');
        return { success: true, data: getRemoteAccessStatus() };
      } else {
        console.warn('[Settings] remote:set-password - Validation failed:', result.error);
        return { success: false, error: result.error };
      }
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[Settings] remote:set-password - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Regenerate random password
  ipcMain.handle('remote:regenerate-password', async () => {
    console.log('[Settings] remote:regenerate-password - Regenerating password');
    try {
      regeneratePassword();
      console.log('[Settings] remote:regenerate-password - Regenerated');
      return { success: true, data: getRemoteAccessStatus() };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[Settings] remote:regenerate-password - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  console.log('[Settings] Remote handlers registered');
}
