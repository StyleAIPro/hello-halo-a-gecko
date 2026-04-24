/**
 * GitHub Skill Source Service
 *
 * Provides read/write operations for skill repositories on GitHub.
 * Uses GitHub REST API for listing/fetching, and gh CLI for PR creation.
 * Reuses authentication from github-auth.service.ts.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { getAgentsSkillsDir } from '../config.service';
import type { RemoteSkillItem } from '../../../shared/skill/skill-types';

const execAsync = promisify(exec);

/**
 * Resolve the bundled gh CLI binary path.
 * Mirrors the logic in github-auth.service.ts.
 */
function getGhBin(): string {
  try {
    const os = require('os');
    const { app } = require('electron');
    const platform = os.platform();
    const arch = os.arch();

    let platformDir: string;
    if (platform === 'darwin') {
      platformDir = arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
    } else if (platform === 'win32') {
      platformDir = 'win-x64';
    } else if (platform === 'linux') {
      platformDir = 'linux-x64';
    } else {
      return 'gh';
    }

    const binaryName = platform === 'win32' ? 'gh.exe' : 'gh';
    let binPath = join(app.getAppPath(), 'resources', 'gh', platformDir, binaryName);
    if (binPath.includes('app.asar')) {
      binPath = binPath.replace('app.asar', 'app.asar.unpacked');
    }
    if (existsSync(binPath)) {
      return binPath;
    }
  } catch {
    // Electron not available
  }
  return 'gh';
}

// ── GitHub API helpers ────────────────────────────────────────────────

interface GitHubApiOptions {
  token?: string;
}

async function githubApiFetch(path: string, options?: GitHubApiOptions): Promise<any> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'AICO-Bot',
  };
  if (options?.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  const response = await fetch(`https://api.github.com${path}`, { headers });

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

/**
 * List subdirectories in a GitHub repo.
 * If no basePath is given, lists root-level directories.
 * Used to populate the directory picker when pushing skills.
 */
export async function listRepoDirectories(repo: string, basePath?: string): Promise<string[]> {
  const token = await getGitHubToken();
  try {
    const apiPath = basePath ? `/repos/${repo}/contents/${basePath}` : `/repos/${repo}/contents`;
    console.log(`[GitHubSkillSource] listRepoDirectories: ${apiPath}`);
    const data = await githubApiFetch(apiPath, { token });
    console.log(
      `[GitHubSkillSource] listRepoDirectories response type: ${typeof data}, isArray: ${Array.isArray(data)}`,
    );
    if (!Array.isArray(data)) {
      console.warn(
        `[GitHubSkillSource] listRepoDirectories unexpected response:`,
        JSON.stringify(data).slice(0, 200),
      );
      return [];
    }
    const dirs = data.filter((item: any) => item.type === 'dir').map((item: any) => item.name);
    console.log(`[GitHubSkillSource] Found dirs:`, dirs);
    return dirs;
  } catch (error: any) {
    console.error(`[GitHubSkillSource] listRepoDirectories error:`, error.message);
    return [];
  }
}

/**
 * Fetch a file's text content from a GitHub repo.
 * Uses GitHub Contents API (supports private repos) when token is available,
 * falls back to raw.githubusercontent.com for public repos.
 */
export async function fetchSkillFileContent(
  repo: string,
  path: string,
  token?: string,
): Promise<string | null> {
  // 1. Try GitHub Contents API (supports private repos)
  if (token) {
    try {
      const data = await githubApiFetch(
        `/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`,
        { token },
      );
      if (data && data.content && !Array.isArray(data)) {
        return Buffer.from(data.content, 'base64').toString('utf-8');
      }
    } catch {
      // fall through to raw URL
    }
  }

  // 2. Fallback: raw URL (public repos, or private with token in header)
  for (const branch of ['main', 'master']) {
    const url = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    try {
      const resp = await fetch(url, { headers });
      if (resp.ok) return await resp.text();
    } catch {
      // continue
    }
  }

  return null;
}

/**
 * Recursively download all files in a GitHub directory.
 * Returns a flat array of { path (relative to dirPath), content } pairs.
 * For private repos, token is required.
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
    data = await githubApiFetch(apiPath, { token });
  } catch {
    return results;
  }

  // Single file returned (path pointed to a file, not a directory)
  if (data && !Array.isArray(data)) {
    if (data.content) {
      const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
      results.push({ path: data.name, content: decoded });
    }
    return results;
  }

  if (!Array.isArray(data)) return results;

  // Directory listing — process files and recurse into subdirectories
  for (const item of data) {
    if (item.type === 'file') {
      // Fetch file content
      if (item.content) {
        // Content is inline in the listing response (for small files)
        const decoded = Buffer.from(item.content, 'base64').toString('utf-8');
        results.push({ path: item.name, content: decoded });
      } else {
        // Larger files need a separate fetch
        const content = await fetchSkillFileContent(repo, item.path, token);
        if (content !== null) {
          results.push({ path: item.name, content });
        }
      }
    } else if (item.type === 'dir' && !item.name.startsWith('.')) {
      // Recurse into subdirectories
      const subPath = `${dirPath.replace(/\/$/, '')}/${item.name}`;
      const subFiles = await fetchSkillDirectoryContents(repo, subPath, token);
      for (const sub of subFiles) {
        results.push({ path: `${item.name}/${sub.path}`, content: sub.content });
      }
    }
  }

  return results;
}

/**
 * Find the skill directory path on GitHub by checking which path variant
 * contains a SKILL.md or SKILL.yaml file. Returns the directory path or null.
 */
export async function findSkillDirectoryPath(
  repo: string,
  skillName: string,
  token?: string,
): Promise<string | null> {
  const lastSegment = skillName.split('/').pop() || skillName;
  // Directory path variants to try (without the filename)
  const dirVariants = [skillName, `skills/${skillName}`, lastSegment];

  const skillFileNames = ['SKILL.md', 'SKILL.yaml'];

  for (const dir of dirVariants) {
    const apiPath = `/repos/${repo}/contents/${dir.replace(/\/$/, '')}`;
    try {
      const data = await githubApiFetch(apiPath, { token });
      if (Array.isArray(data)) {
        // Check case-insensitively for SKILL.md or SKILL.yaml
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
      // directory doesn't exist, try next variant
    }
  }
  return null;
}

/**
 * Get GitHub token from gh CLI if authenticated.
 */
export async function getGitHubToken(): Promise<string | undefined> {
  try {
    const ghBin = getGhBin();
    const { stdout } = await execAsync(`"${ghBin}" auth token`, { timeout: 10_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

// ── Progress callback ──────────────────────────────────────────────

export interface GitHubSkillFetchProgress {
  phase: 'scanning' | 'fetching-metadata';
  current: number;
  total: number;
}

export type GitHubSkillFetchProgressCallback = (progress: GitHubSkillFetchProgress) => void;

export type GitHubSkillFoundCallback = (skill: RemoteSkillItem, totalFound: number) => void;

// ── Frontmatter parsing ──────────────────────────────────────────────

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

// ── Public API ───────────────────────────────────────────────────────

/**
 * Recursively find all skill directories in a GitHub repo path.
 * A directory is considered a skill if it contains a SKILL.md file.
 * Directories without SKILL.md are recursively searched for nested skills.
 */
async function findSkillDirs(
  repo: string,
  path: string,
  token?: string,
  maxDepth: number = 5,
  onProgress?: GitHubSkillFetchProgressCallback,
  scanned?: { count: number; total: number },
): Promise<Array<{ path: string; name: string }>> {
  if (maxDepth <= 0) return [];

  const apiPath =
    path === '/' ? `/repos/${repo}/contents` : `/repos/${repo}/contents/${path.replace(/\/$/, '')}`;

  let data: any[];
  try {
    const result = await githubApiFetch(apiPath, { token });
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
    // Current directory is a skill
    const dirName = path === '/' ? '' : path.replace(/\/$/, '').split('/').pop()!;
    results.push({ path: path.replace(/\/$/, ''), name: dirName });
    return results; // Don't recurse into a skill directory
  }

  // Track scanning progress
  const tracker = scanned || { count: 0, total: dirs.length };

  // Short-circuit optimization: once any child directory is confirmed to contain
  // SKILL.md, treat the current directory as a "skill category" (equivalent to
  // skills/) and promote ALL remaining sibling directories as skill candidates.
  // This avoids N-1 additional recursive API calls for category-based repos.
  let foundCategory = false;

  // Not a skill directory — recurse into subdirectories (in parallel)
  await Promise.all(
    dirs.map(async (dir: any) => {
      const subPath = path === '/' ? `${dir.name}/` : `${path}${dir.name}/`;
      // Check foundCategory after awaiting — by the time we get here,
      // other callbacks may have already set foundCategory
      if (foundCategory) return [] as Array<{ path: string; name: string }>;
      const sub = await findSkillDirs(repo, subPath, token, maxDepth - 1, undefined, tracker);
      tracker.count++;
      onProgress?.({ phase: 'scanning', current: tracker.count, total: tracker.total });

      // If this child is a skill (has SKILL.md), promote all siblings as candidates
      if (sub.length > 0 && !foundCategory) {
        foundCategory = true;
        results.push(...sub);
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

/**
 * List all skills in a GitHub repository.
 * Recursively searches for directories containing SKILL.md,
 * starting from `skills/` subdirectory and root.
 */
export async function listSkillsFromRepo(
  repo: string,
  token?: string,
  onProgress?: GitHubSkillFetchProgressCallback,
): Promise<RemoteSkillItem[]> {
  const skills: RemoteSkillItem[] = [];
  const sourceId = `github:${repo}`;
  const seenPaths = new Set<string>();

  // Try skills/ first, then root
  const pathsToCheck = ['skills/', '/'];

  for (const basePath of pathsToCheck) {
    try {
      onProgress?.({ phase: 'scanning', current: 0, total: 0 });

      // Quick check: does this path exist?
      const apiPath =
        basePath === '/'
          ? `/repos/${repo}/contents`
          : `/repos/${repo}/contents/${basePath.replace(/\/$/, '')}`;
      const probe = await githubApiFetch(apiPath, { token });
      if (!Array.isArray(probe)) continue;

      // Recursively find all directories with SKILL.md
      const skillDirs = await findSkillDirs(repo, basePath, token, 5, onProgress);

      // Fetch metadata for all skills in parallel (GitHub has no rate limit)
      const metadataResults = await Promise.all(
        skillDirs.map(async ({ path: skillPath, name }) => {
          if (seenPaths.has(skillPath)) return null;
          seenPaths.add(skillPath);

          let frontmatter: SkillFrontmatter = {};
          let description = '';

          // Try fetching SKILL.md content for metadata
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
          // Use full path as skill ID to support nested directory structures
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
        }),
      );

      for (const item of metadataResults) {
        if (item) skills.push(item);
      }

      onProgress?.({
        phase: 'fetching-metadata',
        current: metadataResults.length,
        total: metadataResults.length,
      });

      // If we found skills in skills/ subdirectory, don't check root
      if (skills.length > 0 && basePath === 'skills/') break;
    } catch (error) {
      console.error(`[GitHubSkillSource] Error listing ${repo}/${basePath}:`, error);
    }
  }

  return skills;
}

/**
 * Streaming variant of listSkillsFromRepo: fetches skills one-by-one,
 * calling onSkillFound after each metadata fetch completes.
 */
export async function listSkillsFromRepoStreaming(
  repo: string,
  token?: string,
  onProgress?: GitHubSkillFetchProgressCallback,
  onSkillFound?: GitHubSkillFoundCallback,
): Promise<RemoteSkillItem[]> {
  const skills: RemoteSkillItem[] = [];
  const sourceId = `github:${repo}`;
  const seenPaths = new Set<string>();

  const pathsToCheck = ['skills/', '/'];

  for (const basePath of pathsToCheck) {
    try {
      onProgress?.({ phase: 'scanning', current: 0, total: 0 });

      const apiPath =
        basePath === '/'
          ? `/repos/${repo}/contents`
          : `/repos/${repo}/contents/${basePath.replace(/\/$/, '')}`;
      const probe = await githubApiFetch(apiPath, { token });
      if (!Array.isArray(probe)) continue;

      const skillDirs = await findSkillDirs(repo, basePath, token);

      let metadataFetched = 0;
      const totalToFetch = skillDirs.length;

      for (const { path: skillPath, name } of skillDirs) {
        if (seenPaths.has(skillPath)) continue;
        seenPaths.add(skillPath);

        try {
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

          metadataFetched++;
          onProgress?.({
            phase: 'fetching-metadata',
            current: metadataFetched,
            total: totalToFetch,
          });

          const skillName = frontmatter.name || name;
          const skillId = skillPath.toLowerCase().replace(/\s+/g, '-');

          const item = {
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

          skills.push(item);
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
      console.error(`[GitHubSkillSource] Error listing ${repo}/${basePath}:`, error);
    }
  }

  return skills;
}

/**
 * Get detailed skill content from a GitHub repo.
 */
export async function getSkillDetailFromRepo(
  repo: string,
  skillPath: string,
  token?: string,
): Promise<RemoteSkillItem | null> {
  const skillName = skillPath.split('/').pop() || skillPath;
  const sourceId = `github:${repo}`;
  // Use full path as skill ID to match listSkillsFromRepo
  const skillId = skillPath.toLowerCase().replace(/\s+/g, '-');

  // Try multiple content paths
  const contentPaths = [
    `${skillPath}/SKILL.md`,
    `${skillPath}/SKILL.yaml`,
    `${skillPath}/README.md`,
  ];

  for (const contentPath of contentPaths) {
    try {
      const content = await fetchSkillFileContent(repo, contentPath, token);
      if (!content) continue;

      const { frontmatter, body } = parseFrontmatter(content);

      const description =
        frontmatter.description ||
        body
          .split('\n')
          .filter((l) => l.trim() && !l.startsWith('#'))
          .slice(0, 3)
          .join(' ');

      return {
        id: `${sourceId}:${skillId}`,
        name: frontmatter.name ? formatSkillName(frontmatter.name) : formatSkillName(skillName),
        description: description || `Skill from ${repo}`,
        fullDescription: body,
        version: frontmatter.version || '1.0.0',
        author: frontmatter.author || repo.split('/')[0],
        tags: frontmatter.tags || [],
        lastUpdated: new Date().toISOString(),
        sourceId,
        remoteRepo: repo,
        remotePath: skillPath,
        skillContent: content,
      };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Validate that a GitHub repo exists and contains skills (directories with SKILL.md).
 * Uses lightweight probing instead of full scan to avoid slow recursive traversal.
 */
export async function validateRepo(
  repo: string,
  token?: string,
): Promise<{ valid: boolean; hasSkillsDir: boolean; skillCount: number; error?: string }> {
  try {
    // Check repo exists
    const repoData = await githubApiFetch(`/repos/${repo}`, { token });
    if (!repoData) {
      return {
        valid: false,
        hasSkillsDir: false,
        skillCount: 0,
        error: 'Repository not found or is private',
      };
    }

    // Check if skills/ directory exists (fast path)
    const skillsProbe = await githubApiFetch(`/repos/${repo}/contents/skills`, { token });
    if (Array.isArray(skillsProbe)) {
      const skillDirs = skillsProbe.filter(
        (item: any) => item.type === 'dir' && !item.name.startsWith('.'),
      );
      return { valid: true, hasSkillsDir: true, skillCount: skillDirs.length };
    }

    // No skills/ directory — sample root directories to detect category structure
    const rootContents = await githubApiFetch(`/repos/${repo}/contents`, { token });
    if (!Array.isArray(rootContents)) {
      return {
        valid: true,
        hasSkillsDir: false,
        skillCount: 0,
        error: 'Could not list repository contents',
      };
    }

    const rootDirs = rootContents.filter(
      (item: any) => item.type === 'dir' && !item.name.startsWith('.'),
    );
    if (rootDirs.length === 0) {
      return { valid: true, hasSkillsDir: false, skillCount: 0, error: 'No directories found' };
    }

    // Sample up to 3 root directories
    const sampleDirs = rootDirs.slice(0, 3);
    let totalSkillCount = 0;
    let foundAny = false;

    for (const dir of sampleDirs) {
      const children = await githubApiFetch(`/repos/${repo}/contents/${dir.name}`, { token });
      if (!Array.isArray(children)) continue;

      const childDirs = children.filter(
        (item: any) => item.type === 'dir' && !item.name.startsWith('.'),
      );
      if (childDirs.length > 0) {
        const probe = await githubApiFetch(
          `/repos/${repo}/contents/${dir.name}/${childDirs[0].name}`,
          { token },
        );
        if (Array.isArray(probe) && probe.some((f: any) => f.name.toUpperCase() === 'SKILL.MD')) {
          foundAny = true;
          totalSkillCount += childDirs.length;
        }
      }
    }

    if (foundAny && sampleDirs.length < rootDirs.length) {
      const avgPerDir = totalSkillCount / sampleDirs.length;
      totalSkillCount = Math.round(avgPerDir * rootDirs.length);
    }

    if (totalSkillCount === 0) {
      return {
        valid: true,
        hasSkillsDir: false,
        skillCount: 0,
        error: 'No skills found in this repository',
      };
    }

    return { valid: true, hasSkillsDir: false, skillCount: totalSkillCount };
  } catch (error: any) {
    return {
      valid: false,
      hasSkillsDir: false,
      skillCount: 0,
      error: error.message || 'Failed to validate repository',
    };
  }
}

/**
 * Push a local skill to a GitHub repo via PR.
 *
 * Flow:
 * 1. If the target repo is a fork → push to fork, PR to upstream parent
 * 2. If the user is a collaborator → push directly, PR in same repo
 * 3. Otherwise → fork the repo, push to fork, PR from fork to original
 */
export async function pushSkillAsPR(
  repo: string,
  skillId: string,
  files: Array<{ relativePath: string; content: string }>,
  targetPath?: string,
  token?: string,
): Promise<{ success: boolean; prUrl?: string; error?: string }> {
  const ghBin = getGhBin();

  try {
    // Get current GitHub username
    const { stdout: userJson } = await execAsync(`"${ghBin}" api user --jq ".login"`, {
      timeout: 15_000,
    });
    const username = userJson.trim();
    if (!username) {
      return { success: false, error: 'Not authenticated. Please login with gh CLI first.' };
    }

    const branchName = `skill/${skillId}-${Date.now()}`;

    // Determine where to push and where to create PR
    let targetRepo = repo; // repo to push the branch to
    let prTargetRepo = repo; // repo to create the PR against
    let headBranch = branchName;

    // Check if the target repo is a fork
    try {
      const { stdout: isFork } = await execAsync(`"${ghBin}" api /repos/${repo} --jq ".fork"`, {
        timeout: 10_000,
      });
      if (isFork.trim() === 'true') {
        const { stdout: parentRepo } = await execAsync(
          `"${ghBin}" api /repos/${repo} --jq ".parent.full_name"`,
          { timeout: 10_000 },
        );
        const parent = parentRepo.trim();
        if (parent) {
          console.log(`[GitHubSkillSource] ${repo} is a fork of ${parent}`);
          targetRepo = repo;
          prTargetRepo = parent;
          headBranch = branchName;
        }
      }
    } catch {
      // Cannot determine fork status, continue with default behavior
    }

    // If not a fork, check collaborator status
    if (targetRepo === repo && prTargetRepo === repo) {
      try {
        await execAsync(`"${ghBin}" api /repos/${repo}/collaborators/${username} --jq ".login"`, {
          timeout: 10_000,
        });
        // User is a collaborator, push directly to the repo
      } catch {
        // Not a collaborator, need to fork
        console.log(`[GitHubSkillSource] Forking ${repo}...`);
        try {
          await execAsync(`"${ghBin}" repo fork ${repo} --clone=false`, { timeout: 30_000 });
        } catch (forkError: any) {
          // Fork may already exist, that's fine
          if (!forkError.message?.includes('already')) {
            console.warn('[GitHubSkillSource] Fork warning:', forkError.message);
          }
        }
        targetRepo = `${username}/${repo.split('/')[1]}`;
        headBranch = branchName;
      }
    }

    // Get the default branch SHA to create branch from (try main, then master)
    console.log(`[GitHubSkillSource] Getting base SHA from ${targetRepo}...`);
    let baseSha = '';
    let baseBranch = 'main';
    try {
      const { stdout: refData } = await execAsync(
        `"${ghBin}" api /repos/${targetRepo}/git/refs/heads/main --jq ".object.sha"`,
        { timeout: 10_000 },
      );
      baseSha = refData.trim();
    } catch {
      // Fallback to master
      baseBranch = 'master';
      try {
        const { stdout: refData } = await execAsync(
          `"${ghBin}" api /repos/${targetRepo}/git/refs/heads/master --jq ".object.sha"`,
          { timeout: 10_000 },
        );
        baseSha = refData.trim();
      } catch (innerErr: any) {
        throw new Error(
          `Failed to resolve base branch. Tried 'main' and 'master'. ${innerErr.stderr?.trim() || innerErr.message}`,
          { cause: innerErr },
        );
      }
    }
    console.log(`[GitHubSkillSource] Base SHA: ${baseSha} (branch: ${baseBranch})`);

    // Create a new branch
    console.log(`[GitHubSkillSource] Creating branch ${branchName} on ${targetRepo}...`);
    await execAsync(
      `"${ghBin}" api /repos/${targetRepo}/git/refs -f ref=refs/heads/${branchName} -f sha=${baseSha}`,
      { timeout: 10_000 },
    );

    // Commit all files via GitHub Contents API using fetch (avoids Windows command line length limit)
    console.log(
      `[GitHubSkillSource] Committing ${files.length} file(s) to ${targetRepo}:${branchName}...`,
    );
    const commitErrors: string[] = [];
    let commitSuccess = 0;
    for (const file of files) {
      const filePath = targetPath
        ? `${targetPath}/${skillId}/${file.relativePath}`
        : `${skillId}/${file.relativePath}`;
      const contentBase64 = Buffer.from(file.content).toString('base64');
      console.log(`[GitHubSkillSource]   Committing ${filePath}`);

      const putUrl = `https://api.github.com/repos/${targetRepo}/contents/${filePath}`;
      const putResp = await fetch(putUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'AICO-Bot',
        },
        body: JSON.stringify({
          message: `Add ${file.relativePath}`,
          content: contentBase64,
          branch: branchName,
        }),
      });

      if (putResp.ok) {
        commitSuccess++;
      } else {
        const errText = await putResp.text();
        commitErrors.push(`${filePath}: ${errText.slice(0, 150)}`);
      }
    }

    if (commitSuccess === 0) {
      return { success: false, error: `All files failed to commit. First: ${commitErrors[0]}` };
    }

    // Create PR via GitHub API (avoids shell escaping issues with multiline body)
    const prTitle = `Add skill: ${skillId}`;
    const prBody = `## New Skill: ${skillId}\n\nThis PR adds a new skill submitted via AICO-Bot.\n\nFiles included: ${commitSuccess}/${files.length}\n\n---\n*Submitted by @${username}*`;

    const head = targetRepo === prTargetRepo ? branchName : `${username}:${branchName}`;

    console.log(`[GitHubSkillSource] Creating PR: ${prTargetRepo} <- ${head}`);
    const branchUrl = `https://github.com/${targetRepo}/tree/${branchName}`;
    const warnings: string[] = [];

    if (commitErrors.length > 0) {
      warnings.push(`${commitErrors.length} file(s) failed to commit`);
    }

    let prUrl = branchUrl;
    try {
      const prResp = await fetch(`https://api.github.com/repos/${prTargetRepo}/pulls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'AICO-Bot',
        },
        body: JSON.stringify({
          title: prTitle,
          body: prBody,
          head: head,
          base: baseBranch,
        }),
      });

      if (prResp.ok) {
        const prData = await prResp.json();
        prUrl = prData.html_url || prData.url;
      } else {
        const errText = await prResp.text();
        warnings.push(`PR creation failed. Files committed to branch: ${branchUrl}`);
        console.warn(`[GitHubSkillSource] PR creation failed: ${prResp.status} ${errText}`);
      }
    } catch (prError: any) {
      warnings.push(
        `PR creation error: ${prError.message}. Files committed to branch: ${branchUrl}`,
      );
    }

    const warning = warnings.length > 0 ? warnings.join('. ') : undefined;
    return { success: true, prUrl, warning };
  } catch (error: any) {
    console.error('[GitHubSkillSource] pushSkillAsPR error:', error);
    console.error('[GitHubSkillSource] error details:', {
      message: error.message,
      stderr: error.stderr,
      stdout: error.stdout,
      cmd: error.cmd,
    });
    const detail = error.stderr?.trim() || error.stdout?.trim() || error.message || '';
    return {
      success: false,
      error: detail || 'Failed to create PR. Make sure you are authenticated with gh CLI.',
    };
  }
}

/**
 * Read a local skill's content from disk.
 */
export async function readLocalSkillContent(
  skillId: string,
): Promise<{ content: string; fileName: string } | null> {
  const skillsDir = getAgentsSkillsDir();
  const skillDir = join(skillsDir, skillId);

  // Try SKILL.md first, then SKILL.yaml
  for (const fileName of ['SKILL.md', 'SKILL.yaml']) {
    const filePath = join(skillDir, fileName);
    if (existsSync(filePath)) {
      try {
        const content = await readFile(filePath, 'utf-8');
        return { content, fileName };
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Read all files in a local skill directory recursively.
 * Returns an array of { relativePath, content } pairs.
 * Skips META.json (local-only), __pycache__, and .pyc files.
 */
export async function readLocalSkillFiles(
  skillId: string,
): Promise<Array<{ relativePath: string; content: string }>> {
  const skillsDir = getAgentsSkillsDir();
  const skillDir = join(skillsDir, skillId);
  const results: Array<{ relativePath: string; content: string }> = [];

  if (!existsSync(skillDir)) return results;

  const { readdir } = await import('fs/promises');
  const { join: pathJoin, relative } = await import('path');

  // Files/dirs to skip
  const skipNames = new Set(['META.json', '__pycache__', '.git']);

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skipNames.has(entry.name) || entry.name.endsWith('.pyc')) continue;

      const fullPath = pathJoin(dir, entry.name);
      const relPath = relative(skillDir, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const content = await readFile(fullPath, 'utf-8');
          results.push({ relativePath: relPath, content });
        } catch {
          // skip files that can't be read as text
        }
      }
    }
  }

  await walk(skillDir);
  return results;
}
