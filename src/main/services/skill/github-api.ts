/**
 * GitHub Skill Source - API Infrastructure
 *
 * GitHub REST API fetch with proxy support and rate limit handling.
 */

import { proxyFetch } from '../proxy';

export { getGitHubToken } from '../config.service';

export const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Fetch a GitHub API URL with automatic direct fallback.
 */
export async function githubFetch(url: string, init?: RequestInit, timeoutMs?: number): Promise<Response> {
  try {
    return await proxyFetch(url, init, timeoutMs);
  } catch {
    return fetch(url, init);
  }
}

interface GitHubApiOptions {
  token?: string;
}

/**
 * Main GitHub API fetch with rate limit handling.
 */
export async function githubApiFetch(path: string, options?: GitHubApiOptions): Promise<any> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'AICO-Bot',
  };
  if (options?.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  const response = await githubFetch(`https://api.github.com${path}`, { headers });

  if (response.status === 403) {
    const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');
    const rateLimitReset = response.headers.get('X-RateLimit-Reset');
    if (rateLimitRemaining === '0') {
      const resetDate = rateLimitReset
        ? new Date(parseInt(rateLimitReset) * 1000).toLocaleString()
        : 'unknown';
      throw new Error(
        `GitHub API rate limit exceeded. Resets at ${resetDate}. Authenticate with gh CLI to increase limits.`,
      );
    }
    throw new Error(`GitHub API forbidden: ${await response.text()}`);
  }

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`GitHub API error ${response.status}: ${await response.text()}`);
  }

  return response.json();
}
