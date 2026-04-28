/**
 * GitCode Skill Source Service
 *
 * Provides read/write operations for skill repositories on GitCode (gitcode.com).
 * Parallel to github-skill-source.service.ts but uses GitCode v5 API.
 * Auth via user-provided Personal Access Token stored in config.
 */

import { parse as parseYaml } from 'yaml';
import { getGitCodeToken } from '../config.service';
import { proxyFetch } from '../proxy';
import type { RemoteSkillItem } from '../../../shared/skill/skill-types';

// ── GitCode API fetch ──────────────────────────────────────────────

interface GitCodeApiOptions {
  token?: string;
}

export const GITCODE_API_BASE = 'https://api.gitcode.com/api/v5';

// ── Global concurrency semaphore ───────────────────────────────────────
// A single shared queue ensures ALL GitCode API calls (including recursive
// findSkillDirs) stay within the concurrency budget. No more per-level pools
// that multiply concurrency at each recursion depth.

const MAX_CONCURRENCY = 8;

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
// GitCode limit: 400 requests/min, 4000 requests/hour per user.
// Strategy: 100ms minimum gap (~5 req/s sustained, ~300 req/min) + 150-token burst budget.

const RATE_LIMIT_MAX_TOKENS = 150;
const RATE_LIMIT_MIN_INTERVAL_MS = 100; // ~10 req/s sustained
const RATE_LIMIT_REFILL_INTERVAL_MS = 1000; // 1 token/sec refill

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
    // Enforce minimum interval between consecutive requests
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
 * Rate limiting is handled at the gitcodeApiFetch/gitcodeAuthFetch level
 * to prevent semaphore deadlock from nested calls.
 */
async function withConcurrency<T>(fn: () => Promise<T>): Promise<T> {
  await _apiSemaphore.acquire();
  try {
    return await fn();
  } finally {
    _apiSemaphore.release();
  }
}

/** Default request timeout for GitCode API calls (ms). */
const GITCODE_FETCH_TIMEOUT_MS = 30_000;

/**
 * Proxy-aware fetch for GitCode API with 30s timeout. Exported for reuse by gitcode-auth.service.
 */
export async function gitcodeFetch(url: string, init?: RequestInit): Promise<Response> {
  return proxyFetch(url, init, GITCODE_FETCH_TIMEOUT_MS);
}

/**
 * Authenticated fetch for GitCode write operations.
 * Sends token via private-token header (not URL) for security.
 * Includes rate limiting to stay within API quota.
 */
async function gitcodeAuthFetch(url: string, init: RequestInit, token: string): Promise<Response> {
  await _rateLimiter.acquire();
  _requestCount++;
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) || {}),
    'private-token': token,
  };
  return gitcodeFetch(url, { ...init, headers });
}

async function gitcodeApiFetch(path: string, options?: GitCodeApiOptions): Promise<any> {
  // Rate limit all API calls at the entry point to prevent semaphore deadlock
  // from nested withConcurrency calls in recursive findSkillDirs.
  await _rateLimiter.acquire();
  _requestCount++;
  if (_requestCount % 10 === 0) {
    console.log(`[GitCodeSkillSource] API telemetry: ${_requestCount} requests`);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options?.token) {
    headers['private-token'] = options.token;
  }

  const url = `${GITCODE_API_BASE}${path}`;

  const response = await gitcodeFetch(url, { headers });

  if (response.status === 404) {
    return null;
  }

  // GitCode returns "not found" as HTTP 400 with error_code:404 in body
  // (e.g., branch not found, file not found). Treat same as HTTP 404.
  if (response.status === 400) {
    try {
      const body = await response.clone().json();
      if (body?.error_code === 404) {
        console.debug(`[GitCodeAPI] Resource not found (400/404): ${path}`);
        return null;
      }
    } catch {
      // body not JSON, fall through
    }
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
  phase: 'scanning' | 'fetching-metadata' | 'done';
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

// ── Contents-based skill directory finder ──────────────────────────

/**
 * Find skill directories in a GitCode repository.
 *
 * Uses the contents API (not tree API) because GitCode's tree API with
 * recursive=1 only returns tree entries (directories), NOT blobs (files),
 * making it impossible to detect SKILL.md files.
 *
 * Handles two repo layouts:
 *   1. Category-based: Category/SkillName/SKILL.md  (e.g. Inference/ais-bench/)
 *   2. Flat: SkillName/SKILL.md  (or skills/SkillName/SKILL.md)
 *
 * Strategy:
 *   1. GET /repos/{repo}/contents → root-level dirs
 *   2. For each root dir (parallel): GET /contents/{dir}
 *      - If dir contains SKILL.md → it IS a skill dir (flat layout)
 *      - If dir contains only subdirs → it's a category, promote children as skills
 *   3. Optionally probe one child per category to confirm SKILL.md presence
 */
export async function findSkillDirsViaContents(
  repo: string,
  token?: string,
  basePath?: string,
): Promise<Array<{ path: string; name: string }>> {
  const results: Array<{ path: string; name: string }> = [];
  const seen = new Set<string>();

  const skillFileNames = new Set(['SKILL.MD', 'SKILL.YAML']);
  const addResult = (dirPath: string) => {
    if (seen.has(dirPath.toLowerCase())) return;
    if (basePath && !dirPath.startsWith(basePath.replace(/\/$/, ''))) return;
    seen.add(dirPath.toLowerCase());
    results.push({ path: dirPath, name: dirPath.split('/').pop()! });
  };

  // Step 1: Get root-level contents
  const rootData = await gitcodeApiFetch(`/repos/${repo}/contents`, { token });
  if (!Array.isArray(rootData)) return [];

  const rootDirs = rootData.filter(
    (item: any) => item.type === 'dir' && !item.name.startsWith('.'),
  );
  if (rootDirs.length === 0) return [];

  // Step 2: Check each root dir in parallel (respecting concurrency)
  const dirChecks = await Promise.all(
    rootDirs.map((dir: any) =>
      withConcurrency(async () => {
        const dirContent = await gitcodeApiFetch(`/repos/${repo}/contents/${dir.name}`, { token });
        return { dirName: dir.name, content: dirContent };
      }),
    ),
  );

  // Step 3: Classify each root dir as skill dir or category dir
  for (const { dirName, content: dirContent } of dirChecks) {
    if (!Array.isArray(dirContent)) continue;

    const hasSkillFile = dirContent.some((item: any) =>
      skillFileNames.has(item.name.toUpperCase()),
    );
    const childDirs = dirContent.filter(
      (item: any) => item.type === 'dir' && !item.name.startsWith('.'),
    );

    if (hasSkillFile) {
      // Flat layout: root dir IS a skill dir
      addResult(dirName);
    } else if (childDirs.length > 0) {
      // Category layout: promote all child dirs as skill candidates
      // Probe first child to confirm SKILL.md exists (avoid false positives)
      let confirmed = false;
      try {
        const probe = await gitcodeApiFetch(
          `/repos/${repo}/contents/${dirName}/${childDirs[0].name}`,
          { token },
        );
        if (Array.isArray(probe)) {
          confirmed = probe.some((item: any) => skillFileNames.has(item.name.toUpperCase()));
        }
      } catch {
        // probe failed, still promote children
      }

      if (confirmed) {
        for (const child of childDirs) {
          addResult(`${dirName}/${child.name}`);
        }
      }
    }
  }

  // If there are skills under skills/ base, prefer those over root-level skills
  const skillsSkills = results.filter((r) => r.path.startsWith('skills/'));
  if (skillsSkills.length > 0) return skillsSkills;
  return results;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Fetch single file content from GitCode repo.
 * Uses /raw/{path} endpoint for efficiency (no base64 overhead).
 */
export async function fetchSkillFileContent(
  repo: string,
  filePath: string,
  token?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    await _rateLimiter.acquire();
    _requestCount++;
    const encodedPath = encodeURIComponent(filePath).replace(/%2F/g, '/');
    const headers: Record<string, string> = {};
    if (token) headers['private-token'] = token;

    const url = `${GITCODE_API_BASE}/repos/${repo}/raw/${encodedPath}`;
    console.debug('[GitCodeSkillSource] fetchSkillFileContent:', url);
    const response = await gitcodeFetch(url, {
      headers,
      signal,
    });
    if (response.status === 404) {
      console.debug('[GitCodeSkillSource] fetchSkillFileContent: 404 for', filePath);
      return null;
    }
    if (!response.ok) {
      console.warn('[GitCodeSkillSource] fetchSkillFileContent:', response.status, 'for', filePath);
      return null;
    }
    const text = await response.text();
    console.debug('[GitCodeSkillSource] fetchSkillFileContent: OK', filePath, `(${text.length} chars)`);
    return text;
  } catch (e: any) {
    if (signal?.aborted) return null;
    console.debug('[GitCodeSkillSource] fetchSkillFileContent failed:', filePath, e.message);
    return null;
  }
}

/**
 * Recursively download all files in a GitCode directory.
 */
export async function fetchSkillDirectoryContents(
  repo: string,
  dirPath: string,
  token?: string,
  signal?: AbortSignal,
): Promise<Array<{ path: string; content: string }>> {
  const results: Array<{ path: string; content: string }> = [];
  const apiPath = `/repos/${repo}/contents/${dirPath.replace(/\/$/, '')}`;

  console.log('[GitCodeSkillSource] fetchSkillDirectoryContents:', { repo, dirPath, apiPath });

  let data: any;
  try {
    data = await gitcodeApiFetch(apiPath, { token });
  } catch (e: any) {
    console.warn('[GitCodeSkillSource] fetchSkillDirectoryContents: API call failed:', e.message);
    return results;
  }

  if (data && !Array.isArray(data)) {
    if (data.content) {
      const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
      results.push({ path: data.name, content: decoded });
      console.log('[GitCodeSkillSource] fetchSkillDirectoryContents: single file', data.name);
    }
    return results;
  }

  if (!Array.isArray(data)) {
    console.warn('[GitCodeSkillSource] fetchSkillDirectoryContents: unexpected response type for', apiPath);
    return results;
  }

  console.log(
    '[GitCodeSkillSource] fetchSkillDirectoryContents:',
    apiPath,
    '→',
    data.length,
    'items:',
    data.map((i: any) => `${i.type}:${i.name}`).join(', '),
  );

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

  // Abort early if signal fired
  if (signal?.aborted) return results;

  // Batch fetch files that need separate API calls
  // Note: NOT wrapped in withConcurrency — fetchSkillFileContent has its own
  // rate limiter, and wrapping would deadlock when called from within a
  // withConcurrency-guarded directory traversal (all permits consumed by dirs).
  if (filesToFetch.length > 0) {
    console.log('[GitCodeSkillSource] fetchSkillDirectoryContents: fetching', filesToFetch.length, 'files');
  }
  const fetchResults = await Promise.all(
    filesToFetch.map(async (item: any) => {
      const content = await fetchSkillFileContent(repo, item.path, token, signal);
      if (!content) {
        console.warn('[GitCodeSkillSource] fetchSkillFileContent returned empty for', item.path);
      }
      return { path: item.name, content: content || '' };
    }),
  );
  for (const r of fetchResults) {
    if (r.content) results.push(r);
  }

  // Abort early if signal fired
  if (signal?.aborted) return results;

  // Batch traverse sub-directories
  const dirResults = await Promise.all(
    dirsToTraverse.map(async (item: any) => {
      const subPath = `${dirPath.replace(/\/$/, '')}/${item.name}`;
      return withConcurrency(() => fetchSkillDirectoryContents(repo, subPath, token, signal));
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
 * Find the skill directory path on GitCode.
 * Uses tree API for fast single-call lookup, falls back to contents API.
 */
export async function findSkillDirectoryPath(
  repo: string,
  skillName: string,
  token?: string,
): Promise<string | null> {
  const normalizedTarget = skillName.toLowerCase();
  const lastSegment = skillName.split('/').pop() || skillName;
  const normalizedLast = lastSegment.toLowerCase();

  // Fast path: use tree API to find all skill directories in one call
  try {
    const allSkillDirs = await findSkillDirsViaContents(repo, token);
    // Exact match
    const exact = allSkillDirs.find(
      (d) =>
        d.path.toLowerCase() === normalizedTarget ||
        d.path.toLowerCase().endsWith(`/${normalizedTarget}`),
    );
    if (exact) return exact.path;
    // Last-segment match (for case-insensitive repos)
    const byLast = allSkillDirs.find(
      (d) => d.path.split('/').pop()!.toLowerCase() === normalizedLast,
    );
    if (byLast) return byLast.path;
  } catch {
    // tree API failed, fall through
  }

  // Slow fallback: try exact path matches via contents API
  const skillFileNames = ['SKILL.md', 'SKILL.yaml'];
  const dirVariants = [skillName, `skills/${skillName}`, lastSegment];

  for (const dir of dirVariants) {
    try {
      const apiPath = `/repos/${repo}/contents/${dir.replace(/\/$/, '')}`;
      const data = await gitcodeApiFetch(apiPath, { token });
      if (Array.isArray(data)) {
        const found = data.some(
          (item: any) =>
            item.type === 'file' &&
            skillFileNames.some((sf) => item.name.toUpperCase() === sf.toUpperCase()),
        );
        if (found) return dir.replace(/\/$/, '');
      }
    } catch {
      // continue
    }
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
  } catch (e: any) {
    console.debug('[GitCodeSkillSource] listRepoDirectories failed:', e.message);
    return [];
  }
}

/**
 * Streaming variant callback: called after each skill is found.
 */
export type SkillFoundCallback = (skill: RemoteSkillItem, totalFound: number) => void;

/**
 * Shared implementation for listing skills from a GitCode repository.
 * Uses the tree API for fast, single-call directory discovery.
 * Supports both batch and streaming modes via optional onSkillFound callback.
 */
async function listSkillsFromRepoImpl(
  repo: string,
  token: string | undefined,
  onProgress?: SkillFetchProgressCallback,
  onSkillFound?: SkillFoundCallback,
): Promise<RemoteSkillItem[]> {
  const skills: RemoteSkillItem[] = [];
  const sourceId = `gitcode:${repo}`;

  // Use tree API to find all skill directories in one call
  const skillDirs = await findSkillDirsViaContents(repo, token);
  onProgress?.({ phase: 'scanning', current: skillDirs.length, total: skillDirs.length });

  const totalToFetch = skillDirs.length;
  let metadataFetched = 0;

  // Sequential fetch for smooth progress advancement
  for (const { path: skillPath, name } of skillDirs) {
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
    onSkillFound?.(skills[skills.length - 1], skills.length);
  }

  onProgress?.({ phase: 'done', current: 0, total: 0 });
  return skills;
}

/**
 * List all skills in a GitCode repository.
 */
export async function listSkillsFromRepo(
  repo: string,
  token?: string,
  onProgress?: SkillFetchProgressCallback,
): Promise<RemoteSkillItem[]> {
  return listSkillsFromRepoImpl(repo, token, onProgress, undefined);
}

/**
 * Streaming variant: fetches skills one-by-one, calling onSkillFound after each.
 * Used for progressive loading — frontend renders skills as they arrive.
 */
export async function listSkillsFromRepoStreaming(
  repo: string,
  token?: string,
  onProgress?: SkillFetchProgressCallback,
  onSkillFound?: SkillFoundCallback,
): Promise<RemoteSkillItem[]> {
  return listSkillsFromRepoImpl(repo, token, onProgress, onSkillFound);
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
  console.log('[GitCodeSkillSource] getSkillDetailFromRepo:', { repo, skillPath, contentPaths });

  // Fetch both paths in parallel, prefer SKILL.md over SKILL.yaml
  const results = await Promise.allSettled(
    contentPaths.map((p) => fetchSkillFileContent(repo, p, token)),
  );

  console.log(
    '[GitCodeSkillSource] getSkillDetailFromRepo results:',
    results.map((r, i) => ({
      path: contentPaths[i],
      status: r.status,
      ok: r.status === 'fulfilled' && !!r.value,
    })),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled' && result.value) {
      const contentPath = contentPaths[i];
      const content = result.value;
      const isYaml = contentPath.endsWith('.yaml');
      const parsed = isYaml ? null : parseFrontmatter(content);
      const frontmatter: SkillFrontmatter = isYaml
        ? (parseYaml(content) as SkillFrontmatter) || {}
        : parsed!.frontmatter;
      const description = isYaml
        ? frontmatter.description || ''
        : parsed!.body
            .split('\n')
            .filter((l: string) => l.trim() && !l.startsWith('#'))
            .slice(0, 3)
            .join(' ');

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
          const forkResp = await gitcodeAuthFetch(
            `${GITCODE_API_BASE}/repos/${repo}/forks`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            },
            token,
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
    const branchResp = await gitcodeAuthFetch(
      `${GITCODE_API_BASE}/repos/${targetRepo}/branches`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refs: baseBranch,
          branch_name: branchName,
        }),
      },
      token,
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
      const fileUrl = `${GITCODE_API_BASE}/repos/${targetRepo}/contents/${encodedPath}`;

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
        message: `Add ${file.relativePath}`,
        content: contentBase64,
        branch: branchName,
      };
      if (existingSha) {
        body.sha = existingSha;
      }

      // POST for new files, PUT for updates
      const method = existingSha ? 'PUT' : 'POST';
      const putResp = await gitcodeAuthFetch(
        fileUrl,
        {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        token,
      );

      if (putResp.ok) {
        commitSuccess++;
      } else {
        const errText = await putResp.text();
        commitErrors.push(`${filePath} (${method}): ${errText.slice(0, 150)}`);
      }
    }

    if (commitSuccess === 0) {
      // Clean up orphan branch
      try {
        await gitcodeAuthFetch(
          `${GITCODE_API_BASE}/repos/${targetRepo}/branches/${encodeURIComponent(branchName)}`,
          { method: 'DELETE' },
          token,
        );
        console.warn('[GitCodeSkillSource] Cleaned up orphan branch:', branchName);
      } catch (e: any) {
        console.warn('[GitCodeSkillSource] Branch cleanup failed:', e.message);
      }
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
      const mrResp = await gitcodeAuthFetch(
        `${GITCODE_API_BASE}/repos/${mrTargetRepo}/pulls`,
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
        token,
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
    const fallbackUrl = mrUrl || branchUrl;
    const warning = mrWarnings.length > 0 ? mrWarnings.join('. ') : undefined;
    return { success: commitSuccess > 0, mrUrl: fallbackUrl, warning };
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
