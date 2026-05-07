/**
 * GitHub SDK MCP Server - Aggregation Layer
 *
 * Re-exports from split modules. See individual files for implementation:
 * - gh-api.ts: API infrastructure (execGh, ghApiDirect, GithubApiError)
 * - gh-helpers.ts: Utility functions (textResult, buildSearchParams, etc.)
 * - gh-formatters.ts: Result formatting (formatRepoResults, formatIssueView, etc.)
 * - gh-tools.ts: Tool definitions (buildAllTools)
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { resolveGhBinary } from '../auth/github-auth.service';
import { buildAllTools } from './gh-tools';

// Re-exports for external consumers
export { GithubApiError, execGh } from './gh-api';
export { buildAllTools } from './gh-tools';
export { resolveGhBinary as getGhBinaryPath };

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
