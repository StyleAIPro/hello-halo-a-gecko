/**
 * GitHub Auth Service
 *
 * Wraps gh CLI and git config commands for the GitHub settings UI.
 * Uses the bundled gh binary from resources/gh/{platform}/.
 */

import { exec, execSync, spawn } from 'child_process';
import os from 'os';
import { app } from 'electron';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { promisify } from 'util';
import { getGitHubToken, setGitHubToken } from './config.service';
import { proxyFetch } from './proxy';

const execAsync = promisify(exec);

const GITHUB_API_BASE = 'https://api.github.com';

export interface GitHubAuthStatus {
  authenticated: boolean;
  user: string | null;
  hostname: string | null;
  protocol: string | null;
  error?: string;
}

/**
 * Resolve the bundled gh CLI binary path.
 * Checks resources/gh/{platform}/ first, then falls back to system PATH.
 */
export function resolveGhBinary(): string {
  try {
    const platform = os.platform();
    const arch = os.arch();

    let platformDir: string;
    if (platform === 'darwin') {
      platformDir = arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
    } else if (platform === 'win32') {
      platformDir = 'win-x64';
    } else if (platform === 'linux') {
      platformDir = 'linux-x64';
    } else {
      return 'gh';
    }

    const binaryName = platform === 'win32' ? 'gh.exe' : 'gh';
    let binPath = join(app.getAppPath(), 'resources', 'gh', platformDir, binaryName);

    // Fix path for packaged Electron app (asar -> asar.unpacked)
    if (binPath.includes('app.asar')) {
      binPath = binPath.replace('app.asar', 'app.asar.unpacked');
    }

    if (existsSync(binPath)) {
      return binPath;
    }
  } catch {
    // Electron not available or path resolution failed
  }

  return 'gh';
}

/**
 * Run a git command.
 */
async function execGit(args: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(`git ${args}`, { timeout: 10_000 });
}

/**
 * Check if gh binary is available (bundled or system).
 */
export function isGhAvailable(): boolean {
  const ghBin = resolveGhBinary();
  try {
    execSync(`"${ghBin}" --version`, { timeout: 5_000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get current GitHub CLI authentication status.
 */
export async function getGitHubAuthStatus(): Promise<GitHubAuthStatus> {
  const ghBin = resolveGhBinary();

  // gh auth status may exit with non-zero even when authenticated
  const combinedOutput = await execAsync(`"${ghBin}" auth status`, {
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  })
    .then(({ stdout, stderr }) => `${stdout}\n${stderr}`)
    .catch((error: unknown) => {
      const execError = error as {
        code?: string;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      if (execError.code === 'ENOENT') {
        return '';
      }
      return `${execError.stdout || ''}\n${execError.stderr || ''}`;
    });

  if (!combinedOutput) {
    return {
      authenticated: false,
      user: null,
      hostname: null,
      protocol: null,
      error: 'GitHub CLI (gh) is not available. Please run "npm run prepare" to download it.',
    };
  }

  if (!combinedOutput.trim()) {
    return { authenticated: false, user: null, hostname: null, protocol: null };
  }

  // Parse output from various gh CLI versions:
  //   ✓ Logged in to github.com as octocat (oauth_token)
  //   ✓ Logged in to github.com account StyleAIPro (keyring)
  //   ✓ Logged in to github.com as octocat [oauth_token]  (some builds)
  const userMatch = combinedOutput.match(/Logged in to github\.com (?:as|account) (\w[\w-]*)/);
  const protocolMatch =
    combinedOutput.match(/Git operations protocol: (https|ssh)/) ||
    combinedOutput.match(/\((\w+)_token\)/);

  if (userMatch) {
    return {
      authenticated: true,
      user: userMatch[1],
      hostname: 'github.com',
      protocol: protocolMatch ? protocolMatch[1] : null,
    };
  }

  return { authenticated: false, user: null, hostname: null, protocol: null };
}

/**
 * Login via browser OAuth flow.
 * Uses spawn to stream output (one-time code) back to the caller.
 * Returns progress events via callback including code and URL.
 */
export function loginWithBrowser(
  onProgress?: (data: { code?: string; url?: string; message: string }) => void,
): Promise<{ success: boolean; error?: string }> {
  const ghBin = resolveGhBinary();
  return new Promise((resolve) => {
    const child = spawn(
      ghBin,
      ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https'],
      {
        timeout: 180_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let combinedOutput = '';
    let codeFound = false;

    const parseOutput = (text: string) => {
      combinedOutput += text;

      // Look for device code pattern: "XXXX-XXXX"
      if (!codeFound) {
        const codeMatch = text.match(/([A-Z0-9]{4}-[A-Z0-9]{4})/);
        const urlMatch = text.match(/(https:\/\/github\.com\/login\/device)/);
        if (codeMatch) {
          codeFound = true;
          onProgress?.({
            code: codeMatch[1],
            url: urlMatch ? urlMatch[1] : 'https://github.com/login/device',
            message: `Enter code: ${codeMatch[1]}`,
          });
          // Auto-confirm so gh CLI proceeds to poll for the device code
          // instead of waiting for the user to press Enter in a terminal
          child.stdin?.write('\n');
        }
      }

      // Look for success messages
      if (
        text.includes('authentication complete') ||
        text.includes('logged in') ||
        text.includes('Logged in')
      ) {
        onProgress?.({ message: 'Authentication successful!' });
      }
    };

    child.stdout?.on('data', (data: Buffer) => parseOutput(data.toString()));
    child.stderr?.on('data', (data: Buffer) => parseOutput(data.toString()));

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({
          success: false,
          error: combinedOutput.trim() || `Process exited with code ${code}`,
        });
      }
    });

    child.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Login with a Personal Access Token.
 */
export async function loginWithToken(token: string): Promise<{ success: boolean; error?: string }> {
  const ghBin = resolveGhBinary();
  try {
    execSync(`"${ghBin}" auth login --with-token --hostname github.com`, {
      input: token,
      timeout: 30_000,
      encoding: 'utf8',
    });
    return { success: true };
  } catch (error: unknown) {
    const execError = error as { stderr?: { toString(): string }; message?: string };
    const msg = execError.stderr?.toString() || execError.message || 'Token login failed';
    return { success: false, error: msg };
  }
}

/**
 * Logout from GitHub.
 */
export async function logoutGitHub(): Promise<{ success: boolean; error?: string }> {
  const ghBin = resolveGhBinary();
  try {
    await execAsync(`"${ghBin}" auth logout --hostname github.com`, {
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { success: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: msg };
  }
}

/**
 * Configure git to use gh as credential helper.
 */
export async function setupGitCredentialHelper(): Promise<{ success: boolean; error?: string }> {
  const ghBin = resolveGhBinary();
  try {
    await execAsync(`"${ghBin}" auth setup-git`, {
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { success: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: msg };
  }
}

/**
 * Set a git global config value.
 */
export async function setGitConfig(
  key: string,
  value: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await execGit(`config --global ${key} "${value.replace(/"/g, '\\"')}"`);
    return { success: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: msg };
  }
}

/**
 * Get a git global config value.
 */
export async function getGitConfig(
  key: string,
): Promise<{ success: boolean; data?: string; error?: string }> {
  try {
    const { stdout } = await execGit(`config --global --get ${key}`);
    return { success: true, data: stdout.trim() };
  } catch {
    // git config --get returns non-zero if key doesn't exist
    return { success: true, data: '' };
  }
}

// ── Direct PAT authentication (no gh CLI required) ──────────────────

export interface DirectGitHubAuthStatus {
  authenticated: boolean;
  user: string | null;
  avatarUrl: string | null;
  error?: string;
}

/**
 * Validate a GitHub PAT by calling the GitHub REST API.
 */
async function validateGitHubToken(
  token: string,
): Promise<{ login: string; avatar_url: string } | null> {
  try {
    const resp = await proxyFetch(`${GITHUB_API_BASE}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'AICO-Bot',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return { login: data.login, avatar_url: data.avatar_url };
  } catch {
    return null;
  }
}

/**
 * Get auth status from directly stored PAT (no gh CLI).
 */
export async function getDirectGitHubAuthStatus(): Promise<DirectGitHubAuthStatus> {
  const token = getGitHubToken();
  if (!token) {
    return { authenticated: false, user: null, avatarUrl: null };
  }
  const user = await validateGitHubToken(token);
  if (!user) {
    // Token is invalid, clear it
    setGitHubToken(undefined);
    return {
      authenticated: false,
      user: null,
      avatarUrl: null,
      error: 'Token is invalid or expired',
    };
  }
  return { authenticated: true, user: user.login, avatarUrl: user.avatar_url };
}

/**
 * Combined auth status: PAT (primary) + gh CLI (optional).
 */
export interface CombinedGitHubAuthStatus {
  pat: DirectGitHubAuthStatus;
  ghCli: {
    available: boolean;
  } & GitHubAuthStatus;
}

export async function getCombinedGitHubAuthStatus(): Promise<CombinedGitHubAuthStatus> {
  const [pat, ghCliStatus] = await Promise.all([
    getDirectGitHubAuthStatus(),
    getGitHubAuthStatus(),
  ]);
  return {
    pat,
    ghCli: { available: isGhAvailable(), ...ghCliStatus },
  };
}

/**
 * Login with a GitHub PAT directly (stores in config.json, no gh CLI).
 */
export async function loginWithDirectToken(
  token: string,
): Promise<{ success: boolean; error?: string; user?: string }> {
  const user = await validateGitHubToken(token);
  if (!user) {
    return { success: false, error: 'Invalid token. Please check your Personal Access Token.' };
  }
  setGitHubToken(token);
  // Auto-configure git credentials in background (fire-and-forget)
  setupGitCredentialsWithToken().catch(() => {});
  return { success: true, user: user.login };
}

/**
 * Logout from direct GitHub PAT mode.
 */
export async function logoutDirectGitHub(): Promise<void> {
  setGitHubToken(undefined);
}

/**
 * Configure git to use the stored GitHub PAT for HTTPS operations.
 * Writes the token to ~/.git-credentials and enables credential.helper store.
 */
export async function setupGitCredentialsWithToken(): Promise<{
  success: boolean;
  error?: string;
}> {
  const token = getGitHubToken();
  if (!token) {
    return { success: false, error: 'No GitHub token configured. Please login first.' };
  }

  try {
    // Ensure credential.helper is set to store
    await execAsync('git config --global credential.helper store');

    // Write token to ~/.git-credentials
    const credFile = join(homedir(), '.git-credentials');
    let content = '';
    try {
      content = await readFile(credFile, 'utf8');
    } catch {
      // File doesn't exist yet
    }

    // Remove any existing github.com line, then append the new one
    const lines = content.split('\n').filter((line: string) => !line.includes('github.com'));
    lines.push(`https://${token}@github.com`);
    await writeFile(credFile, lines.join('\n') + '\n');

    return { success: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to configure git credentials';
    return { success: false, error: msg };
  }
}
