import { wrapIpcHandle } from './ipc-logger';
/**
 * GitCode IPC Handlers - GitCode authentication
 */

import { ipcMain } from 'electron';
import {
  getGitCodeAuthStatus,
  loginWithGitCodeToken,
  logoutGitCode,
} from '../services/auth/gitcode-auth.service';

export function registerGitCodeHandlers(): void {
  // Get GitCode authentication status
  wrapIpcHandle('gitcode:auth-status', async () => {
    try {
      const data = await getGitCodeAuthStatus();
      return { success: true, data };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  });

  // Login with Personal Access Token
  wrapIpcHandle('gitcode:login-token', async (_event, token: string) => {
    try {
      return await loginWithGitCodeToken(token);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  });

  // Logout from GitCode
  wrapIpcHandle('gitcode:logout', async () => {
    try {
      return logoutGitCode();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  });

  console.log('[GitCodeIPC] GitCode handlers registered');
}
