/**
 * GitHub Skill Source - Skill Fetching
 *
 * Skill discovery, directory listing, metadata fetching from GitHub repos.
 */

import { parse as parseYaml } from 'yaml';
import { getGitHubToken, githubApiFetch, githubFetch, GITHUB_API_BASE } from './github-api';
import type { RemoteSkillItem } from '../../../shared/skill/skill-types';

// ── Progress callback ─────────────────────────────────────────────

export interface GitHubSkillFetchProgress {
  phase: 'scanning' | 'fetching-metadata';
  current: number;
  total: number;
}

export type GitHubSkillFetchProgressCallback = (progress: GitHubSkillFetchProgress) => void;

export type GitHubSkillFoundCallback = (skill: RemoteSkillItem, totalFound: number) => void;

// ── Frontmatter parsing ──────────────────────────────────────────

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

// ── Public API ────────────────────────────────────────────────────

/**
 * List subdirectories in a GitHub repo.
 */
export async function listRepoDirectories(repo: string, basePath?: string): Promise<string[]> {
  const token = getGitHubToken();
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
 */
export async function fetchSkillFileContent(
  repo: string,
  path: string,
  token?: string,
): Promise<string | null> {
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

  for (const branch of ['main', 'master']) {
    const url = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    try {
      const resp = await githubFetch(url, { headers });
      if (resp.ok) return await resp.text();
    } catch {
      // continue
    }
  }

  return null;
}

/**
 * Recursively download all files in a GitHub directory.
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

  if (data && !Array.isArray(data)) {
    if (data.content) {
      const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
      results.push({ path: data.name, content: decoded });
    }
    return results;
  }

  if (!Array.isArray(data)) return results;

  for (const item of data) {
    if (item.type === 'file') {
      if (item.content) {
        const decoded = Buffer.from(item.content, 'base64').toString('utf-8');
        results.push({ path: item.name, content: decoded });
      } else {
        const content = await fetchSkillFileContent(repo, item.path, token);
        if (content !== null) {
          results.push({ path: item.name, content });
        }
      }
    } else if (item.type === 'dir' && !item.name.startsWith('.')) {
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
 * Find the skill directory path on GitHub.
 */
export async function findSkillDirectoryPath(
  repo: string,
  skillName: string,
  token?: string,
): Promise<string | null> {
  const lastSegment = skillName.split('/').pop() || skillName;
  const dirVariants = [skillName, `skills/${skillName}`, lastSegment];

  const skillFileNames = ['SKILL.md', 'SKILL.yaml'];

  for (const dir of dirVariants) {
    const apiPath = `/repos/${repo}/contents/${dir.replace(/\/$/, '')}`;
    try {
      const data = await githubApiFetch(apiPath, { token });
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
      // directory doesn't exist, try next variant
    }
  }
  return null;
}

/**
 * Recursively find all skill directories in a GitHub repo path.
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
    const dirName = path === '/' ? '' : path.replace(/\/$/, '').split('/').pop()!;
    results.push({ path: path.replace(/\/$/, ''), name: dirName });
    return results;
  }

  const tracker = scanned || { count: 0, total: dirs.length };

  let foundCategory = false;

  await Promise.all(
    dirs.map(async (dir: any) => {
      const subPath = path === '/' ? `${dir.name}/` : `${path}${dir.name}/`;
      if (foundCategory) return [] as Array<{ path: string; name: string }>;
      const sub = await findSkillDirs(repo, subPath, token, maxDepth - 1, undefined, tracker);
      tracker.count++;
      onProgress?.({ phase: 'scanning', current: tracker.count, total: tracker.total });

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
 */
export async function listSkillsFromRepo(
  repo: string,
  token?: string,
  onProgress?: GitHubSkillFetchProgressCallback,
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

      const skillDirs = await findSkillDirs(repo, basePath, token, 5, onProgress);

      const metadataResults = await Promise.all(
        skillDirs.map(async ({ path: skillPath, name }) => {
          if (seenPaths.has(skillPath)) return null;
          seenPaths.add(skillPath);

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

      if (skills.length > 0 && basePath === 'skills/') break;
    } catch (error) {
      console.error(`[GitHubSkillSource] Error listing ${repo}/${basePath}:`, error);
    }
  }

  return skills;
}

/**
 * Streaming variant of listSkillsFromRepo.
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
  const skillId = skillPath.toLowerCase().replace(/\s+/g, '-');

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
