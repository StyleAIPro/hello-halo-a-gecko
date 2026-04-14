/**
 * GitHub IPC Handlers - GitHub authentication and git configuration
 */

import { ipcMain, shell } from 'electron'
import {
  getGitHubAuthStatus,
  loginWithBrowser,
  loginWithToken,
  logoutGitHub,
  setupGitCredentialHelper,
  setGitConfig,
  getGitConfig,
  getDirectGitHubAuthStatus,
  loginWithDirectToken,
  logoutDirectGitHub,
  setupGitCredentialsWithToken
} from '../services/github-auth.service'
import { getMainWindow } from '../services/window.service'

/**
 * Register GitHub IPC handlers
 */
export function registerGitHubHandlers(): void {

  // Get GitHub authentication status
  ipcMain.handle('github:auth-status', async () => {
    try {
      const data = await getGitHubAuthStatus()
      return { success: true, data }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })

  // Login via browser OAuth
  // Uses spawn to capture the device code, then opens browser via shell.openExternal
  ipcMain.handle('github:login-browser', async () => {
    try {
      const result = await loginWithBrowser((progress) => {
        // When we get the code, open the browser automatically
        if (progress.url) {
          shell.openExternal(progress.url).catch(() => {})
        }
        // Forward progress to renderer
        const window = getMainWindow()
        if (window && !window.isDestroyed()) {
          window.webContents.send('github:login-progress', progress)
        }
      })
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })

  // Login with Personal Access Token
  ipcMain.handle('github:login-token', async (_event, token: string) => {
    try {
      const result = await loginWithToken(token)
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })

  // Logout from GitHub
  ipcMain.handle('github:logout', async () => {
    try {
      const result = await logoutGitHub()
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })

  // Setup git credential helper
  ipcMain.handle('github:setup-git-credentials', async () => {
    try {
      const result = await setupGitCredentialHelper()
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })

  // Set git global config
  ipcMain.handle('github:git-config', async (_event, key: string, value: string) => {
    try {
      const result = await setGitConfig(key, value)
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })

  // Get git global config
  ipcMain.handle('github:get-git-config', async (_event, key: string) => {
    try {
      const result = await getGitConfig(key)
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })

  // ── Direct PAT authentication (no gh CLI) ──────────────────────────

  // Get direct PAT auth status
  ipcMain.handle('github:direct-auth-status', async () => {
    try {
      const data = await getDirectGitHubAuthStatus()
      return { success: true, data }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })

  // Login with direct PAT
  ipcMain.handle('github:direct-login-token', async (_event, token: string) => {
    try {
      const result = await loginWithDirectToken(token)
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })

  // Logout from direct PAT mode
  ipcMain.handle('github:direct-logout', async () => {
    try {
      await logoutDirectGitHub()
      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })

  // Setup git credentials with stored PAT
  ipcMain.handle('github:direct-setup-credentials', async () => {
    try {
      const result = await setupGitCredentialsWithToken()
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })
}
