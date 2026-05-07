/**
 * GitCode Skill Source - Skill Push & Validation
 *
 * Push skills via Merge Request and validate repositories.
 */

import { gitcodeApiFetch, gitcodeAuthFetch, GITCODE_API_BASE } from './gitcode-api';

/**
 * Validate that a GitCode repo exists and contains skill directories.
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

    const skillsProbe = await gitcodeApiFetch(`/repos/${repo}/contents/skills`, { token });
    if (Array.isArray(skillsProbe)) {
      const skillDirs = skillsProbe.filter(
        (item: any) => item.type === 'dir' && !item.name.startsWith('.'),
      );
      return { valid: true, hasSkillsDir: true, skillCount: skillDirs.length };
    }

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

    const sampleDirs = rootDirs.slice(0, 3);
    let totalSkillCount = 0;
    let foundAny = false;

    for (const dir of sampleDirs) {
      const children = await gitcodeApiFetch(`/repos/${repo}/contents/${dir.name}`, { token });
      if (!Array.isArray(children)) continue;

      const childDirs = children.filter(
        (item: any) => item.type === 'dir' && !item.name.startsWith('.'),
      );
      if (childDirs.length > 0) {
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

    const userData = await gitcodeApiFetch('/user', { token });
    if (!userData || !userData.login) {
      return { success: false, error: 'Failed to get GitCode user info. Check your token.' };
    }
    const username: string = userData.login;

    const branchName = `skill/${skillId}-${Date.now()}`;

    let targetRepo = repo;
    let mrTargetRepo = repo;

    try {
      const repoData = await gitcodeApiFetch(`/repos/${repo}`, { token });
      if (repoData?.fork && repoData?.parent?.full_name) {
        mrTargetRepo = repoData.parent.full_name;
      }
    } catch {
      // continue
    }

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

    const commitErrors: string[] = [];
    let commitSuccess = 0;
    for (const file of files) {
      const filePath = targetPath
        ? `${targetPath}/${skillId}/${file.relativePath}`
        : `${skillId}/${file.relativePath}`;
      const contentBase64 = Buffer.from(file.content).toString('base64');

      const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
      const fileUrl = `${GITCODE_API_BASE}/repos/${targetRepo}/contents/${encodedPath}`;

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
