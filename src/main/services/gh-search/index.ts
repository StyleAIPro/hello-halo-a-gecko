/**
 * GitHub Search Module - Main Entry Point
 *
 * This module provides GitHub search capabilities for the AI agent.
 * Uses GitHub REST API (PAT) as primary auth, with gh CLI as optional fallback.
 *
 * Key Features:
 * - 5 GitHub search tools (repos, issues, PRs, code, commits)
 * - 3 GitHub view tools (issues, PRs, repos)
 * - Full GitHub search syntax support
 * - JSON and formatted text output options
 *
 * Prerequisites:
 * - A GitHub Personal Access Token configured in Settings > GitHub
 * - GitHub CLI (gh) is optional — used as a faster path when available
 *
 * Usage:
 * The MCP server is automatically added to SDK sessions when enabled.
 * Tools are prefixed with "mcp__gh-search__" in the SDK.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { createGhSearchMcpServer, getGhSearchSdkToolNames } from './sdk-mcp-server';
import { resolveGhBinary } from '../auth/github-auth.service';
import { proxyFetch } from '../proxy';
import { getGitHubToken } from '../config.service';

const execAsync = promisify(exec);

// Re-export SDK MCP server functions
export { createGhSearchMcpServer, getGhSearchSdkToolNames };

// ============================================
// Module Status Check
// ============================================

export interface GhSearchAuthStatus {
  patAuth: { authenticated: boolean; user: string | null };
  ghCli: { available: boolean; authenticated: boolean; user: string | null };
}

/**
 * Check GitHub authentication status.
 * PAT is the primary auth (required for all API operations).
 * gh CLI is optional (used as a faster path when available).
 */
export async function checkGhCliStatus(): Promise<GhSearchAuthStatus> {
  // 1. Check PAT auth (primary)
  let patAuth: { authenticated: boolean; user: string | null } = {
    authenticated: false,
    user: null,
  };
  const token = getGitHubToken();
  if (token) {
    const ghHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    try {
      const resp = await proxyFetch('https://api.github.com/user', {
        headers: ghHeaders,
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        const data = await resp.json();
        patAuth = { authenticated: true, user: data.login };
      }
    } catch {
      // Proxy failed, try direct
      try {
        const resp = await fetch('https://api.github.com/user', {
          headers: ghHeaders,
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.ok) {
          const data = await resp.json();
          patAuth = { authenticated: true, user: data.login };
        }
      } catch {
        // Both failed
      }
    }
  }

  // 2. Check gh CLI (optional)
  const ghCli: { available: boolean; authenticated: boolean; user: string | null } = {
    available: false,
    authenticated: false,
    user: null,
  };

  const ghBin = resolveGhBinary();

  try {
    await execAsync(`"${ghBin}" --version`);
    ghCli.available = true;
  } catch {
    // gh CLI not available
  }

  if (ghCli.available) {
    try {
      const { stdout } = await execAsync(
        `"${ghBin}" auth status --hostname github.com 2>&1 || true`,
      );
      if (!stdout.includes('not logged in')) {
        ghCli.authenticated = true;
        try {
          const { stdout: userOut } = await execAsync(`"${ghBin}" api user --jq ".login"`);
          ghCli.user = userOut.trim();
        } catch {
          // user lookup failed but CLI is authenticated
        }
      }
    } catch {
      // gh CLI network call failed, that's fine
    }
  }

  return { patAuth, ghCli };
}

// ============================================
// Tool Registration
// ============================================

/**
 * Get all GitHub Search tool names for SDK allowedTools
 */
export function getGhSearchToolNames(): string[] {
  return getGhSearchSdkToolNames();
}

/**
 * Check if a tool name is a GitHub Search tool
 */
export function isGhSearchTool(toolName: string): boolean {
  return toolName.startsWith('gh_search_');
}

// ============================================
// System Prompt
// ============================================

/**
 * GitHub Search system prompt addition.
 * Append this to the system prompt when GitHub Search is enabled.
 *
 * Note: Tools are exposed via MCP server with prefix "mcp__gh-search__"
 * e.g., mcp__gh-search__gh_search_repos
 */
export const GH_SEARCH_SYSTEM_PROMPT = `
## GitHub Search

You have access to GitHub search and view capabilities via the MCP server "gh-search". This provides native GitHub operations without requiring browser automation.

### Prerequisites
- A GitHub Personal Access Token must be configured in Settings > GitHub
- GitHub CLI (gh) is optional — if searches fail, suggest the user configure a GitHub token in Settings

### Search Tools (prefix: mcp__gh-search__)

- \`gh_search_repos\` - Search GitHub repositories
  - Supports: stars, language, topic, created/updated date filters
  - Sort options: stars, forks, help-wanted-issues, updated
  - Example: "stars:>1000 language:typescript topic:cli"

- \`gh_search_issues\` - Search GitHub issues
  - Supports: state, labels, author, assignee filters
  - Sort options: comments, reactions, reactions-+1, reactions--1, reactions-smile, reactions-thinking_face, reactions-heart, reactions-tada, interactions, created, updated
  - Example: "is:open label:bug author:octocat"

- \`gh_search_prs\` - Search GitHub pull requests
  - Supports: state, draft, review status, merge status filters
  - Sort options: comments, reactions, reactions-+1, reactions--1, reactions-smile, reactions-thinking_face, reactions-heart, reactions-tada, interactions, created, updated
  - Example: "is:open is:pr draft:false review:required"

- \`gh_search_code\` - Search code within repositories
  - Supports: language, path, filename, extension filters
  - Example: "function language:typescript repo:owner/repo"

- \`gh_search_commits\` - Search GitHub commits (query is optional)
  - Supports: author, committer, date range filters
  - Sort options: author-date, committer-date
  - **Important**: Only searches the default branch of repositories. Always include \`repo:owner/repo\` for reliable results.
  - Example: "author:octocat committer-date:>2024-01-01 repo:owner/repo"

### View Tools (prefix: mcp__gh-search__)

- \`gh_issue_view\` - View issue details
  - Parameters: number (required), repo (optional), comments (optional)
  - Returns: title, body, labels, assignees, milestone

- \`gh_pr_view\` - View pull request details
  - Parameters: number (required), repo (optional)
  - Returns: title, body, branch info, review status, mergeability

- \`gh_repo_view\` - View repository information
  - Parameters: repo (optional, uses current repo if not specified)
  - Returns: description, stats, topics, README

### Common Search Syntax

**Qualifiers (can be combined):**
- \`repo:owner/name\` - Search in specific repository
- \`org:orgname\` - Search in organization
- \`user:username\` - Search by user
- \`language:name\` - Filter by programming language
- \`stars:N\` or \`stars:>N\` - Filter by star count
- \`created:YYYY-MM-DD\` or \`created:>YYYY-MM-DD\` - Filter by creation date
- \`updated:>YYYY-MM-DD\` - Filter by last update
- \`is:public\` or \`is:private\` - Filter by visibility

### Usage Tips
1. Start with broad queries, then narrow down with qualifiers
2. Use \`json: true\` option for structured data when needed
3. Combine multiple qualifiers for precise results
4. Default limit is 30 results, max is 100
5. Use view tools to get detailed info after finding items via search
6. For commit searches, always specify \`repo:owner/repo\` to avoid timeout or scope errors
`;

// Re-export types
export type {
  GhRepoResult,
  GhIssueResult,
  GhPrResult,
  GhCodeResult,
  GhCommitResult,
  GhSearchOptions,
  GhToolResult,
} from './types';
