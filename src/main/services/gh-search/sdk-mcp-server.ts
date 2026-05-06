/**
 * GitHub SDK MCP Server
 *
 * Creates an in-process MCP server for GitHub CLI capabilities.
 * Wraps `gh search` and `gh view` commands to provide native GitHub
 * operations without requiring external tools or browser automation.
 *
 * Prerequisites:
 * - A GitHub Personal Access Token configured in Settings > GitHub (primary)
 * - GitHub CLI (gh) is optional — used as a faster fallback path
 *
 * Available Tools:
 * - gh_search_repos - Search GitHub repositories
 * - gh_search_issues - Search issues across repositories
 * - gh_search_prs - Search pull requests
 * - gh_search_code - Search code within repositories
 * - gh_search_commits - Search commits
 * - gh_issue_view - View issue details
 * - gh_pr_view - View pull request details
 * - gh_repo_view - View repository information
 */

import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { exec } from 'child_process';
import { promisify } from 'util';
import { proxyFetch } from '../proxy';
import { getGitHubToken } from '../config.service';
import { resolveGhBinary } from '../auth/github-auth.service';

const execAsync = promisify(exec);

const GITHUB_API_BASE = 'https://api.github.com';

class GithubApiError extends Error {
  constructor(public status: number, message: string) {
    super(`GitHub API ${status}: ${message}`);
    this.name = 'GithubApiError';
  }
}

// ============================================
// Constants
// ============================================

/** Default search limit */
const DEFAULT_LIMIT = 30;
/** Maximum search limit */
const MAX_LIMIT = 100;
/** Command timeout (ms) */
const CMD_TIMEOUT = 30_000;

// ============================================
// Helpers
// ============================================

/**
 * Build a standard text content response.
 */
function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Execute a GitHub CLI command with timeout.
 * Prefers REST API via PAT (when available) for reliability.
 * Falls back to gh CLI, then to REST API on gh CLI failure.
 */
async function execGh(
  args: string,
  timeout = CMD_TIMEOUT,
): Promise<{ stdout: string; stderr: string }> {
  // Prefer REST API directly when PAT is available (avoids gh CLI auth issues)
  const token = getGitHubToken();
  if (token) {
    try {
      return await ghApiDirect(args, token, timeout);
    } catch (apiError: any) {
      console.log(`[gh-search] REST API failed for "${args.substring(0, 80)}": ${apiError.message}`);
      // REST API failed, try gh CLI as fallback
    }
  }

  const ghBin = resolveGhBinary();
  try {
    const result = await execAsync(`"${ghBin}" ${args}`, {
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large results
    });
    return result;
  } catch (error: any) {
    // Check if gh is installed (ENOENT on Unix, code=1 + "not recognized" on Windows)
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
    // Fallback to REST API via proxyFetch
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

  // Parse command type from gh args
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

  // Proxy first (respect user config), direct fetch as fallback
  try {
    const resp = await proxyFetch(apiUrl, { headers }, timeout);
    return parseGithubResponse(resp, extractItems);
  } catch (proxyError) {
    // Proxy failed (network error / timeout) — try direct
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

async function parseGithubResponse(
  resp: Response,
  extractItems: boolean,
): Promise<{ stdout: string; stderr: string }> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    // GitHub Search returns 422 when no indexed results match the query — treat as empty
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

/**
 * Build URL params from a gh search command string.
 */
function buildSearchParams(ghArgs: string, type: string): string {
  const params = new URLSearchParams();

  // Extract quoted query
  const queryMatch = ghArgs.match(/"([^"]+)"/);
  if (queryMatch) {
    let query = queryMatch[1];
    if (type === 'pr') query += ' type:pr';
    else if (type === 'issues') query += ' type:issue';
    params.set('q', query);
  } else if (type === 'pr') {
    params.set('q', 'type:pr');
  } else if (type === 'issues') {
    params.set('q', 'type:issue');
  }

  // Extract --repo
  const repoMatch = ghArgs.match(/--repo\s+(\S+)/);
  if (repoMatch) {
    params.set('q', (params.get('q') || '') + ` repo:${repoMatch[1]}`);
  }

  // Extract --limit
  const limitMatch = ghArgs.match(/--limit\s+(\d+)/);
  if (limitMatch) {
    params.set('per_page', limitMatch[1]);
  }

  // Extract --sort
  const sortMatch = ghArgs.match(/--sort\s+(\S+)/);
  if (sortMatch) {
    params.set('sort', sortMatch[1]);
  }

  // Extract --order
  const orderMatch = ghArgs.match(/--order\s+(\S+)/);
  if (orderMatch) {
    params.set('order', orderMatch[1]);
  }

  return params.toString();
}

/**
 * Parse issue/PR view args to extract number and repo.
 */
function parseViewArgs(ghArgs: string): { number: number; repo: string | null } {
  const numMatch = ghArgs.match(/\s+(\d+)\s/);
  const repoMatch = ghArgs.match(/--repo\s+(\S+)/);
  return {
    number: numMatch ? parseInt(numMatch[1], 10) : 0,
    repo: repoMatch ? repoMatch[1] : null,
  };
}

/**
 * Parse repo view args to extract repo name.
 */
function parseRepoViewArgs(ghArgs: string): string | null {
  // Match repo name after "repo view" and before any flags
  const match = ghArgs.match(/repo view\s+(\S+?)(?:\s+--|$)/);
  return match ? match[1] : null;
}

/**
 * Extract repo qualifier from query and return clean query + repo value.
 * This allows using --repo flag instead of embedding repo: in query.
 */
function extractRepoQualifier(query: string): { cleanQuery: string; repo: string | null } {
  // Match repo:"owner/name" or repo:owner/name patterns
  const repoMatch = query.match(/repo:("([^"]+)"|([^\s]+))/i);
  if (repoMatch) {
    const repoValue = repoMatch[2] || repoMatch[3];
    const cleanQuery = query.replace(repoMatch[0], '').replace(/\s+/g, ' ').trim();
    return { cleanQuery, repo: repoValue };
  }
  return { cleanQuery: query, repo: null };
}

/**
 * Format repository search results for display.
 */
function formatRepoResults(data: any[]): string {
  if (!data || data.length === 0) {
    return 'No repositories found matching your query.';
  }

  const lines = data.map((repo, i) => {
    const parts = [
      `[${i + 1}] ${repo.fullName || repo.full_name}`,
      `    ${repo.description || 'No description'}`,
      `    ⭐ ${repo.stars || repo.stargazers_count || 0} | 🍴 ${repo.forks || repo.forks_count || 0} | ${repo.language || 'Unknown'}`,
      `    ${repo.url || repo.html_url}`,
    ];
    return parts.join('\n');
  });

  return `Found ${data.length} repositories:\n\n${lines.join('\n\n')}`;
}

/**
 * Format issue search results for display.
 */
function formatIssueResults(data: any[]): string {
  if (!data || data.length === 0) {
    return 'No issues found matching your query.';
  }

  const lines = data.map((issue, i) => {
    const labels = issue.labels?.map((l: any) => l.name || l).join(', ') || '';
    const parts = [
      `[${i + 1}] #${issue.number} ${issue.title}`,
      `    State: ${issue.state} | Author: ${issue.author?.login || issue.user?.login || 'Unknown'}`,
      labels ? `    Labels: ${labels}` : null,
      `    ${issue.url || issue.html_url}`,
    ].filter(Boolean);
    return parts.join('\n');
  });

  return `Found ${data.length} issues:\n\n${lines.join('\n\n')}`;
}

/**
 * Format PR search results for display.
 */
function formatPrResults(data: any[]): string {
  if (!data || data.length === 0) {
    return 'No pull requests found matching your query.';
  }

  const lines = data.map((pr, i) => {
    const draft = pr.isDraft || pr.draft ? ' [DRAFT]' : '';
    const merged = pr.isMerged || pr.merged ? ' [MERGED]' : '';
    const parts = [
      `[${i + 1}] #${pr.number} ${pr.title}${draft}${merged}`,
      `    State: ${pr.state} | Author: ${pr.author?.login || pr.user?.login || 'Unknown'}`,
      `    ${pr.head?.label || pr.headRefName} → ${pr.base?.label || pr.baseRefName}`,
      `    ${pr.url || pr.html_url}`,
    ];
    return parts.join('\n');
  });

  return `Found ${data.length} pull requests:\n\n${lines.join('\n\n')}`;
}

/**
 * Format code search results for display.
 */
function formatCodeResults(data: any[]): string {
  if (!data || data.length === 0) {
    return 'No code results found matching your query.';
  }

  const lines = data.map((code, i) => {
    const parts = [
      `[${i + 1}] ${code.repository?.full_name || code.repository}: ${code.path}`,
      `    ${code.url || code.html_url}`,
    ];
    if (code.snippet) {
      parts.push(`    \`\`\`\n    ${code.snippet.split('\n').join('\n    ')}\n    \`\`\``);
    }
    return parts.join('\n');
  });

  return `Found ${data.length} code results:\n\n${lines.join('\n\n')}`;
}

/**
 * Format commit search results for display.
 */
function formatCommitResults(data: any[]): string {
  if (!data || data.length === 0) {
    return 'No commits found matching your query.';
  }

  const lines = data.map((commit, i) => {
    const parts = [
      `[${i + 1}] ${commit.shortSha || commit.sha?.substring(0, 7)}`,
      `    ${commit.message?.split('\n')[0]}`,
      `    Author: ${commit.author?.login || commit.author_name || 'Unknown'}`,
      `    ${commit.url || commit.html_url}`,
    ];
    return parts.join('\n');
  });

  return `Found ${data.length} commits:\n\n${lines.join('\n\n')}`;
}

/**
 * Format single issue view for display.
 */
function formatIssueView(data: any): string {
  const labels = data.labels?.map((l: any) => l.name || l).join(', ') || '';
  const assignees = data.assignees?.map((a: any) => a.login || a).join(', ') || '';

  const lines = [
    `## Issue #${data.number}: ${data.title}`,
    '',
    `**State:** ${data.state}`,
    `**Author:** ${data.author?.login || 'Unknown'}`,
    `**Created:** ${data.createdAt || data.created_at}`,
    labels ? `**Labels:** ${labels}` : null,
    assignees ? `**Assignees:** ${assignees}` : null,
    data.milestone?.title ? `**Milestone:** ${data.milestone.title}` : null,
    '',
    `**URL:** ${data.url || data.html_url}`,
    '',
    '---',
    '',
    data.body || '*No description provided*',
  ].filter(Boolean);

  return lines.join('\n');
}

/**
 * Format single PR view for display.
 */
function formatPrView(data: any): string {
  const draft = data.isDraft || data.draft ? ' [DRAFT]' : '';
  const merged = data.merged ? ' [MERGED]' : '';
  const reviewers =
    data.reviewRequests?.nodes?.map((r: any) => r.requestedReviewer?.login || r.name).join(', ') ||
    data.reviewDecision ||
    '';

  const lines = [
    `## PR #${data.number}: ${data.title}${draft}${merged}`,
    '',
    `**State:** ${data.state}`,
    `**Author:** ${data.author?.login || 'Unknown'}`,
    `**Branch:** ${data.headRefName || data.head?.ref} → ${data.baseRefName || data.base?.ref}`,
    `**Created:** ${data.createdAt || data.created_at}`,
    reviewers ? `**Reviewers:** ${reviewers}` : null,
    data.mergeable !== undefined ? `**Mergeable:** ${data.mergeable}` : null,
    '',
    `**URL:** ${data.url || data.html_url}`,
    '',
    '---',
    '',
    data.body || '*No description provided*',
  ].filter(Boolean);

  return lines.join('\n');
}

/**
 * Format single repository view for display.
 */
function formatRepoView(data: any): string {
  const topics =
    data.repositoryTopics?.nodes?.map((t: any) => t.topic?.name || t).join(', ') ||
    data.topics?.join(', ') ||
    '';

  const lines = [
    `## ${data.nameWithOwner || data.full_name}`,
    '',
    data.description || '*No description*',
    '',
    `**Stars:** ${data.stargazerCount || data.stargazers_count || 0}`,
    `**Forks:** ${data.forkCount || data.forks_count || 0}`,
    `**Watchers:** ${data.watchers?.totalCount || data.watchers_count || 0}`,
    `**Open Issues:** ${data.issues?.totalCount || data.open_issues_count || 0}`,
    `**Language:** ${data.primaryLanguage?.name || data.language || 'Unknown'}`,
    `**License:** ${data.licenseInfo?.name || data.license?.spdx_id || 'None'}`,
    data.isPrivate !== undefined ? `**Private:** ${data.isPrivate ? 'Yes' : 'No'}` : null,
    topics ? `**Topics:** ${topics}` : null,
    '',
    `**Created:** ${data.createdAt || data.created_at}`,
    `**Last Updated:** ${data.updatedAt || data.updated_at}`,
    '',
    `**URL:** ${data.url || data.html_url}`,
    '',
    '---',
    '',
    data.readme ? `### README\n\n${data.readme}` : '*No README available*',
  ].filter(Boolean);

  return lines.join('\n');
}

// ============================================
// Tool Definitions
// ============================================

/**
 * Build all GitHub tools.
 * Exported for reuse by the MCP proxy server.
 */
export function buildAllTools() {
  // --------------------------------------------
  // gh_search_repos - Search repositories
  // --------------------------------------------
  const gh_search_repos = tool(
    'gh_search_repos',
    'Search GitHub repositories by query. Supports GitHub search syntax for filtering by stars, language, topic, etc.',
    {
      query: z
        .string()
        .describe(
          'Search query. Supports GitHub search syntax (e.g., "stars:>1000 language:typescript topic:cli")',
        ),
      limit: z
        .number()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(
          `Maximum number of results to return (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
        ),
      sort: z
        .enum(['stars', 'forks', 'help-wanted-issues', 'updated'])
        .optional()
        .describe('Sort field'),
      order: z.enum(['asc', 'desc']).optional().describe('Sort order'),
      json: z.boolean().optional().describe('Return raw JSON output instead of formatted text'),
    },
    async (args) => {
      const limit = Math.min(args.limit || DEFAULT_LIMIT, MAX_LIMIT);
      const cmdArgs = [
        'search repos',
        `"${args.query}"`,
        `--limit ${limit}`,
        '--json fullName,description,stargazersCount,forksCount,language,url,isPrivate,isFork,updatedAt',
      ];

      if (args.sort) cmdArgs.push(`--sort ${args.sort}`);
      if (args.order) cmdArgs.push(`--order ${args.order}`);

      try {
        const { stdout, stderr } = await execGh(cmdArgs.join(' '));

        if (stderr && !stdout) {
          return textResult(`Search failed: ${stderr}`, true);
        }

        const data = JSON.parse(stdout);

        if (args.json) {
          return textResult(JSON.stringify(data, null, 2));
        }

        return textResult(formatRepoResults(data));
      } catch (error: any) {
        return textResult(`Failed to search repositories: ${error.message}`, true);
      }
    },
  );

  // --------------------------------------------
  // gh_search_issues - Search issues
  // --------------------------------------------
  const gh_search_issues = tool(
    'gh_search_issues',
    'Search GitHub issues by query. Supports filtering by state, labels, author, assignee, etc.',
    {
      query: z
        .string()
        .describe(
          'Search query. Supports GitHub issue search syntax (e.g., "is:open label:bug"). Use repo:owner/repo to search in a specific repo.',
        ),
      limit: z
        .number()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`Maximum number of results to return (default: ${DEFAULT_LIMIT})`),
      sort: z
        .enum([
          'comments',
          'reactions',
          'reactions-+1',
          'reactions--1',
          'reactions-smile',
          'reactions-thinking_face',
          'reactions-heart',
          'reactions-tada',
          'interactions',
          'created',
          'updated',
        ])
        .optional()
        .describe('Sort field'),
      order: z.enum(['asc', 'desc']).optional().describe('Sort order'),
      json: z.boolean().optional().describe('Return raw JSON output'),
    },
    async (args) => {
      const limit = Math.min(args.limit || DEFAULT_LIMIT, MAX_LIMIT);

      // Extract repo qualifier and use --repo flag for proper handling
      const { cleanQuery, repo } = extractRepoQualifier(args.query);

      const cmdArgs = [
        'search issues',
        cleanQuery ? `"${cleanQuery}"` : '',
        repo ? `--repo ${repo}` : '',
        `--limit ${limit}`,
        '--json number,title,url,state,author,labels,createdAt,updatedAt,body',
      ].filter(Boolean);

      if (args.sort) cmdArgs.push(`--sort ${args.sort}`);
      if (args.order) cmdArgs.push(`--order ${args.order}`);

      try {
        const { stdout, stderr } = await execGh(cmdArgs.join(' '));

        if (stderr && !stdout) {
          return textResult(`Search failed: ${stderr}`, true);
        }

        const data = JSON.parse(stdout);

        if (args.json) {
          return textResult(JSON.stringify(data, null, 2));
        }

        return textResult(formatIssueResults(data));
      } catch (error: any) {
        return textResult(`Failed to search issues: ${error.message}`, true);
      }
    },
  );

  // --------------------------------------------
  // gh_search_prs - Search pull requests
  // --------------------------------------------
  const gh_search_prs = tool(
    'gh_search_prs',
    'Search GitHub pull requests by query. Supports filtering by state, draft, review status, etc.',
    {
      query: z
        .string()
        .describe(
          'Search query. Supports GitHub PR search syntax (e.g., "is:open draft:false"). Use repo:owner/repo to search in a specific repo.',
        ),
      limit: z
        .number()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`Maximum number of results to return (default: ${DEFAULT_LIMIT})`),
      sort: z
        .enum([
          'comments',
          'reactions',
          'reactions-+1',
          'reactions--1',
          'reactions-smile',
          'reactions-thinking_face',
          'reactions-heart',
          'reactions-tada',
          'interactions',
          'created',
          'updated',
        ])
        .optional()
        .describe('Sort field'),
      order: z.enum(['asc', 'desc']).optional().describe('Sort order'),
      json: z.boolean().optional().describe('Return raw JSON output'),
    },
    async (args) => {
      const limit = Math.min(args.limit || DEFAULT_LIMIT, MAX_LIMIT);

      // Extract repo qualifier and use --repo flag for proper handling
      const { cleanQuery, repo } = extractRepoQualifier(args.query);

      const cmdArgs = [
        'search prs',
        cleanQuery ? `"${cleanQuery}"` : '',
        repo ? `--repo ${repo}` : '',
        `--limit ${limit}`,
        '--json number,title,url,state,author,isDraft,headRefName,baseRefName,createdAt,updatedAt,body',
      ].filter(Boolean);

      if (args.sort) cmdArgs.push(`--sort ${args.sort}`);
      if (args.order) cmdArgs.push(`--order ${args.order}`);

      try {
        const { stdout, stderr } = await execGh(cmdArgs.join(' '));

        if (stderr && !stdout) {
          return textResult(`Search failed: ${stderr}`, true);
        }

        const data = JSON.parse(stdout);

        if (args.json) {
          return textResult(JSON.stringify(data, null, 2));
        }

        return textResult(formatPrResults(data));
      } catch (error: any) {
        return textResult(`Failed to search pull requests: ${error.message}`, true);
      }
    },
  );

  // --------------------------------------------
  // gh_search_code - Search code
  // --------------------------------------------
  const gh_search_code = tool(
    'gh_search_code',
    'Search code within GitHub repositories. Supports language and path filters.',
    {
      query: z
        .string()
        .describe(
          'Search query. Supports GitHub code search syntax (e.g., "function language:typescript"). Use repo:owner/repo to search in a specific repo.',
        ),
      limit: z
        .number()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`Maximum number of results to return (default: ${DEFAULT_LIMIT})`),
      json: z.boolean().optional().describe('Return raw JSON output'),
    },
    async (args) => {
      const limit = Math.min(args.limit || DEFAULT_LIMIT, MAX_LIMIT);

      // Extract repo qualifier and use --repo flag for proper handling
      const { cleanQuery, repo } = extractRepoQualifier(args.query);

      const cmdArgs = [
        'search code',
        cleanQuery ? `"${cleanQuery}"` : '',
        repo ? `--repo ${repo}` : '',
        `--limit ${limit}`,
        '--json repository,path,url',
      ].filter(Boolean);

      try {
        const { stdout, stderr } = await execGh(cmdArgs.join(' '));

        if (stderr && !stdout) {
          return textResult(`Search failed: ${stderr}`, true);
        }

        const data = JSON.parse(stdout);

        if (args.json) {
          return textResult(JSON.stringify(data, null, 2));
        }

        return textResult(formatCodeResults(data));
      } catch (error: any) {
        return textResult(`Failed to search code: ${error.message}`, true);
      }
    },
  );

  // --------------------------------------------
  // gh_search_commits - Search commits
  // --------------------------------------------
  const gh_search_commits = tool(
    'gh_search_commits',
    'Search GitHub commits by query. Supports filtering by author, date, etc. Note: only searches the default branch of repositories.',
    {
      query: z
        .string()
        .optional()
        .describe(
          'Search query. Supports GitHub commit search syntax (e.g., "author:octocat committer-date:>2024-01-01"). Use repo:owner/repo to search in a specific repo. Optional - you can omit if using qualifiers only.',
        ),
      sort: z.enum(['author-date', 'committer-date']).optional().describe('Sort field'),
      order: z.enum(['asc', 'desc']).optional().describe('Sort order'),
      limit: z
        .number()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`Maximum number of results to return (default: ${DEFAULT_LIMIT})`),
      json: z.boolean().optional().describe('Return raw JSON output'),
    },
    async (args) => {
      const limit = Math.min(args.limit || DEFAULT_LIMIT, MAX_LIMIT);

      // Extract repo qualifier and use --repo flag for proper handling
      const queryStr = args.query || '';
      const { cleanQuery, repo } = extractRepoQualifier(queryStr);

      const cmdArgs = [
        'search commits',
        cleanQuery ? `"${cleanQuery}"` : '',
        repo ? `--repo ${repo}` : '',
        `--limit ${limit}`,
        '--json sha,commit,author,url',
      ].filter(Boolean);

      if (args.sort) cmdArgs.push(`--sort ${args.sort}`);
      if (args.order) cmdArgs.push(`--order ${args.order}`);

      try {
        const { stdout, stderr } = await execGh(cmdArgs.join(' '));

        if (stderr && !stdout) {
          return textResult(`Search failed: ${stderr}`, true);
        }

        const data = JSON.parse(stdout);

        if (args.json) {
          return textResult(JSON.stringify(data, null, 2));
        }

        return textResult(formatCommitResults(data));
      } catch (error: any) {
        return textResult(`Failed to search commits: ${error.message}`, true);
      }
    },
  );

  // ============================================
  // View Tools (3 tools)
  // ============================================

  // --------------------------------------------
  // gh_issue_view - View issue details
  // --------------------------------------------
  const gh_issue_view = tool(
    'gh_issue_view',
    'View detailed information about a GitHub issue including title, body, labels, assignees, and comments.',
    {
      number: z.number().describe('Issue number'),
      repo: z
        .string()
        .optional()
        .describe(
          'Repository in format owner/repo (e.g., "facebook/react"). Uses current repo if not specified.',
        ),
      comments: z.boolean().optional().describe('Include issue comments'),
      json: z.boolean().optional().describe('Return raw JSON output'),
    },
    async (args) => {
      const repoArg = args.repo ? `--repo ${args.repo}` : '';
      const cmdArgs = [
        'issue view',
        args.number,
        repoArg,
        '--json number,title,url,state,author,labels,createdAt,updatedAt,body,assignees,milestone',
      ].filter(Boolean);

      try {
        const { stdout, stderr } = await execGh(cmdArgs.join(' '));

        if (stderr && !stdout) {
          return textResult(`Failed to view issue: ${stderr}`, true);
        }

        const data = JSON.parse(stdout);

        if (args.json) {
          return textResult(JSON.stringify(data, null, 2));
        }

        let result = formatIssueView(data);

        // Fetch comments if requested
        if (args.comments && data.number) {
          try {
            const commentsCmd = ['issue view', args.number, repoArg, '--comments'].filter(Boolean);
            const { stdout: commentsOut } = await execGh(commentsCmd.join(' '));
            if (commentsOut) {
              result += `\n\n---\n\n### Comments\n\n${commentsOut}`;
            }
          } catch {
            // Comments may not exist, that's okay
          }
        }

        return textResult(result);
      } catch (error: any) {
        return textResult(
          error instanceof GithubApiError && error.status === 404
            ? `Issue #${args.number} not found in ${args.repo || 'current repo'}. It may not exist or the number might be a PR — use gh_pr_view instead.`
            : `Failed to view issue: ${error.message}`,
          true,
        );
      }
    },
  );

  // --------------------------------------------
  // gh_pr_view - View PR details
  // --------------------------------------------
  const gh_pr_view = tool(
    'gh_pr_view',
    'View detailed information about a GitHub pull request including title, body, branch info, review status, and mergeability.',
    {
      number: z.number().describe('Pull request number'),
      repo: z
        .string()
        .optional()
        .describe(
          'Repository in format owner/repo (e.g., "facebook/react"). Uses current repo if not specified.',
        ),
      json: z.boolean().optional().describe('Return raw JSON output'),
    },
    async (args) => {
      const repoArg = args.repo ? `--repo ${args.repo}` : '';
      const cmdArgs = [
        'pr view',
        args.number,
        repoArg,
        '--json number,title,url,state,author,isDraft,merged,headRefName,baseRefName,createdAt,updatedAt,body,reviewDecision,mergeable,reviewRequests',
      ].filter(Boolean);

      try {
        const { stdout, stderr } = await execGh(cmdArgs.join(' '));

        if (stderr && !stdout) {
          return textResult(`Failed to view PR: ${stderr}`, true);
        }

        const data = JSON.parse(stdout);

        if (args.json) {
          return textResult(JSON.stringify(data, null, 2));
        }

        return textResult(formatPrView(data));
      } catch (error: any) {
        return textResult(
          error instanceof GithubApiError && error.status === 404
            ? `PR #${args.number} not found in ${args.repo || 'current repo'}. It may not exist or the number might be an issue — use gh_issue_view instead.`
            : `Failed to view PR: ${error.message}`,
          true,
        );
      }
    },
  );

  // --------------------------------------------
  // gh_repo_view - View repository info
  // --------------------------------------------
  const gh_repo_view = tool(
    'gh_repo_view',
    'View detailed information about a GitHub repository including description, stats, topics, and README.',
    {
      repo: z
        .string()
        .optional()
        .describe(
          'Repository in format owner/repo (e.g., "facebook/react"). Uses current repo if not specified.',
        ),
      json: z.boolean().optional().describe('Return raw JSON output'),
    },
    async (args) => {
      const repoArg = args.repo || '';
      const cmdArgs = [
        'repo view',
        repoArg,
        '--json name,nameWithOwner,description,url,stargazerCount,forkCount,createdAt,updatedAt,primaryLanguage,licenseInfo,isPrivate,repositoryTopics,issues,watchers',
      ].filter(Boolean);

      try {
        const { stdout, stderr } = await execGh(cmdArgs.join(' '));

        if (stderr && !stdout) {
          return textResult(`Failed to view repository: ${stderr}`, true);
        }

        const data = JSON.parse(stdout);

        // Try to fetch README
        try {
          const readmeCmd = ['repo view', repoArg, '--readme'].filter(Boolean).join(' ');
          const { stdout: readmeOut } = await execGh(readmeCmd);
          data.readme = readmeOut;
        } catch {
          // README may not exist
        }

        if (args.json) {
          return textResult(JSON.stringify(data, null, 2));
        }

        return textResult(formatRepoView(data));
      } catch (error: any) {
        return textResult(`Failed to view repository: ${error.message}`, true);
      }
    },
  );

  // Return all tools
  return [
    // Search tools (5)
    gh_search_repos,
    gh_search_issues,
    gh_search_prs,
    gh_search_code,
    gh_search_commits,
    // View tools (3)
    gh_issue_view,
    gh_pr_view,
    gh_repo_view,
  ];
} // end buildAllTools

// ============================================
// Export SDK MCP Server
// ============================================

/**
 * All GitHub tools
 */
const allSdkTools = buildAllTools();

/**
 * Create GitHub Search SDK MCP Server.
 * This is a built-in MCP server that provides GitHub search capabilities.
 */
export function createGhSearchMcpServer() {
  return createSdkMcpServer({
    name: 'gh-search',
    version: '1.0.0',
    tools: allSdkTools,
  });
}

/**
 * Get all GitHub Search tool names
 */
export function getGhSearchSdkToolNames(): string[] {
  return allSdkTools.map((t) => t.name);
}

/**
 * Get the resolved gh binary path (for external use)
 */
export { resolveGhBinary as getGhBinaryPath };
