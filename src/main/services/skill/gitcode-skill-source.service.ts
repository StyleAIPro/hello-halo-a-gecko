/**
 * GitCode Skill Source Service
 *
 * Provides read/write operations for skill repositories on GitCode (gitcode.com).
 * Parallel to github-skill-source.service.ts but uses GitCode v5 API.
 * Auth via user-provided Personal Access Token stored in config.
 */

import { parse as parseYaml } from 'yaml';
import { getGitCodeToken } from '../config.service';
import type { RemoteSkillItem } from '../../../shared/skill/skill-types';

// ── GitCode API fetch ──────────────────────────────────────────────

interface GitCodeApiOptions {
  token?: string;
}

const GITCODE_API_BASE = 'https://gitcode.com/api/v5';

// ── Global concurrency semaphore ───────────────────────────────────────
// A single shared queue ensures ALL GitCode API calls (including recursive
// findSkillDirs) stay within the concurrency budget. No more per-level pools
// that multiply concurrency at each recursion depth.

const MAX_CONCURRENCY = 3;

class Semaphore {
  private _queue: Array<() => void> = [];
  private _running = 0;

  async acquire(): Promise<void> {
    if (this._running < MAX_CONCURRENCY) {
      this._running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    this._running--;
    const next = this._queue.shift();
    if (next) {
      this._running++;
      next();
    }
  }
}

const _apiSemaphore = new Semaphore();

// ── Rate Limiter ──────────────────────────────────────────────────
// GitCode limit: 50 requests/min per user. All repos share one quota.
// Strategy: minimum 1s gap between consecutive requests + token bucket ceiling.

const RATE_LIMIT_MAX_TOKENS = 50;
const RATE_LIMIT_MIN_INTERVAL_MS = 1000; // 1s gap between any two requests
const RATE_LIMIT_REFILL_INTERVAL_MS = 1200; // 50 tokens/min ceiling

class RateLimiter {
  private _tokens: number;
  private _lastRefill: number;
  private _lastAcquire: number;

  constructor() {
    this._tokens = 1;
    this._lastRefill = Date.now();
    this._lastAcquire = 0;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this._lastRefill;
    const tokensToAdd = Math.floor(elapsed / RATE_LIMIT_REFILL_INTERVAL_MS);
    if (tokensToAdd > 0) {
      this._tokens = Math.min(this._tokens + tokensToAdd, RATE_LIMIT_MAX_TOKENS);
      this._lastRefill += tokensToAdd * RATE_LIMIT_REFILL_INTERVAL_MS;
    }
  }

  async acquire(): Promise<void> {
    // Enforce minimum 1s interval between consecutive requests
    const now = Date.now();
    const sinceLast = now - this._lastAcquire;
    if (sinceLast < RATE_LIMIT_MIN_INTERVAL_MS && this._lastAcquire > 0) {
      await new Promise<void>((r) => setTimeout(r, RATE_LIMIT_MIN_INTERVAL_MS - sinceLast));
    }

    this.refill();
    if (this._tokens > 0) {
      this._tokens--;
      this._lastAcquire = Date.now();
      return;
    }
    // No tokens — wait for next refill
    await new Promise<void>((r) => setTimeout(r, RATE_LIMIT_REFILL_INTERVAL_MS));
    this.refill();
    this._tokens = Math.max(this._tokens - 1, 0);
    this._lastAcquire = Date.now();
  }
}

const _rateLimiter = new RateLimiter();

// Telemetry counters
let _requestCount = 0;

/**
 * Run an async function with global concurrency control (semaphore only).
 * Rate limiting is handled at the gitcodeApiFetch level to avoid double-limiting
 * and to prevent semaphore deadlock from nested calls.
 */
async function withConcurrency<T>(fn: () => Promise<T>): Promise<T> {
  // Log telemetry every 10 requests
  _requestCount++;
  if (_requestCount % 10 === 0) {
    console.log(`[GitCodeSkillSource] Concurrency telemetry: ${_requestCount} requests`);
  }

  await _apiSemaphore.acquire();
  try {
    return await fn();
  } finally {
    _apiSemaphore.release();
  }
}

// Proxy support for internal networks
// GitCode is a domestic (Chinese) platform — skip proxy for gitcode.com to avoid
// unnecessary latency. Proxy is only used for non-gitcode.com hosts.
let _proxyDispatcher: any = null;

/** Reset cached proxy so next call re-reads env vars (e.g. after VPN change). */
export function resetProxyDispatcher(): void {
  _proxyDispatcher = null;
}

async function getProxyDispatcher(): Promise<any> {
  if (_proxyDispatcher !== null) return _proxyDispatcher;
  // GitCode is domestic — never use proxy
  _proxyDispatcher = false;
  return false;
}

/** Default request timeout for GitCode API calls (ms). */
const GITCODE_FETCH_TIMEOUT_MS = 30_000;

/**
 * Proxy-aware fetch for GitCode API with 30s timeout. Exported for reuse by gitcode-auth.service.
 */
export async function gitcodeFetch(url: string, init?: RequestInit): Promise<Response> {
  const dispatcher = await getProxyDispatcher();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITCODE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      ...(dispatcher ? ({ dispatcher } as any) : {}),
    });
    return response;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `GitCode API request timed out after ${GITCODE_FETCH_TIMEOUT_MS / 1000}s: ${url}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function gitcodeApiFetch(path: string, options?: GitCodeApiOptions): Promise<any> {
  // Rate limit all API calls at the entry point to prevent semaphore deadlock
  // from nested withConcurrency calls in recursive findSkillDirs.
  await _rateLimiter.acquire();
  _requestCount++;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options?.token) {
    headers['private-token'] = options.token;
  }

  // Support access_token as query param fallback
  const url = path.includes('?') ? `${GITCODE_API_BASE}${path}` : `${GITCODE_API_BASE}${path}`;

  const response = await gitcodeFetch(url, { headers });

  if (response.status === 404) {
    return null;
  }

  // Handle rate limiting: GitCode returns 429 as HTTP 400 with error_code:429 in body
  const isRateLimited = async (resp: Response): Promise<boolean> => {
    if (resp.status === 429) return true;
    if (resp.status === 400) {
      try {
        const body = await resp.clone().json();
        return body?.error_code === 429;
      } catch {
        return false;
      }
    }
    return false;
  };

  if (await isRateLimited(response)) {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const delayMs = Math.min(2000 * Math.pow(2, attempt), 8000);
      console.warn(
        `[GitCodeAPI] Rate limited, attempt ${attempt + 1}/${maxRetries}, waiting ${delayMs}ms...`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
      const retryResponse = await gitcodeFetch(url, { headers });
      if (!(await isRateLimited(retryResponse))) {
        if (!retryResponse.ok) {
          const text = await retryResponse.text();
          console.error(
            '[GitCodeAPI] error after retry:',
            retryResponse.status,
            text.slice(0, 200),
          );
          throw new Error(`GitCode API error ${retryResponse.status}: ${text}`);
        }
        return retryResponse.json();
      }
    }
    throw new Error('GitCode API rate limit exceeded after 3 retries. Please try again later.');
  }

  if (!response.ok) {
    const text = await response.text();
    console.error('[GitCodeAPI] error:', response.status, text.slice(0, 200));
    throw new Error(`GitCode API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data;
}

// ── Progress callback ─────────────────────────────────────────────

export interface SkillFetchProgress {
  phase: 'scanning' | 'fetching-metadata';
  current: number;
  total: number;
}

export type SkillFetchProgressCallback = (progress: SkillFetchProgress) => void;

// ── Frontmatter parsing (shared pattern) ──────────────────────────

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  trigger_command?: string;
  tags?: string[];
}

function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  try {
    const parsed = parseYaml(match[1]) as SkillFrontmatter;
    const body = content.slice(match[0].length).trim();
    return { frontmatter: parsed || {}, body };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

function formatSkillName(name: string): string {
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Token management ──────────────────────────────────────────────

export { getGitCodeToken };

// ── One-level skill directory listing (for known skill dirs like skills/) ───

async function listSkillsDir(
  repo: string,
  dirPath: string,
  token?: string,
): Promise<Array<{ path: string; name: string }>> {
  try {
    const apiPath = `/repos/${repo}/contents/${dirPath.replace(/\/$/, '')}`;
    const result = await gitcodeApiFetch(apiPath, { token });
    if (!Array.isArray(result)) return [];
    return result
      .filter((item: any) => item.type === 'dir' && !item.name.startsWith('.'))
      .map((item: any) => ({ path: `${dirPath}/${item.name}`, name: item.name }));
  } catch {
    return [];
  }
}

// ── Recursive skill directory finder ──────────────────────────────

async function findSkillDirs(
  repo: string,
  path: string,
  token?: string,
  maxDepth: number = 5,
  onProgress?: SkillFetchProgressCallback,
): Promise<Array<{ path: string; name: string }>> {
  if (maxDepth <= 0) return [];

  const apiPath =
    path === '/' ? `/repos/${repo}/contents` : `/repos/${repo}/contents/${path.replace(/\/$/, '')}`;

  let data: any[];
  try {
    const result = await gitcodeApiFetch(apiPath, { token });
    if (!Array.isArray(result)) return [];
    data = result;
  } catch {
    return [];
  }

  const dirs = data.filter((item: any) => item.type === 'dir' && !item.name.startsWith('.'));
  const hasSkillMd = data.some(
    (item: any) => item.type === 'file' && item.name.toUpperCase() === 'SKILL.MD',
  );

  const results: Array<{ path: string; name: string }> = [];

  if (hasSkillMd) {
    const dirName = path === '/' ? '' : path.replace(/\/$/, '').split('/').pop()!;
    results.push({ path: path.replace(/\/$/, ''), name: dirName });
    return results;
  }

  // Report scanning progress (only at top-level, not recursive)
  let scannedCount = 0;
  const totalDirs = dirs.length;

  // Short-circuit optimization: once any child directory is confirmed to contain
  // SKILL.md, treat the current directory as a "skill category" (equivalent to
  // skills/) and promote ALL remaining sibling directories as skill candidates.
  // This avoids N-1 additional recursive API calls for category-based repos like
  // Inference/skill-name/SKILL.md, Operation/skill-name/SKILL.md.
  let foundCategory = false;

  await Promise.all(
    dirs.map(async (dir: any) => {
      const subPath = path === '/' ? `${dir.name}/` : `${path}${dir.name}/`;
      // Check foundCategory — by this point, other concurrent callbacks may have
      // already set foundCategory (avoiding unnecessary recursive calls).
      if (foundCategory) {
        scannedCount++;
        onProgress?.({ phase: 'scanning', current: scannedCount, total: totalDirs });
        return;
      }

      const sub = await findSkillDirs(repo, subPath, token, maxDepth - 1);
      scannedCount++;
      onProgress?.({ phase: 'scanning', current: scannedCount, total: totalDirs });

      // If this child is a skill (has SKILL.md), promote all siblings as candidates
      if (sub.length > 0 && !foundCategory) {
        foundCategory = true;
        results.push(...sub);
        // Return remaining siblings as skill candidates (their SKILL.md will be
        // validated later during metadata fetch)
        const promotedSiblings = dirs
          .filter((d: any) => d.name !== dir.name)
          .map((d: any) => ({
            path: (path === '/' ? '' : path.replace(/\/$/, '')) + '/' + d.name,
            name: d.name,
          }));
        results.push(...promotedSiblings);
      } else {
        results.push(...sub);
      }

      return sub;
    }),
  );

  return results;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Fetch single file content from GitCode repo.
 */
export async function fetchSkillFileContent(
  repo: string,
  path: string,
  token?: string,
): Promise<string | null> {
  try {
    const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/');
    const data = await gitcodeApiFetch(`/repos/${repo}/contents/${encodedPath}`, { token });
    if (data && data.content && !Array.isArray(data)) {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
  } catch {
    // file not found or access denied
  }
  return null;
}

/**
 * Recursively download all files in a GitCode directory.
 */
export async function fetchSkillDirectoryContents(
  repo: string,
  dirPath: string,
  token?: string,
): Promise<Array<{ path: string; content: string }>> {
  const results: Array<{ path: string; content: string }> = [];
  const apiPath = `/repos/${repo}/contents/${dirPath.replace(/\/$/, '')}`;

  let data: any;
  try {
    data = await gitcodeApiFetch(apiPath, { token });
  } catch {
    return results;
  }

  if (data && !Array.isArray(data)) {
    if (data.content) {
      const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
      results.push({ path: data.name, content: decoded });
    }
    return results;
  }

  if (!Array.isArray(data)) return results;

  // Separate files needing fetch and sub-directories for batch processing
  const filesToFetch = data.filter((item: any) => item.type === 'file' && !item.content);
  const dirsToTraverse = data.filter(
    (item: any) => item.type === 'dir' && !item.name.startsWith('.'),
  );

  // Inline file content (already present, no API call needed)
  for (const item of data) {
    if (item.type === 'file' && item.content) {
      const decoded = Buffer.from(item.content, 'base64').toString('utf-8');
      results.push({ path: item.name, content: decoded });
    }
  }

  // Batch fetch files that need separate API calls
  const fetchResults = await Promise.all(
    filesToFetch.map(async (item: any) => {
      const content = await withConcurrency(() => fetchSkillFileContent(repo, item.path, token));
      return { path: item.name, content: content || '' };
    }),
  );
  for (const r of fetchResults) {
    if (r.content) results.push(r);
  }

  // Batch traverse sub-directories
  const dirResults = await Promise.all(
    dirsToTraverse.map(async (item: any) => {
      const subPath = `${dirPath.replace(/\/$/, '')}/${item.name}`;
      return withConcurrency(() => fetchSkillDirectoryContents(repo, subPath, token));
    }),
  );
  for (let i = 0; i < dirResults.length; i++) {
    const dir = dirsToTraverse[i];
    for (const sub of dirResults[i]) {
      results.push({ path: `${dir.name}/${sub.path}`, content: sub.content });
    }
  }

  return results;
}

/**
 * Find the skill directory path on GitCode by checking path variants.
 * Includes case-insensitive fallback via findSkillDirs listing.
 */
export async function findSkillDirectoryPath(
  repo: string,
  skillName: string,
  token?: string,
): Promise<string | null> {
  const lastSegment = skillName.split('/').pop() || skillName;
  const dirVariants = [skillName, `skills/${skillName}`, lastSegment];

  const skillFileNames = ['SKILL.md', 'SKILL.yaml'];

  // Try exact path matches first
  for (const dir of dirVariants) {
    const apiPath = `/repos/${repo}/contents/${dir.replace(/\/$/, '')}`;
    try {
      const data = await gitcodeApiFetch(apiPath, { token });
      if (Array.isArray(data)) {
        const found = data.some(
          (item: any) =>
            item.type === 'file' &&
            skillFileNames.some((sf) => item.name.toUpperCase() === sf.toUpperCase()),
        );
        if (found) {
          return dir.replace(/\/$/, '');
        }
      }
    } catch {
      // continue
    }
  }

  // Case-insensitive fallback: list skill dirs (limited depth + timeout)
  console.warn('[GitCodeSkillSource] Exact match failed, falling back to recursive scan for', {
    repo,
    skillName,
    triedPaths: dirVariants,
  });

  try {
    const FALLBACK_TIMEOUT = 15_000;
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => {
        console.warn(
          '[GitCodeSkillSource] findSkillDirs fallback timed out (15s) for',
          repo,
          skillName,
        );
        resolve(null);
      }, FALLBACK_TIMEOUT),
    );
    const dirsPromise = findSkillDirs(repo, '/', token, 2);
    const allDirs = await Promise.race([dirsPromise, timeoutPromise]);

    if (!allDirs) {
      console.warn(
        '[GitCodeSkillSource] Fallback scan timed out, tried paths:',
        dirVariants.join(', '),
      );
      return null;
    }

    const normalizedTarget = skillName.toLowerCase();
    for (const { path: dirPath } of allDirs) {
      if (
        dirPath.toLowerCase() === normalizedTarget ||
        dirPath.toLowerCase().endsWith(`/${normalizedTarget}`)
      ) {
        return dirPath;
      }
    }
    // Also try matching just the last segment
    const normalizedLast = lastSegment.toLowerCase();
    for (const { path: dirPath } of allDirs) {
      const dirLast = dirPath.split('/').pop() || dirPath;
      if (dirLast.toLowerCase() === normalizedLast) {
        return dirPath;
      }
    }
  } catch (error) {
    console.error('[GitCodeSkillSource] Fallback scan failed for', repo, skillName, error);
  }

  return null;
}

/**
 * List subdirectories in a GitCode repo.
 */
export async function listRepoDirectories(
  repo: string,
  basePath?: string,
  token?: string,
): Promise<string[]> {
  try {
    const apiPath = basePath ? `/repos/${repo}/contents/${basePath}` : `/repos/${repo}/contents`;
    const data = await gitcodeApiFetch(apiPath, { token });
    if (!Array.isArray(data)) return [];
    return data
      .filter((item: any) => item.type === 'dir' && !item.name.startsWith('.'))
      .map((item: any) => item.name);
  } catch {
    return [];
  }
}

/**
 * List all skills in a GitCode repository.
 */
export async function listSkillsFromRepo(
  repo: string,
  token?: string,
  onProgress?: SkillFetchProgressCallback,
): Promise<RemoteSkillItem[]> {
  const skills: RemoteSkillItem[] = [];
  const sourceId = `gitcode:${repo}`;
  const seenPaths = new Set<string>();

  const pathsToCheck = ['skills/', '/'];

  for (const basePath of pathsToCheck) {
    try {
      let skillDirs: Array<{ path: string; name: string }>;

      if (basePath === 'skills/') {
        // Fast path: skills/ directory — just list one level, no recursion.
        skillDirs = await listSkillsDir(repo, 'skills', token);
      } else {
        // Fallback: root path — shallow scan for SKILL.md (max depth 2)
        skillDirs = await findSkillDirs(repo, basePath, token, 3, onProgress);
      }

      const uniqueDirs = skillDirs.filter(({ path: p }) => {
        if (seenPaths.has(p)) return false;
        seenPaths.add(p);
        return true;
      });

      let metadataFetched = 0;
      const totalToFetch = uniqueDirs.length;

      // Sequential fetch for smooth, even progress advancement
      for (const { path: skillPath, name } of uniqueDirs) {
        try {
          const item = await withConcurrency(async () => {
            let frontmatter: SkillFrontmatter = {};
            let description = '';

            try {
              const content = await fetchSkillFileContent(repo, `${skillPath}/SKILL.md`, token);
              if (content) {
                const parsed = parseFrontmatter(content);
                frontmatter = parsed.frontmatter;
                description = parsed.body
                  .split('\n')
                  .filter((l) => l.trim() && !l.startsWith('#'))
                  .slice(0, 3)
                  .join(' ');
              }
            } catch {
              // continue without metadata
            }

            const skillName = frontmatter.name || name;
            const skillId = skillPath.toLowerCase().replace(/\s+/g, '-');

            return {
              id: `${sourceId}:${skillId}`,
              name: formatSkillName(skillName),
              description: frontmatter.description || description || `Skill from ${repo}`,
              fullDescription: undefined,
              version: frontmatter.version || '1.0.0',
              author: frontmatter.author || repo.split('/')[0],
              tags: frontmatter.tags || [],
              lastUpdated: new Date().toISOString(),
              sourceId,
              remoteRepo: repo,
              remotePath: skillPath,
            } as RemoteSkillItem;
          });
          skills.push(item);
        } catch {
          // skip failed item
        }
        metadataFetched++;
        onProgress?.({
          phase: 'fetching-metadata',
          current: metadataFetched,
          total: totalToFetch,
        });
      }

      if (skills.length > 0 && basePath === 'skills/') break;
    } catch (error) {
      console.error(`[GitCodeSkillSource] Error listing ${repo}/${basePath}:`, error);
    }
  }

  return skills;
}

/**
 * Streaming variant: fetches skills one-by-one, calling onSkillFound after each.
 * Used for progressive loading — frontend renders skills as they arrive.
 */
export type SkillFoundCallback = (skill: RemoteSkillItem, totalFound: number) => void;

export async function listSkillsFromRepoStreaming(
  repo: string,
  token?: string,
  onProgress?: SkillFetchProgressCallback,
  onSkillFound?: SkillFoundCallback,
): Promise<RemoteSkillItem[]> {
  const skills: RemoteSkillItem[] = [];
  const sourceId = `gitcode:${repo}`;
  const seenPaths = new Set<string>();

  const pathsToCheck = ['skills/', '/'];

  for (const basePath of pathsToCheck) {
    try {
      let skillDirs: Array<{ path: string; name: string }>;

      if (basePath === 'skills/') {
        skillDirs = await listSkillsDir(repo, 'skills', token);
      } else {
        skillDirs = await findSkillDirs(repo, basePath, token, 3, onProgress);
      }

      const uniqueDirs = skillDirs.filter(({ path: p }) => {
        if (seenPaths.has(p)) return false;
        seenPaths.add(p);
        return true;
      });

      let metadataFetched = 0;
      const totalToFetch = uniqueDirs.length;

      // Sequential fetch — each skill pushed individually
      for (const { path: skillPath, name } of uniqueDirs) {
        try {
          const item = await withConcurrency(async () => {
            let frontmatter: SkillFrontmatter = {};
            let description = '';

            try {
              const content = await fetchSkillFileContent(repo, `${skillPath}/SKILL.md`, token);
              if (content) {
                const parsed = parseFrontmatter(content);
                frontmatter = parsed.frontmatter;
                description = parsed.body
                  .split('\n')
                  .filter((l) => l.trim() && !l.startsWith('#'))
                  .slice(0, 3)
                  .join(' ');
              }
            } catch {
              // continue without metadata
            }

            const skillName = frontmatter.name || name;
            const skillId = skillPath.toLowerCase().replace(/\s+/g, '-');

            return {
              id: `${sourceId}:${skillId}`,
              name: formatSkillName(skillName),
              description: frontmatter.description || description || `Skill from ${repo}`,
              fullDescription: undefined,
              version: frontmatter.version || '1.0.0',
              author: frontmatter.author || repo.split('/')[0],
              tags: frontmatter.tags || [],
              lastUpdated: new Date().toISOString(),
              sourceId,
              remoteRepo: repo,
              remotePath: skillPath,
            } as RemoteSkillItem;
          });

          skills.push(item);
          metadataFetched++;
          onProgress?.({
            phase: 'fetching-metadata',
            current: metadataFetched,
            total: totalToFetch,
          });
          onSkillFound?.(item, skills.length);
        } catch {
          metadataFetched++;
          onProgress?.({
            phase: 'fetching-metadata',
            current: metadataFetched,
            total: totalToFetch,
          });
        }
      }

      if (skills.length > 0 && basePath === 'skills/') break;
    } catch (error) {
      console.error(`[GitCodeSkillSource] Error listing ${repo}/${basePath}:`, error);
    }
  }

  return skills;
}

/**
 * Get detailed skill content from a GitCode repo.
 */
export async function getSkillDetailFromRepo(
  repo: string,
  skillPath: string,
  token?: string,
): Promise<RemoteSkillItem | null> {
  const skillName = skillPath.split('/').pop() || skillPath;
  const sourceId = `gitcode:${repo}`;
  const skillId = skillPath.toLowerCase().replace(/\s+/g, '-');

  const contentPaths = [`${skillPath}/SKILL.md`, `${skillPath}/SKILL.yaml`];

  for (const contentPath of contentPaths) {
    const content = await fetchSkillFileContent(repo, contentPath, token);
    if (content) {
      const isYaml = contentPath.endsWith('.yaml');
      const parsed = isYaml ? null : parseFrontmatter(content);
      const frontmatter = isYaml
        ? (parseYaml(content) as SkillFrontmatter)?.skill ||
          (parseYaml(content) as SkillFrontmatter)
        : parsed.frontmatter;
      const description = parsed
        ? parsed.body
            .split('\n')
            .filter((l) => l.trim() && !l.startsWith('#'))
            .slice(0, 3)
            .join(' ')
        : '';

      return {
        id: `${sourceId}:${skillId}`,
        name: formatSkillName(frontmatter?.name || skillName),
        description: frontmatter?.description || description || `Skill from ${repo}`,
        fullDescription: content,
        version: frontmatter?.version || '1.0.0',
        author: frontmatter?.author || repo.split('/')[0],
        tags: frontmatter?.tags || [],
        lastUpdated: new Date().toISOString(),
        sourceId,
        remoteRepo: repo,
        remotePath: skillPath,
        skillContent: content,
      };
    }
  }

  return null;
}

/**
 * Validate that a GitCode repo exists and contains skill directories.
 * Uses lightweight probing instead of full scan to avoid slow recursive traversal.
 */
export async function validateRepo(
  repo: string,
  token?: string,
): Promise<{ valid: boolean; hasSkillsDir?: boolean; skillCount?: number; error?: string }> {
  try {
    const data = await gitcodeApiFetch(`/repos/${repo}`, { token });
    if (!data) {
      return { valid: false, error: 'Repository not found or access denied' };
    }

    // Check if skills/ directory exists (fast path)
    const skillsProbe = await gitcodeApiFetch(`/repos/${repo}/contents/skills`, { token });
    if (Array.isArray(skillsProbe)) {
      const skillDirs = skillsProbe.filter(
        (item: any) => item.type === 'dir' && !item.name.startsWith('.'),
      );
      return { valid: true, hasSkillsDir: true, skillCount: skillDirs.length };
    }

    // No skills/ directory — sample up to 3 root-level subdirectories to detect
    // category-based structure (e.g., Inference/skill-name/SKILL.md)
    const rootContents = await gitcodeApiFetch(`/repos/${repo}/contents`, { token });
    if (!Array.isArray(rootContents)) {
      return { valid: true, skillCount: 0, error: 'Could not list repository contents' };
    }

    const rootDirs = rootContents.filter(
      (item: any) => item.type === 'dir' && !item.name.startsWith('.'),
    );
    if (rootDirs.length === 0) {
      return { valid: true, skillCount: 0, error: 'No directories found in repository' };
    }

    // Sample up to 3 root directories, check their children for SKILL.md
    const sampleDirs = rootDirs.slice(0, 3);
    let totalSkillCount = 0;
    let foundAny = false;

    for (const dir of sampleDirs) {
      const children = await gitcodeApiFetch(`/repos/${repo}/contents/${dir.name}`, { token });
      if (!Array.isArray(children)) continue;

      // Check if any child has SKILL.md (indicates category-based structure)
      const childDirs = children.filter(
        (item: any) => item.type === 'dir' && !item.name.startsWith('.'),
      );
      // Count children — they're likely all skills in a category structure
      if (childDirs.length > 0) {
        // Probe first child to confirm it has SKILL.md
        const probe = await gitcodeApiFetch(
          `/repos/${repo}/contents/${dir.name}/${childDirs[0].name}`,
          { token },
        );
        if (Array.isArray(probe) && probe.some((f: any) => f.name.toUpperCase() === 'SKILL.MD')) {
          foundAny = true;
          totalSkillCount += childDirs.length;
        }
      }
    }

    // Estimate total: extrapolate from sampled directories
    if (foundAny && sampleDirs.length < rootDirs.length) {
      const avgPerDir = totalSkillCount / sampleDirs.length;
      totalSkillCount = Math.round(avgPerDir * rootDirs.length);
    }

    if (totalSkillCount === 0) {
      return { valid: true, skillCount: 0, error: 'No skills found in this repository' };
    }

    return { valid: true, hasSkillsDir: false, skillCount: totalSkillCount };
  } catch (error: any) {
    console.error('[GitCodeService] validateRepo error:', error.message);
    return { valid: false, error: error.message || 'Failed to validate repository' };
  }
}

/**
 * Push a skill to a GitCode repo via Merge Request.
 */
export async function pushSkillAsMR(
  repo: string,
  skillId: string,
  files: Array<{ relativePath: string; content: string }>,
  targetPath?: string,
  token?: string,
): Promise<{ success: boolean; mrUrl?: string; error?: string; warning?: string }> {
  try {
    if (!token) {
      return {
        success: false,
        error: 'GitCode token is required. Please configure it in Settings.',
      };
    }

    // Get current user info
    const userData = await gitcodeApiFetch('/user', { token });
    if (!userData || !userData.login) {
      return { success: false, error: 'Failed to get GitCode user info. Check your token.' };
    }
    const username: string = userData.login;

    const branchName = `skill/${skillId}-${Date.now()}`;

    let targetRepo = repo;
    let mrTargetRepo = repo;

    // Check if repo is a fork
    try {
      const repoData = await gitcodeApiFetch(`/repos/${repo}`, { token });
      if (repoData?.fork && repoData?.parent?.full_name) {
        mrTargetRepo = repoData.parent.full_name;
      }
    } catch {
      // continue
    }

    // If not a fork, try fork for non-collaborators
    if (targetRepo === repo && mrTargetRepo === repo) {
      let isCollaborator = false;
      try {
        const collabRes = await gitcodeApiFetch(`/repos/${repo}/collaborators/${username}`, {
          token,
        });
        isCollaborator = !!collabRes;
      } catch {
        isCollaborator = false;
      }

      if (!isCollaborator) {
        try {
          const forkResp = await gitcodeFetch(
            `${GITCODE_API_BASE}/repos/${repo}/forks?access_token=${encodeURIComponent(token)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            },
          );
          if (!forkResp.ok && forkResp.status !== 409) {
            console.warn(`[GitCodeSkillSource] Fork failed: ${forkResp.status}`);
          }
        } catch (forkError: any) {
          console.warn('[GitCodeSkillSource] Fork warning:', forkError.message);
        }
        targetRepo = `${username}/${repo.split('/')[1]}`;
      }
    }

    // Get base branch SHA
    let baseBranch = 'main';
    let branchData = await gitcodeApiFetch(`/repos/${targetRepo}/branches/main`, { token });
    let baseSha: string | undefined = branchData?.commit?.id;
    if (!baseSha) {
      baseBranch = 'master';
      branchData = await gitcodeApiFetch(`/repos/${targetRepo}/branches/master`, { token });
      baseSha = branchData?.commit?.id;
    }
    if (!baseSha) {
      return {
        success: false,
        error: 'Failed to get base branch SHA from GitCode repo (tried main and master)',
      };
    }
    const branchResp = await gitcodeFetch(
      `${GITCODE_API_BASE}/repos/${targetRepo}/branches?access_token=${encodeURIComponent(token)}&refs=${encodeURIComponent(baseBranch)}&branch_name=${encodeURIComponent(branchName)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
    );
    if (!branchResp.ok) {
      const errText = await branchResp.text();
      return { success: false, error: `Failed to create branch: ${branchResp.status} ${errText}` };
    }

    // Commit all files - GitCode uses POST for new files, PUT for updates
    const commitErrors: string[] = [];
    let commitSuccess = 0;
    for (const file of files) {
      const filePath = targetPath
        ? `${targetPath}/${skillId}/${file.relativePath}`
        : `${skillId}/${file.relativePath}`;
      const contentBase64 = Buffer.from(file.content).toString('base64');

      const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
      const url = `${GITCODE_API_BASE}/repos/${targetRepo}/contents/${encodedPath}?access_token=${encodeURIComponent(token)}`;

      // Check if file exists (to decide POST vs PUT)
      let existingSha: string | undefined;
      try {
        const existingFile = await gitcodeApiFetch(
          `/repos/${targetRepo}/contents/${encodedPath}?ref=${encodeURIComponent(branchName)}`,
          { token },
        );
        if (existingFile?.sha) {
          existingSha = existingFile.sha;
        }
      } catch {
        // File doesn't exist, use POST
      }

      const body: Record<string, string> = {
        access_token: token,
        message: `Add ${file.relativePath}`,
        content: contentBase64,
        branch: branchName,
      };
      if (existingSha) {
        body.sha = existingSha;
      }

      // POST for new files, PUT for updates
      const method = existingSha ? 'PUT' : 'POST';
      const putResp = await gitcodeFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (putResp.ok) {
        commitSuccess++;
      } else {
        const errText = await putResp.text();
        commitErrors.push(`${filePath} (${method}): ${errText.slice(0, 150)}`);
      }
    }

    if (commitSuccess === 0) {
      return { success: false, error: `All files failed. First: ${commitErrors[0]}` };
    }

    // Create MR via GitCode API (non-fatal: if MR fails but files committed, still return success)
    const mrTitle = `Add skill: ${skillId}`;
    const partialNote =
      commitErrors.length > 0 ? `\n\n⚠️ ${commitErrors.length} file(s) failed to upload.` : '';
    const mrBody = `## New Skill: ${skillId}\n\nThis MR adds a new skill submitted via AICO-Bot.\n\nFiles uploaded: ${commitSuccess}/${files.length}${partialNote}\n\n---\n*Submitted by @${username}*`;
    const head = targetRepo === mrTargetRepo ? branchName : `${username}:${branchName}`;

    const commitWarning =
      commitErrors.length > 0
        ? `${commitErrors.length} file(s) failed: ${commitErrors.slice(0, 3).join('; ')}`
        : undefined;
    const branchUrl = `https://gitcode.com/${targetRepo}/tree/${branchName}`;

    let mrUrl: string | undefined;
    const mrWarnings: string[] = commitWarning ? [commitWarning] : [];

    try {
      const mrResp = await gitcodeFetch(
        `${GITCODE_API_BASE}/repos/${mrTargetRepo}/pulls?access_token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: mrTitle,
            body: mrBody,
            head: head,
            base: baseBranch,
          }),
        },
      );

      if (!mrResp.ok) {
        const errText = await mrResp.text();
        console.warn(`[GitCodeSkillSource] MR creation failed: ${mrResp.status} ${errText}`);
        mrWarnings.push(
          `MR creation failed (${mrResp.status}). Files committed to branch: ${branchUrl}`,
        );
      } else {
        const mrData = await mrResp.json();
        mrUrl = mrData.html_url || mrData.web_url || mrData.url;
        if (!mrUrl) {
          const mrNumber = mrData.number || mrData.iid;
          if (mrNumber) {
            mrUrl = `https://gitcode.com/${mrTargetRepo}/pulls/${mrNumber}`;
          } else {
            console.warn(`[GitCodeSkillSource] MR response has no URL fields:`, mrData);
            mrWarnings.push(`MR created but no URL returned. Branch: ${branchUrl}`);
          }
        }
      }
    } catch (mrError: any) {
      console.warn(`[GitCodeSkillSource] MR creation error: ${mrError.message}`);
      mrWarnings.push(
        `MR creation error: ${mrError.message}. Files committed to branch: ${branchUrl}`,
      );
    }

    // If files were committed, always return success (MR creation is non-fatal)
    if (commitSuccess > 0) {
      const fallbackUrl = mrUrl || branchUrl;
      const warning = mrWarnings.length > 0 ? mrWarnings.join('. ') : undefined;
      return { success: true, mrUrl: fallbackUrl, warning };
    }
  } catch (error: any) {
    console.error('[GitCodeSkillSource] pushSkillAsMR error:', error);
    return {
      success: false,
      error: error.message || 'Failed to push skill to GitCode.',
    };
  }
}

/**
 * Read all local skill files (shared, not GitCode-specific).
 */
export { readLocalSkillContent, readLocalSkillFiles } from './github-skill-source.service';
