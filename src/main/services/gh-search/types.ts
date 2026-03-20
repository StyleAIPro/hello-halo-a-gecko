/**
 * GitHub Search MCP - Type Definitions
 *
 * Types for GitHub search results and tool parameters.
 */

/**
 * GitHub repository search result
 */
export interface GhRepoResult {
  name: string
  fullName: string
  description: string
  url: string
  stars: number
  forks: number
  language: string | null
  isPrivate: boolean
  isFork: boolean
  updatedAt: string
}

/**
 * GitHub issue search result
 */
export interface GhIssueResult {
  number: number
  title: string
  url: string
  state: string
  author: string
  labels: string[]
  createdAt: string
  updatedAt: string
  body: string | null
}

/**
 * GitHub pull request search result
 */
export interface GhPrResult {
  number: number
  title: string
  url: string
  state: string
  author: string
  isDraft: boolean
  isMerged: boolean
  baseBranch: string
  headBranch: string
  createdAt: string
  updatedAt: string
  body: string | null
}

/**
 * GitHub code search result
 */
export interface GhCodeResult {
  path: string
  repository: string
  url: string
  language: string | null
  lineNumbers: string | null
  snippet: string | null
}

/**
 * GitHub commit search result
 */
export interface GhCommitResult {
  sha: string
  shortSha: string
  message: string
  author: string
  repository: string
  url: string
  committedAt: string
}

/**
 * Common search options
 */
export interface GhSearchOptions {
  /** Maximum number of results to return */
  limit?: number
  /** Sort field */
  sort?: string
  /** Sort order (asc/desc) */
  order?: 'asc' | 'desc'
  /** Filter by owner/organization */
  owner?: string
  /** Filter by repository */
  repo?: string
}

/**
 * Tool execution result
 */
export interface GhToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}
