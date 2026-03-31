/**
 * GitHub Auth Service
 *
 * Wraps gh CLI and git config commands for the GitHub settings UI.
 * Uses the bundled gh binary from resources/gh/{platform}/.
 */

import { exec, execSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface GitHubAuthStatus {
  authenticated: boolean
  user: string | null
  hostname: string | null
  protocol: string | null
  error?: string
}

/**
 * Resolve the bundled gh CLI binary path.
 * Checks resources/gh/{platform}/ first, then falls back to system PATH.
 */
function getGhBin(): string {
  try {
    const os = require('os')
    const { app } = require('electron')

    const platform = os.platform()
    const arch = os.arch()

    let platformDir: string
    if (platform === 'darwin') {
      platformDir = arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
    } else if (platform === 'win32') {
      platformDir = 'win-x64'
    } else if (platform === 'linux') {
      platformDir = 'linux-x64'
    } else {
      return 'gh'
    }

    const binaryName = platform === 'win32' ? 'gh.exe' : 'gh'
    let binPath = join(app.getAppPath(), 'resources', 'gh', platformDir, binaryName)

    // Fix path for packaged Electron app (asar -> asar.unpacked)
    if (binPath.includes('app.asar')) {
      binPath = binPath.replace('app.asar', 'app.asar.unpacked')
    }

    if (existsSync(binPath)) {
      return binPath
    }
  } catch {
    // Electron not available or path resolution failed
  }

  return 'gh'
}

/**
 * Run a gh CLI command.
 */
async function execGh(args: string, timeout = 30_000): Promise<{ stdout: string; stderr: string }> {
  const ghBin = getGhBin()
  return execAsync(`"${ghBin}" ${args}`, { timeout, maxBuffer: 10 * 1024 * 1024 })
}

/**
 * Run a git command.
 */
async function execGit(args: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(`git ${args}`, { timeout: 10_000 })
}

/**
 * Check if gh binary is available (bundled or system).
 */
export function isGhAvailable(): boolean {
  const ghBin = getGhBin()
  try {
    execSync(`"${ghBin}" --version`, { timeout: 5_000, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Get current GitHub CLI authentication status.
 */
export async function getGitHubAuthStatus(): Promise<GitHubAuthStatus> {
  const ghBin = getGhBin()
  let combinedOutput = ''

  try {
    const { stdout, stderr } = await execAsync(`"${ghBin}" auth status`, {
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024
    })
    combinedOutput = `${stdout}\n${stderr}`
  } catch (error: any) {
    // gh auth status may exit with non-zero even when authenticated
    // The output is still in error.stdout / error.stderr
    if (error.code === 'ENOENT') {
      return {
        authenticated: false,
        user: null,
        hostname: null,
        protocol: null,
        error: 'GitHub CLI (gh) is not available. Please run "npm run prepare" to download it.'
      }
    }
    combinedOutput = `${error.stdout || ''}\n${error.stderr || ''}`
    if (!combinedOutput.trim()) {
      return {
        authenticated: false,
        user: null,
        hostname: null,
        protocol: null,
        error: error.message
      }
    }
  }

  // Parse output from various gh CLI versions:
  //   ✓ Logged in to github.com as octocat (oauth_token)
  //   ✓ Logged in to github.com account StyleAIPro (keyring)
  //   ✓ Logged in to github.com as octocat [oauth_token]  (some builds)
  // Some versions include trailing punctuation or parentheses that \S+ would capture.
  const userMatch = combinedOutput.match(/Logged in to github\.com (?:as|account) (\w[\w-]*)/)
  const protocolMatch = combinedOutput.match(/Git operations protocol: (https|ssh)/)
    || combinedOutput.match(/\((\w+)_token\)/)

  if (userMatch) {
    return {
      authenticated: true,
      user: userMatch[1],
      hostname: 'github.com',
      protocol: protocolMatch ? protocolMatch[1] : null
    }
  }

  return {
    authenticated: false,
    user: null,
    hostname: null,
    protocol: null
  }
}

/**
 * Login via browser OAuth flow.
 * Uses spawn to stream output (one-time code) back to the caller.
 * Returns progress events via callback including code and URL.
 */
export function loginWithBrowser(
  onProgress?: (data: { code?: string; url?: string; message: string }) => void
): Promise<{ success: boolean; error?: string }> {
  const ghBin = getGhBin()
  return new Promise((resolve) => {
    const child = spawn(ghBin, [
      'auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https'
    ], {
      timeout: 180_000,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let combinedOutput = ''
    let codeFound = false

    const parseOutput = (text: string) => {
      combinedOutput += text

      // Look for device code pattern: "XXXX-XXXX"
      if (!codeFound) {
        const codeMatch = text.match(/([A-Z0-9]{4}-[A-Z0-9]{4})/)
        const urlMatch = text.match(/(https:\/\/github\.com\/login\/device)/)
        if (codeMatch) {
          codeFound = true
          onProgress?.({
            code: codeMatch[1],
            url: urlMatch ? urlMatch[1] : 'https://github.com/login/device',
            message: `Enter code: ${codeMatch[1]}`
          })
          // Auto-confirm so gh CLI proceeds to poll for the device code
          // instead of waiting for the user to press Enter in a terminal
          child.stdin?.write('\n')
        }
      }

      // Look for success messages
      if (text.includes('authentication complete') || text.includes('logged in') || text.includes('Logged in')) {
        onProgress?.({ message: 'Authentication successful!' })
      }
    }

    child.stdout?.on('data', (data: Buffer) => parseOutput(data.toString()))
    child.stderr?.on('data', (data: Buffer) => parseOutput(data.toString()))

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true })
      } else {
        resolve({ success: false, error: combinedOutput.trim() || `Process exited with code ${code}` })
      }
    })

    child.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })
  })
}

/**
 * Login with a Personal Access Token.
 */
export async function loginWithToken(token: string): Promise<{ success: boolean; error?: string }> {
  const ghBin = getGhBin()
  try {
    execSync(`"${ghBin}" auth login --with-token --hostname github.com`, {
      input: token,
      timeout: 30_000,
      encoding: 'utf8'
    })
    return { success: true }
  } catch (error: any) {
    const msg = error.stderr?.toString() || error.message || 'Token login failed'
    return { success: false, error: msg }
  }
}

/**
 * Logout from GitHub.
 */
export async function logoutGitHub(): Promise<{ success: boolean; error?: string }> {
  const ghBin = getGhBin()
  try {
    await execAsync(`"${ghBin}" auth logout --hostname github.com`, {
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024
    })
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

/**
 * Configure git to use gh as credential helper.
 */
export async function setupGitCredentialHelper(): Promise<{ success: boolean; error?: string }> {
  const ghBin = getGhBin()
  try {
    await execAsync(`"${ghBin}" auth setup-git`, {
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024
    })
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

/**
 * Set a git global config value.
 */
export async function setGitConfig(key: string, value: string): Promise<{ success: boolean; error?: string }> {
  try {
    await execGit(`config --global ${key} "${value.replace(/"/g, '\\"')}"`)
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

/**
 * Get a git global config value.
 */
export async function getGitConfig(key: string): Promise<{ success: boolean; data?: string; error?: string }> {
  try {
    const { stdout } = await execGit(`config --global --get ${key}`)
    return { success: true, data: stdout.trim() }
  } catch {
    // git config --get returns non-zero if key doesn't exist
    return { success: true, data: '' }
  }
}
