/**
 * Git Bash IPC Handlers - Windows Git Bash detection and installation
 *
 * All business logic is in git-bash.service.ts.
 * Handlers only do: receive params → call service → return result.
 */

import { ipcMain, shell } from 'electron';
import {
  getGitBashStatus,
  initializeGitBashOnStartup,
  setGitBashSkipped,
  completeGitBashInstallation,
} from '../services/git-bash.service';
import { downloadAndInstallGitBash } from '../services/git-bash-installer.service';
import { getMainWindow } from '../services/window.service';

// Re-export for bootstrap callers (they import from ipc/git-bash)
export { initializeGitBashOnStartup, setGitBashSkipped };

/**
 * Register Git Bash IPC handlers
 */
export function registerGitBashHandlers(): void {
  // Get Git Bash detection status
  ipcMain.handle('git-bash:status', async () => {
    try {
      const data = getGitBashStatus();
      return { success: true, data };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  });

  // Install Git Bash (download Portable Git)
  ipcMain.handle('git-bash:install', async (_event, { progressChannel }) => {
    try {
      const result = await downloadAndInstallGitBash((progress) => {
        const window = getMainWindow();
        if (window && !window.isDestroyed()) {
          window.webContents.send(progressChannel, progress);
        }
      });

      if (result.success && result.path) {
        completeGitBashInstallation(result.path);
      }

      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  });

  // Open external URL (for manual download link)
  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    await shell.openExternal(url);
  });
}
