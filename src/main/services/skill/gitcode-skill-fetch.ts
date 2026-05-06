/**
 * GitCode Skill Source - Skill Fetching
 *
 * Skill discovery, directory listing, metadata fetching from GitCode repos.
 */

import { parse as parseYaml } from 'yaml';
import { gitcodeApiFetch, _rateLimiter, incrementRequestCount, withConcurrency, gitcodeFetch, GITCODE_API_BASE } from './gitcode-api';
import type { RemoteSkillItem } from '../../../shared/skill/skill-types';

// ── Progress callback ─────────────────────────────────────────────

export interface SkillFetchProgress {
  phase: 'scanning' | 'fetching-metadata' | 'done';
  current: number;
  total: number;
}

export type SkillFetchProgressCallback = (progress: SkillFetchProgress) => void;

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

// ── Contents-based skill directory finder ──────────────────────────

/**
 * Find skill directories in a GitCode repository.
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

  const rootData = await gitcodeApiFetch(`/repos/${repo}/contents`, { token });
  if (!Array.isArray(rootData)) return [];

  const rootDirs = rootData.filter(
    (item: any) => item.type === 'dir' && !item.name.startsWith('.'),
  );
  if (rootDirs.length === 0) return [];

  const dirChecks = await Promise.all(
    rootDirs.map((dir: any) =>
      withConcurrency(async () => {
        const dirContent = await gitcodeApiFetch(`/repos/${repo}/contents/${dir.name}`, { token });
        return { dirName: dir.name, content: dirContent };
      }),
    ),
  );

  for (const { dirName, content: dirContent } of dirChecks) {
    if (!Array.isArray(dirContent)) continue;

    const hasSkillFile = dirContent.some((item: any) =>
      skillFileNames.has(item.name.toUpperCase()),
    );
    const childDirs = dirContent.filter(
      (item: any) => item.type === 'dir' && !item.name.startsWith('.'),
    );

    if (hasSkillFile) {
      addResult(dirName);
    } else if (childDirs.length > 0) {
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

  const skillsSkills = results.filter((r) => r.path.startsWith('skills/'));
  if (skillsSkills.length > 0) return skillsSkills;
  return results;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Fetch single file content from GitCode repo.
 */
export async function fetchSkillFileContent(
  repo: string,
  filePath: string,
  token?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    await _rateLimiter.acquire();
    incrementRequestCount();
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
    }
    return results;
  }

  if (!Array.isArray(data)) {
    return results;
  }

  const filesToFetch = data.filter((item: any) => item.type === 'file' && !item.content);
  const dirsToTraverse = data.filter(
    (item: any) => item.type === 'dir' && !item.name.startsWith('.'),
  );

  for (const item of data) {
    if (item.type === 'file' && item.content) {
      const decoded = Buffer.from(item.content, 'base64').toString('utf-8');
      results.push({ path: item.name, content: decoded });
    }
  }

  if (signal?.aborted) return results;

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

  if (signal?.aborted) return results;

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
 */
export async function findSkillDirectoryPath(
  repo: string,
  skillName: string,
  token?: string,
): Promise<string | null> {
  const normalizedTarget = skillName.toLowerCase();
  const lastSegment = skillName.split('/').pop() || skillName;
  const normalizedLast = lastSegment.toLowerCase();

  try {
    const allSkillDirs = await findSkillDirsViaContents(repo, token);
    const exact = allSkillDirs.find(
      (d) =>
        d.path.toLowerCase() === normalizedTarget ||
        d.path.toLowerCase().endsWith(`/${normalizedTarget}`),
    );
    if (exact) return exact.path;
    const byLast = allSkillDirs.find(
      (d) => d.path.split('/').pop()!.toLowerCase() === normalizedLast,
    );
    if (byLast) return byLast.path;
  } catch {
    // tree API failed, fall through
  }

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

export type SkillFoundCallback = (skill: RemoteSkillItem, totalFound: number) => void;

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
 * Streaming variant: fetches skills one-by-one.
 */
export async function listSkillsFromRepoStreaming(
  repo: string,
  token?: string,
  onProgress?: SkillFetchProgressCallback,
  onSkillFound?: SkillFoundCallback,
): Promise<RemoteSkillItem[]> {
  return listSkillsFromRepoImpl(repo, token, onProgress, onSkillFound);
}

async function listSkillsFromRepoImpl(
  repo: string,
  token: string | undefined,
  onProgress?: SkillFetchProgressCallback,
  onSkillFound?: SkillFoundCallback,
): Promise<RemoteSkillItem[]> {
  const skills: RemoteSkillItem[] = [];
  const sourceId = `gitcode:${repo}`;

  const skillDirs = await findSkillDirsViaContents(repo, token);
  onProgress?.({ phase: 'scanning', current: skillDirs.length, total: skillDirs.length });

  const totalToFetch = skillDirs.length;
  let metadataFetched = 0;

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

  const results = await Promise.allSettled(
    contentPaths.map((p) => fetchSkillFileContent(repo, p, token)),
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
