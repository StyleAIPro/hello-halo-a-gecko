/**
 * GitHub Search - API Infrastructure
 *
 * Provides GitHub API access via PAT (primary) with gh CLI fallback.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { proxyFetch } from '../proxy';
import { getGitHubToken } from '../config.service';
import { resolveGhBinary } from '../auth/github-auth.service';
import { buildSearchParams, parseViewArgs, parseRepoViewArgs } from './gh-helpers';

const execAsync = promisify(exec);

export const GITHUB_API_BASE = 'https://api.github.com';
export const CMD_TIMEOUT = 30_000;

export class GithubApiError extends Error {
  constructor(public status: number, message: string) {
    super(`GitHub API ${status}: ${message}`);
    this.name = 'GithubApiError';
  }
}

/**
 * Execute a GitHub CLI command with timeout.
 * Prefers REST API via PAT (when available) for reliability.
 * Falls back to gh CLI, then to REST API on gh CLI failure.
 */
export async function execGh(
  args: string,
  timeout = CMD_TIMEOUT,
): Promise<{ stdout: string; stderr: string }> {
  const token = getGitHubToken();
  if (token) {
    try {
      return await ghApiDirect(args, token, timeout);
    } catch (apiError: any) {
      console.log(`[gh-search] REST API failed for "${args.substring(0, 80)}": ${apiError.message}`);
    }
  }

  const ghBin = resolveGhBinary();
  try {
    const result = await execAsync(`"${ghBin}" ${args}`, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result;
  } catch (error: any) {
    const isNotFound =
      error.code === 'ENOENT' ||
      (error.code === 1 &&
        (error.message?.includes('not recognized') ||
          error.stderr?.includes('not recognized') ||
          error.stderr?.includes('not found') ||
          error.stderr?.includes('ENOENT')));

    if (isNotFound) {
      throw new Error(
        'GitHub CLI (gh) is not installed. Please install it from https://cli.github.com/',
        { cause: error },
      );
    }
    return ghApiFallback(args, error);
  }
}

/**
 * Call GitHub REST API directly with PAT.
 * Respects user proxy config (proxyFetch first). If proxy fails or returns
 * a server error, falls back to direct native fetch.
 */
async function ghApiDirect(
  ghArgs: string,
  token: string,
  timeout = 60_000,
): Promise<{ stdout: string; stderr: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let apiUrl = '';
  let extractItems = false;

  if (ghArgs.startsWith('search repos')) {
    const params = buildSearchParams(ghArgs, 'repositories');
    apiUrl = `${GITHUB_API_BASE}/search/repositories?${params}`;
    extractItems = true;
  } else if (ghArgs.startsWith('search issues')) {
    const params = buildSearchParams(ghArgs, 'issues');
    apiUrl = `${GITHUB_API_BASE}/search/issues?${params}`;
    extractItems = true;
  } else if (ghArgs.startsWith('search prs')) {
    const params = buildSearchParams(ghArgs, 'pr');
    apiUrl = `${GITHUB_API_BASE}/search/issues?${params}`;
    extractItems = true;
  } else if (ghArgs.startsWith('search code')) {
    const params = buildSearchParams(ghArgs, 'code');
    apiUrl = `${GITHUB_API_BASE}/search/code?${params}`;
    extractItems = true;
  } else if (ghArgs.startsWith('search commits')) {
    const params = buildSearchParams(ghArgs, 'commits');
    apiUrl = `${GITHUB_API_BASE}/search/commits?${params}`;
    extractItems = true;
  } else if (ghArgs.startsWith('issue view')) {
    const { number, repo } = parseViewArgs(ghArgs);
    if (number && repo) {
      apiUrl = ghArgs.includes('--comments')
        ? `${GITHUB_API_BASE}/repos/${repo}/issues/${number}/comments`
        : `${GITHUB_API_BASE}/repos/${repo}/issues/${number}`;
    }
  } else if (ghArgs.startsWith('pr view')) {
    const { number, repo } = parseViewArgs(ghArgs);
    if (number && repo) {
      apiUrl = `${GITHUB_API_BASE}/repos/${repo}/pulls/${number}`;
    }
  } else if (ghArgs.startsWith('repo view')) {
    const repo = parseRepoViewArgs(ghArgs);
    if (repo) {
      if (ghArgs.includes('--readme')) {
        apiUrl = `${GITHUB_API_BASE}/repos/${repo}/readme`;
        headers['Accept'] = 'application/vnd.github.html';
      } else {
        apiUrl = `${GITHUB_API_BASE}/repos/${repo}`;
      }
    }
  }

  if (!apiUrl) {
    throw new Error(`Unsupported gh command: ${ghArgs.split(' ')[0]} ${ghArgs.split(' ')[1]}`);
  }

  try {
    const resp = await proxyFetch(apiUrl, { headers }, timeout);
    return parseGithubResponse(resp, extractItems);
  } catch (proxyError) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch(apiUrl, { headers, signal: controller.signal });
      return parseGithubResponse(resp, extractItems);
    } catch (directError) {
      throw new Error(`${proxyError instanceof Error ? proxyError.message : proxyError} (direct also failed: ${directError instanceof Error ? directError.message : directError})`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function parseGithubResponse(
  resp: Response,
  extractItems: boolean,
): Promise<{ stdout: string; stderr: string }> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (resp.status === 422) {
      try {
        const body = JSON.parse(text);
        if (body.errors?.some((e: any) => e.message?.includes('could not find any results'))) {
          return { stdout: JSON.stringify(extractItems ? [] : body), stderr: '' };
        }
      } catch {}
    }
    throw new GithubApiError(resp.status, text || resp.statusText);
  }
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('text/') || contentType.includes('html')) {
    return { stdout: await resp.text().catch(() => ''), stderr: '' };
  }
  const data = await resp.json();
  const output = extractItems && data.items ? data.items : data;
  return { stdout: JSON.stringify(output), stderr: '' };
}

/**
 * Fallback: call GitHub REST API via proxyFetch when gh CLI fails.
 */
async function ghApiFallback(
  ghArgs: string,
  originalError: unknown,
): Promise<{ stdout: string; stderr: string }> {
  const token = getGitHubToken();
  if (!token) {
    throw originalError;
  }
  try {
    return await ghApiDirect(ghArgs, token);
  } catch (apiError) {
    const err = new Error(`Both gh CLI and REST API failed for: ${ghArgs} (CLI: ${originalError instanceof Error ? originalError.message : originalError}, API: ${apiError instanceof Error ? apiError.message : apiError})`);
    (err as any).cause = originalError;
    throw err;
  }
}
