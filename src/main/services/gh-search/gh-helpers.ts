/**
 * GitHub Search - Helper Utilities
 */

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;

/**
 * Build a standard text content response.
 */
export function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Build URL params from a gh search command string.
 */
export function buildSearchParams(ghArgs: string, type: string): string {
  const params = new URLSearchParams();

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

  const repoMatch = ghArgs.match(/--repo\s+(\S+)/);
  if (repoMatch) {
    params.set('q', (params.get('q') || '') + ` repo:${repoMatch[1]}`);
  }

  const limitMatch = ghArgs.match(/--limit\s+(\d+)/);
  if (limitMatch) {
    params.set('per_page', limitMatch[1]);
  }

  const sortMatch = ghArgs.match(/--sort\s+(\S+)/);
  if (sortMatch) {
    params.set('sort', sortMatch[1]);
  }

  const orderMatch = ghArgs.match(/--order\s+(\S+)/);
  if (orderMatch) {
    params.set('order', orderMatch[1]);
  }

  return params.toString();
}

/**
 * Parse issue/PR view args to extract number and repo.
 */
export function parseViewArgs(ghArgs: string): { number: number; repo: string | null } {
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
export function parseRepoViewArgs(ghArgs: string): string | null {
  const match = ghArgs.match(/repo view\s+(\S+?)(?:\s+--|$)/);
  return match ? match[1] : null;
}

/**
 * Extract repo qualifier from query and return clean query + repo value.
 */
export function extractRepoQualifier(query: string): { cleanQuery: string; repo: string | null } {
  const repoMatch = query.match(/repo:("([^"]+)"|([^\s]+))/i);
  if (repoMatch) {
    const repoValue = repoMatch[2] || repoMatch[3];
    const cleanQuery = query.replace(repoMatch[0], '').replace(/\s+/g, ' ').trim();
    return { cleanQuery, repo: repoValue };
  }
  return { cleanQuery: query, repo: null };
}
