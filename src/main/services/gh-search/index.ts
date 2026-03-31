/**
 * GitHub Search Module - Main Entry Point
 *
 * This module provides GitHub search capabilities via the GitHub CLI (gh).
 * It enables the AI to search repositories, issues, pull requests, code,
 * and commits directly without requiring browser automation.
 *
 * Key Features:
 * - 5 GitHub search tools (repos, issues, PRs, code, commits)
 * - Native GitHub CLI integration
 * - Full GitHub search syntax support
 * - JSON and formatted text output options
 *
 * Prerequisites:
 * - GitHub CLI (gh) must be installed
 * - Run `gh auth login` to authenticate
 *
 * Usage:
 * The MCP server is automatically added to SDK sessions when enabled.
 * Tools are prefixed with "mcp__gh-search__" in the SDK.
 */

// Import SDK MCP server creator
import { createGhSearchMcpServer, getGhSearchSdkToolNames, getGhBinaryPath } from './sdk-mcp-server'

// Re-export SDK MCP server functions
export { createGhSearchMcpServer, getGhSearchSdkToolNames }

// ============================================
// Module Status Check
// ============================================

/**
 * Check if GitHub CLI is available and authenticated.
 * Returns an object with status and optional error message.
 */
export async function checkGhCliStatus(): Promise<{
  available: boolean
  authenticated: boolean
  error?: string
  user?: string
}> {
  const { exec } = require('child_process')
  const { promisify } = require('util')
  const execAsync = promisify(exec)

  const ghBin = getGhBinaryPath()

  try {
    // Check if gh is available (bundled or system)
    await execAsync(`"${ghBin}" --version`)
  } catch {
    return {
      available: false,
      authenticated: false,
      error: 'GitHub CLI (gh) is not installed. Install from https://cli.github.com/'
    }
  }

  try {
    // Check authentication status
    const { stdout } = await execAsync(`"${ghBin}" auth status --hostname github.com 2>&1 || true`)

    // Parse the output to check if logged in
    if (stdout.includes('not logged in')) {
      return {
        available: true,
        authenticated: false,
        error: 'GitHub CLI is not authenticated. Run `gh auth login` to authenticate.'
      }
    }

    // Try to get the logged in user
    try {
      const { stdout: userOut } = await execAsync(`"${ghBin}" api user --jq ".login"`)
      return {
        available: true,
        authenticated: true,
        user: userOut.trim()
      }
    } catch {
      return {
        available: true,
        authenticated: true
      }
    }
  } catch (error: any) {
    return {
      available: true,
      authenticated: false,
      error: error.message
    }
  }
}

// ============================================
// Tool Registration
// ============================================

/**
 * Get all GitHub Search tool names for SDK allowedTools
 */
export function getGhSearchToolNames(): string[] {
  return getGhSearchSdkToolNames()
}

/**
 * Check if a tool name is a GitHub Search tool
 */
export function isGhSearchTool(toolName: string): boolean {
  return toolName.startsWith('gh_search_')
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
- GitHub CLI (gh) must be installed and authenticated
- If searches fail, suggest the user run \`gh auth login\`

### Search Tools (prefix: mcp__gh-search__)

- \`gh_search_repos\` - Search GitHub repositories
  - Supports: stars, language, topic, created/updated date filters
  - Example: "stars:>1000 language:typescript topic:cli"

- \`gh_search_issues\` - Search GitHub issues
  - Supports: state, labels, author, assignee filters
  - Example: "is:open label:bug author:octocat"

- \`gh_search_prs\` - Search GitHub pull requests
  - Supports: state, draft, review status, merge status filters
  - Example: "is:open is:pr draft:false review:required"

- \`gh_search_code\` - Search code within repositories
  - Supports: language, path, filename, extension filters
  - Example: "function language:typescript repo:owner/repo"

- \`gh_search_commits\` - Search GitHub commits
  - Supports: author, committer, date range filters
  - Example: "author:octocat committer-date:>2024-01-01"

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
`

// Re-export types
export type { GhRepoResult, GhIssueResult, GhPrResult, GhCodeResult, GhCommitResult, GhSearchOptions, GhToolResult } from './types'
