/**
 * Git Bash Service - Detection, installation, and path management for Windows
 *
 * Claude Code CLI on Windows requires Git Bash as the shell execution environment.
 * This service detects existing Git Bash installations and manages paths.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { createMockBash, cleanupMockBash } from './mock-bash.service';
import { getConfig, saveConfig } from './config.service';

export interface GitBashDetectionResult {
  found: boolean;
  path: string | null;
  source: 'system' | 'app-local' | 'env-var' | null;
}

/**
 * Detect Git Bash installation on the system
 *
 * Detection order:
 * 1. Environment variable (CLAUDE_CODE_GIT_BASH_PATH)
 * 2. App-local installation (userData/git-bash)
 * 3. System installation (Program Files)
 * 4. PATH-based discovery
 */
export function detectGitBash(): GitBashDetectionResult {
  // Non-Windows platforms use system bash
  if (process.platform !== 'win32') {
    return { found: true, path: '/bin/bash', source: 'system' };
  }

  // 1. Check environment variable
  const envPath = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (envPath && existsSync(envPath)) {
    console.log('[GitBash] Found via environment variable:', envPath);
    return { found: true, path: envPath, source: 'env-var' };
  }

  // 2. Check app-local installation (managed by AICO-Bot)
  const localGitBash = join(app.getPath('userData'), 'git-bash', 'bin', 'bash.exe');
  if (existsSync(localGitBash)) {
    console.log('[GitBash] Found app-local installation:', localGitBash);
    return { found: true, path: localGitBash, source: 'app-local' };
  }

  // 3. Check system installation paths
  const systemPaths = [
    join(process.env.PROGRAMFILES || '', 'Git', 'bin', 'bash.exe'),
    join(process.env['PROGRAMFILES(X86)'] || '', 'Git', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];

  for (const p of systemPaths) {
    if (p && existsSync(p)) {
      console.log('[GitBash] Found system installation:', p);
      return { found: true, path: p, source: 'system' };
    }
  }

  // 4. Try to find git in PATH and derive bash path
  const gitFromPath = findGitInPath();
  if (gitFromPath) {
    // Git is typically at: C:\Program Files\Git\cmd\git.exe
    // Bash is at: C:\Program Files\Git\bin\bash.exe
    const bashPath = join(gitFromPath, '..', '..', 'bin', 'bash.exe');
    if (existsSync(bashPath)) {
      console.log('[GitBash] Found via PATH:', bashPath);
      return { found: true, path: bashPath, source: 'system' };
    }
  }

  console.log('[GitBash] Not found');
  return { found: false, path: null, source: null };
}

/**
 * Find git.exe in PATH environment variable
 */
function findGitInPath(): string | null {
  const pathEnv = process.env.PATH || '';
  const paths = pathEnv.split(';');

  for (const p of paths) {
    const gitExe = join(p, 'git.exe');
    if (existsSync(gitExe)) {
      return gitExe;
    }
  }
  return null;
}

/**
 * Get the path to the app-local Git Bash installation directory
 */
export function getAppLocalGitBashDir(): string {
  return join(app.getPath('userData'), 'git-bash');
}

/**
 * Check if Git Bash is installed by AICO-Bot (app-local)
 */
export function isAppLocalInstallation(): boolean {
  const result = detectGitBash();
  return result.found && result.source === 'app-local';
}

/**
 * Set the Git Bash path environment variable for Claude Code SDK
 */
export function setGitBashPathEnv(path: string): void {
  process.env.CLAUDE_CODE_GIT_BASH_PATH = path;
  console.log('[GitBash] Environment variable set:', path);
}

// ──────────────────────────────────────────────
// Status & lifecycle
// ──────────────────────────────────────────────

export interface GitBashStatus {
  found: boolean;
  path: string | null;
  source: string | null;
  mockMode: boolean;
}

/**
 * Get Git Bash status — used by IPC handler
 *
 * Checks config (skipped/installed) first, then falls back to fresh detection.
 */
export function getGitBashStatus(): GitBashStatus {
  if (process.platform !== 'win32') {
    return { found: true, path: '/bin/bash', source: 'system', mockMode: false };
  }

  const config = getConfig() as any;
  if (config.gitBash?.skipped) {
    return { found: true, path: null, source: 'mock', mockMode: true };
  }
  if (config.gitBash?.installed && config.gitBash?.path) {
    return { found: true, path: config.gitBash.path, source: 'app-local', mockMode: false };
  }

  const result = detectGitBash();
  return { ...result, mockMode: false };
}

/**
 * Initialize Git Bash on app startup (Windows only)
 *
 * Validates saved config paths and handles edge cases like Git Bash being deleted.
 */
export async function initializeGitBashOnStartup(): Promise<{
  available: boolean;
  needsSetup: boolean;
  mockMode: boolean;
  path: string | null;
  configCleared?: boolean;
}> {
  if (process.platform !== 'win32') {
    return { available: true, needsSetup: false, mockMode: false, path: '/bin/bash' };
  }

  const config = getConfig() as any;

  // Case 1: Config says installed with a specific path — VALIDATE it still exists
  if (config.gitBash?.installed && config.gitBash?.path) {
    const savedPath = config.gitBash.path;

    if (existsSync(savedPath)) {
      setGitBashPathEnv(savedPath);
      console.log('[GitBash] Using saved path:', savedPath);
      return { available: true, needsSetup: false, mockMode: false, path: savedPath };
    } else {
      console.log('[GitBash] Saved path no longer exists:', savedPath);
      saveConfig({ gitBash: { installed: false, path: null, skipped: false } } as any);
      console.log('[GitBash] Cleared stale config, will re-detect');
      // Fall through to fresh detection below
    }
  }

  // Case 2: User previously skipped — use mock mode
  if (config.gitBash?.skipped) {
    const mockPath = createMockBash();
    setGitBashPathEnv(mockPath);
    console.log('[GitBash] Mock mode active (user skipped)');
    return { available: true, needsSetup: false, mockMode: true, path: mockPath };
  }

  // Case 3: Fresh detection
  const detection = detectGitBash();

  if (detection.found && detection.path) {
    setGitBashPathEnv(detection.path);
    saveConfig({ gitBash: { installed: true, path: detection.path, skipped: false } } as any);
    console.log('[GitBash] Detected system Git Bash:', detection.path);
    return { available: true, needsSetup: false, mockMode: false, path: detection.path };
  }

  // Case 4: Git Bash not found anywhere
  console.log('[GitBash] Not found, setup required');
  return { available: false, needsSetup: true, mockMode: false, path: null, configCleared: true };
}

/**
 * Set Git Bash as skipped (user chose to skip installation)
 */
export function setGitBashSkipped(): void {
  const mockPath = createMockBash();
  setGitBashPathEnv(mockPath);
  saveConfig({ gitBash: { installed: false, path: null, skipped: true } } as any);
  console.log('[GitBash] User skipped installation, using mock mode');
}

/**
 * Complete Git Bash installation — set env, save config, cleanup mock
 */
export function completeGitBashInstallation(path: string): void {
  setGitBashPathEnv(path);
  saveConfig({ gitBash: { installed: true, path, skipped: false } } as any);
  cleanupMockBash();
  console.log('[GitBash] Installation completed, path saved to config');
}
