/**
 * GitHub Skill Source - Skill Push, Validation & Local Reading
 *
 * Push skills via PR, validate repositories, and read local skill files.
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { getAgentsSkillsDir } from '../config.service';
import { githubApiFetch, githubFetch, GITHUB_API_BASE } from './github-api';

/**
 * Validate that a GitHub repo exists and contains skills.
 */
export async function validateRepo(
  repo: string,
  token?: string,
): Promise<{ valid: boolean; hasSkillsDir: boolean; skillCount: number; error?: string }> {
  try {
    const repoData = await githubApiFetch(`/repos/${repo}`, { token });
    if (!repoData) {
      return {
        valid: false,
        hasSkillsDir: false,
        skillCount: 0,
        error: 'Repository not found or is private',
      };
    }

    const skillsProbe = await githubApiFetch(`/repos/${repo}/contents/skills`, { token });
    if (Array.isArray(skillsProbe)) {
      const skillDirs = skillsProbe.filter(
        (item: any) => item.type === 'dir' && !item.name.startsWith('.'),
      );
      return { valid: true, hasSkillsDir: true, skillCount: skillDirs.length };
    }

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
 */
export async function pushSkillAsPR(
  repo: string,
  skillId: string,
  files: Array<{ relativePath: string; content: string }>,
  targetPath?: string,
  token?: string,
): Promise<{ success: boolean; prUrl?: string; warning?: string; error?: string }> {
  try {
    const userResp = await githubFetch(`${GITHUB_API_BASE}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!userResp.ok) {
      return { success: false, error: `Authentication failed: ${userResp.status}` };
    }
    const userData = await userResp.json();
    const username = userData.login;
    if (!username) {
      return { success: false, error: 'Not authenticated. Please login first.' };
    }

    const branchName = `skill/${skillId}-${Date.now()}`;

    let targetRepo = repo;
    let prTargetRepo = repo;
    let headBranch = branchName;

    const apiHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    try {
      const repoResp = await githubFetch(`${GITHUB_API_BASE}/repos/${repo}`, {
        headers: apiHeaders,
      });
      if (repoResp.ok) {
        const repoData = await repoResp.json();
        if (repoData.fork && repoData.parent?.full_name) {
          console.log(`[GitHubSkillSource] ${repo} is a fork of ${repoData.parent.full_name}`);
          targetRepo = repo;
          prTargetRepo = repoData.parent.full_name;
          headBranch = branchName;
        }
      }
    } catch {
      // Cannot determine fork status, continue with default behavior
    }

    if (targetRepo === repo && prTargetRepo === repo) {
      try {
        const collabResp = await githubFetch(
          `${GITHUB_API_BASE}/repos/${repo}/collaborators/${username}`,
          { headers: apiHeaders },
        );
        if (!collabResp.ok && collabResp.status !== 204) throw new Error('not collaborator');
      } catch {
        console.log(`[GitHubSkillSource] Forking ${repo}...`);
        try {
          await githubFetch(`${GITHUB_API_BASE}/repos/${repo}/forks`, {
            method: 'POST',
            headers: apiHeaders,
          });
        } catch (forkError: any) {
          if (!forkError.message?.includes('already')) {
            console.warn('[GitHubSkillSource] Fork warning:', forkError.message);
          }
        }
        targetRepo = `${username}/${repo.split('/')[1]}`;
        headBranch = branchName;
      }
    }

    console.log(`[GitHubSkillSource] Getting base SHA from ${targetRepo}...`);
    let baseSha = '';
    let baseBranch = 'main';
    try {
      const refResp = await githubFetch(
        `${GITHUB_API_BASE}/repos/${targetRepo}/git/ref/heads/main`,
        { headers: apiHeaders },
      );
      if (refResp.ok) {
        const refData = await refResp.json();
        baseSha = refData.object.sha;
      }
    } catch {
      baseBranch = 'master';
      try {
        const refResp = await githubFetch(
          `${GITHUB_API_BASE}/repos/${targetRepo}/git/ref/heads/master`,
          { headers: apiHeaders },
        );
        if (refResp.ok) {
          const refData = await refResp.json();
          baseSha = refData.object.sha;
        }
      } catch (innerErr: any) {
        const err = new Error(
          `Failed to resolve base branch. Tried 'main' and 'master'. ${innerErr.message}`,
        );
        (err as any).cause = innerErr;
        throw err;
      }
    }
    console.log(`[GitHubSkillSource] Base SHA: ${baseSha} (branch: ${baseBranch})`);

    console.log(`[GitHubSkillSource] Creating branch ${branchName} on ${targetRepo}...`);
    const createRefResp = await githubFetch(`${GITHUB_API_BASE}/repos/${targetRepo}/git/refs`, {
      method: 'POST',
      headers: { ...apiHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
    });
    if (!createRefResp.ok) {
      const errText = await createRefResp.text();
      throw new Error(`Failed to create branch: ${createRefResp.status} ${errText}`);
    }

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
      const putResp = await githubFetch(putUrl, {
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
      const prResp = await githubFetch(`https://api.github.com/repos/${prTargetRepo}/pulls`, {
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
