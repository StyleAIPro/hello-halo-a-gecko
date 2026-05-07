/**
 * GitHub Search - Tool Definitions
 *
 * Defines all GitHub search and view tools for the MCP server.
 */

import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { execGh, GithubApiError } from './gh-api';
import { textResult, extractRepoQualifier, DEFAULT_LIMIT, MAX_LIMIT } from './gh-helpers';
import {
  formatRepoResults,
  formatIssueResults,
  formatPrResults,
  formatCodeResults,
  formatCommitResults,
  formatIssueView,
  formatPrView,
  formatRepoView,
} from './gh-formatters';

/**
 * Build all GitHub tools.
 * Exported for reuse by the MCP proxy server.
 */
export function buildAllTools() {
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

  return [
    gh_search_repos,
    gh_search_issues,
    gh_search_prs,
    gh_search_code,
    gh_search_commits,
    gh_issue_view,
    gh_pr_view,
    gh_repo_view,
  ];
}
