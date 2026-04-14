/**
 * GitCode Skill Source Service
 *
 * Provides read/write operations for skill repositories on GitCode (gitcode.com).
 * Parallel to github-skill-source.service.ts but uses GitCode v5 API.
 * Auth via user-provided Personal Access Token stored in config.
 */

import { parse as parseYaml } from 'yaml'
import { getGitCodeToken } from '../config.service'
import type { RemoteSkillItem } from '../../../shared/skill/skill-types'

// ── GitCode API fetch ──────────────────────────────────────────────

interface GitCodeApiOptions {
  token?: string
}

const GITCODE_API_BASE = 'https://gitcode.com/api/v5'

// Proxy support for internal networks
let _proxyDispatcher: any = null

async function getProxyDispatcher(): Promise<any> {
  if (_proxyDispatcher !== null) return _proxyDispatcher
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy
  if (!proxyUrl) {
    _proxyDispatcher = false
    return false
  }
  try {
    const { ProxyAgent } = await import('undici')
    _proxyDispatcher = new ProxyAgent(proxyUrl)
    console.log('[GitCodeAPI] using proxy:', proxyUrl)
    return _proxyDispatcher
  } catch {
    console.warn('[GitCodeAPI] failed to create proxy agent, proceeding without proxy')
    _proxyDispatcher = false
    return false
  }
}

/**
 * Proxy-aware fetch for GitCode API. Exported for reuse by gitcode-auth.service.
 */
export async function gitcodeFetch(url: string, init?: RequestInit): Promise<Response> {
  const dispatcher = await getProxyDispatcher()
  const response = await fetch(url, { ...init, ...(dispatcher ? { dispatcher } as any : {}) })
  return response
}

async function gitcodeApiFetch(path: string, options?: GitCodeApiOptions): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (options?.token) {
    headers['private-token'] = options.token
  }

  // Support access_token as query param fallback
  const url = path.includes('?')
    ? `${GITCODE_API_BASE}${path}`
    : `${GITCODE_API_BASE}${path}`

  const response = await gitcodeFetch(url, { headers })

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    const text = await response.text()
    console.error('[GitCodeAPI] error:', response.status, text.slice(0, 200))
    throw new Error(`GitCode API error ${response.status}: ${text}`)
  }

  const data = await response.json()
  return data
}

// ── Frontmatter parsing (shared pattern) ──────────────────────────

interface SkillFrontmatter {
  name?: string
  description?: string
  version?: string
  author?: string
  trigger_command?: string
  tags?: string[]
}

function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) {
    return { frontmatter: {}, body: content }
  }
  try {
    const parsed = parseYaml(match[1]) as SkillFrontmatter
    const body = content.slice(match[0].length).trim()
    return { frontmatter: parsed || {}, body }
  } catch {
    return { frontmatter: {}, body: content }
  }
}

function formatSkillName(name: string): string {
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

// ── Token management ──────────────────────────────────────────────

export { getGitCodeToken }

// ── Recursive skill directory finder ──────────────────────────────

async function findSkillDirs(
  repo: string,
  path: string,
  token?: string,
  maxDepth: number = 5
): Promise<Array<{ path: string; name: string }>> {
  if (maxDepth <= 0) return []

  const apiPath = path === '/'
    ? `/repos/${repo}/contents`
    : `/repos/${repo}/contents/${path.replace(/\/$/, '')}`

  let data: any[]
  try {
    const result = await gitcodeApiFetch(apiPath, { token })
    if (!Array.isArray(result)) return []
    data = result
  } catch {
    return []
  }

  const dirs = data.filter(
    (item: any) => item.type === 'dir' && !item.name.startsWith('.')
  )
  const hasSkillMd = data.some(
    (item: any) => item.type === 'file' && item.name.toUpperCase() === 'SKILL.MD'
  )

  const results: Array<{ path: string; name: string }> = []

  if (hasSkillMd) {
    const dirName = path === '/' ? '' : path.replace(/\/$/, '').split('/').pop()!
    results.push({ path: path.replace(/\/$/, ''), name: dirName })
    return results
  }

  const subResults = await Promise.all(
    dirs.map((dir: any) => {
      const subPath = path === '/' ? `${dir.name}/` : `${path}${dir.name}/`
      return findSkillDirs(repo, subPath, token, maxDepth - 1)
    })
  )

  for (const sub of subResults) {
    results.push(...sub)
  }

  return results
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Fetch single file content from GitCode repo.
 */
export async function fetchSkillFileContent(
  repo: string,
  path: string,
  token?: string
): Promise<string | null> {
  try {
    const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/')
    const data = await gitcodeApiFetch(`/repos/${repo}/contents/${encodedPath}`, { token })
    if (data && data.content && !Array.isArray(data)) {
      return Buffer.from(data.content, 'base64').toString('utf-8')
    }
  } catch {
    // file not found or access denied
  }
  return null
}

/**
 * Recursively download all files in a GitCode directory.
 */
export async function fetchSkillDirectoryContents(
  repo: string,
  dirPath: string,
  token?: string
): Promise<Array<{ path: string; content: string }>> {
  const results: Array<{ path: string; content: string }> = []
  const apiPath = `/repos/${repo}/contents/${dirPath.replace(/\/$/, '')}`

  let data: any
  try {
    data = await gitcodeApiFetch(apiPath, { token })
  } catch {
    return results
  }

  if (data && !Array.isArray(data)) {
    if (data.content) {
      const decoded = Buffer.from(data.content, 'base64').toString('utf-8')
      results.push({ path: data.name, content: decoded })
    }
    return results
  }

  if (!Array.isArray(data)) return results

  for (const item of data) {
    if (item.type === 'file') {
      if (item.content) {
        const decoded = Buffer.from(item.content, 'base64').toString('utf-8')
        results.push({ path: item.name, content: decoded })
      } else {
        const content = await fetchSkillFileContent(repo, item.path, token)
        if (content !== null) {
          results.push({ path: item.name, content })
        }
      }
    } else if (item.type === 'dir' && !item.name.startsWith('.')) {
      const subPath = `${dirPath.replace(/\/$/, '')}/${item.name}`
      const subFiles = await fetchSkillDirectoryContents(repo, subPath, token)
      for (const sub of subFiles) {
        results.push({ path: `${item.name}/${sub.path}`, content: sub.content })
      }
    }
  }

  return results
}

/**
 * Find the skill directory path on GitCode by checking path variants.
 * Includes case-insensitive fallback via findSkillDirs listing.
 */
export async function findSkillDirectoryPath(
  repo: string,
  skillName: string,
  token?: string
): Promise<string | null> {
  const lastSegment = skillName.split('/').pop() || skillName
  const dirVariants = [
    skillName,
    `skills/${skillName}`,
    lastSegment,
  ]

  const skillFileNames = ['SKILL.md', 'SKILL.yaml']

  // Try exact path matches first
  for (const dir of dirVariants) {
    const apiPath = `/repos/${repo}/contents/${dir.replace(/\/$/, '')}`
    try {
      const data = await gitcodeApiFetch(apiPath, { token })
      if (Array.isArray(data)) {
        const found = data.some(
          (item: any) => item.type === 'file' && skillFileNames.some(sf => item.name.toUpperCase() === sf.toUpperCase())
        )
        if (found) {
          return dir.replace(/\/$/, '')
        }
      }
    } catch {
      // continue
    }
  }

  // Case-insensitive fallback: list all skill dirs and compare lowercased paths
  try {
    const allDirs = await findSkillDirs(repo, '/', token)
    const normalizedTarget = skillName.toLowerCase()
    for (const { path: dirPath } of allDirs) {
      if (dirPath.toLowerCase() === normalizedTarget || dirPath.toLowerCase().endsWith(`/${normalizedTarget}`)) {
        return dirPath
      }
    }
    // Also try matching just the last segment
    const normalizedLast = lastSegment.toLowerCase()
    for (const { path: dirPath } of allDirs) {
      const dirLast = dirPath.split('/').pop() || dirPath
      if (dirLast.toLowerCase() === normalizedLast) {
        return dirPath
      }
    }
  } catch {
    // give up
  }

  return null
}

/**
 * List subdirectories in a GitCode repo.
 */
export async function listRepoDirectories(
  repo: string,
  basePath?: string,
  token?: string
): Promise<string[]> {
  try {
    const apiPath = basePath
      ? `/repos/${repo}/contents/${basePath}`
      : `/repos/${repo}/contents`
    const data = await gitcodeApiFetch(apiPath, { token })
    if (!Array.isArray(data)) return []
    return data
      .filter((item: any) => item.type === 'dir' && !item.name.startsWith('.'))
      .map((item: any) => item.name)
  } catch {
    return []
  }
}

/**
 * List all skills in a GitCode repository.
 */
export async function listSkillsFromRepo(
  repo: string,
  token?: string
): Promise<RemoteSkillItem[]> {
  const skills: RemoteSkillItem[] = []
  const sourceId = `gitcode:${repo}`
  const seenPaths = new Set<string>()

  const pathsToCheck = ['skills/', '/']

  for (const basePath of pathsToCheck) {
    try {
      const apiPath = basePath === '/'
        ? `/repos/${repo}/contents`
        : `/repos/${repo}/contents/${basePath.replace(/\/$/, '')}`
      const probe = await gitcodeApiFetch(apiPath, { token })
      if (!Array.isArray(probe)) continue

      const skillDirs = await findSkillDirs(repo, basePath, token)

      const metadataResults = await Promise.all(
        skillDirs.map(async ({ path: skillPath, name }) => {
          if (seenPaths.has(skillPath)) return null
          seenPaths.add(skillPath)

          let frontmatter: SkillFrontmatter = {}
          let description = ''

          try {
            const content = await fetchSkillFileContent(repo, `${skillPath}/SKILL.md`, token)
            if (content) {
              const parsed = parseFrontmatter(content)
              frontmatter = parsed.frontmatter
              description = parsed.body.split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 3).join(' ')
            }
          } catch {
            // continue without metadata
          }

          const skillName = frontmatter.name || name
          const skillId = skillPath.toLowerCase().replace(/\s+/g, '-')

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
            githubRepo: repo,
            githubPath: skillPath,
          } as RemoteSkillItem
        })
      )

      for (const item of metadataResults) {
        if (item) skills.push(item)
      }

      if (skills.length > 0 && basePath === 'skills/') break
    } catch (error) {
      console.error(`[GitCodeSkillSource] Error listing ${repo}/${basePath}:`, error)
    }
  }

  return skills
}

/**
 * Get detailed skill content from a GitCode repo.
 */
export async function getSkillDetailFromRepo(
  repo: string,
  skillPath: string,
  token?: string
): Promise<RemoteSkillItem | null> {
  const skillName = skillPath.split('/').pop() || skillPath
  const sourceId = `gitcode:${repo}`
  const skillId = skillPath.toLowerCase().replace(/\s+/g, '-')

  const contentPaths = [
    `${skillPath}/SKILL.md`,
    `${skillPath}/SKILL.yaml`,
  ]

  for (const contentPath of contentPaths) {
    const content = await fetchSkillFileContent(repo, contentPath, token)
    if (content) {
      const isYaml = contentPath.endsWith('.yaml')
      const parsed = isYaml ? null : parseFrontmatter(content)
      const frontmatter = isYaml
        ? (parseYaml(content) as SkillFrontmatter)?.skill || parseYaml(content) as SkillFrontmatter
        : parsed.frontmatter
      const description = parsed
        ? parsed.body.split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 3).join(' ')
        : ''

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
        githubRepo: repo,
        githubPath: skillPath,
        skillContent: content,
      }
    }
  }

  return null
}

/**
 * Validate that a GitCode repo exists and contains skill directories.
 */
export async function validateRepo(
  repo: string,
  token?: string
): Promise<{ valid: boolean; error?: string; skillCount?: number }> {
  try {
    const data = await gitcodeApiFetch(`/repos/${repo}`, { token })
    if (!data) {
      return { valid: false, error: 'Repository not found or access denied' }
    }

    const skills = await listSkillsFromRepo(repo, token)
    return {
      valid: true,
      skillCount: skills.length,
      error: skills.length === 0 ? 'No skills found in this repository' : undefined,
    }
  } catch (error: any) {
    console.error('[GitCodeService] validateRepo error:', error.message)
    return { valid: false, error: error.message || 'Failed to validate repository' }
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
  token?: string
): Promise<{ success: boolean; mrUrl?: string; error?: string; warning?: string }> {
  try {
    if (!token) {
      return { success: false, error: 'GitCode token is required. Please configure it in Settings.' }
    }

    // Get current user info
    const userData = await gitcodeApiFetch('/user', { token })
    if (!userData || !userData.login) {
      return { success: false, error: 'Failed to get GitCode user info. Check your token.' }
    }
    const username: string = userData.login

    const branchName = `skill/${skillId}-${Date.now()}`

    let targetRepo = repo
    let mrTargetRepo = repo

    // Check if repo is a fork
    try {
      const repoData = await gitcodeApiFetch(`/repos/${repo}`, { token })
      if (repoData?.fork && repoData?.parent?.full_name) {
        mrTargetRepo = repoData.parent.full_name
      }
    } catch {
      // continue
    }

    // If not a fork, try fork for non-collaborators
    if (targetRepo === repo && mrTargetRepo === repo) {
      let isCollaborator = false
      try {
        const collabRes = await gitcodeApiFetch(`/repos/${repo}/collaborators/${username}`, { token })
        isCollaborator = !!collabRes
      } catch {
        isCollaborator = false
      }

      if (!isCollaborator) {
        try {
          const forkResp = await gitcodeFetch(`${GITCODE_API_BASE}/repos/${repo}/forks?access_token=${encodeURIComponent(token)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          })
          if (!forkResp.ok && forkResp.status !== 409) {
            console.warn(`[GitCodeSkillSource] Fork failed: ${forkResp.status}`)
          }
        } catch (forkError: any) {
          console.warn('[GitCodeSkillSource] Fork warning:', forkError.message)
        }
        targetRepo = `${username}/${repo.split('/')[1]}`
      }
    }

    // Get base branch SHA
    let baseBranch = 'main'
    let branchData = await gitcodeApiFetch(`/repos/${targetRepo}/branches/main`, { token })
    let baseSha: string | undefined = branchData?.commit?.id
    if (!baseSha) {
      baseBranch = 'master'
      branchData = await gitcodeApiFetch(`/repos/${targetRepo}/branches/master`, { token })
      baseSha = branchData?.commit?.id
    }
    if (!baseSha) {
      return { success: false, error: 'Failed to get base branch SHA from GitCode repo (tried main and master)' }
    }
    const branchResp = await gitcodeFetch(`${GITCODE_API_BASE}/repos/${targetRepo}/branches?access_token=${encodeURIComponent(token)}&refs=${encodeURIComponent(baseBranch)}&branch_name=${encodeURIComponent(branchName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!branchResp.ok) {
      const errText = await branchResp.text()
      return { success: false, error: `Failed to create branch: ${branchResp.status} ${errText}` }
    }

    // Commit all files - GitCode uses POST for new files, PUT for updates
    const commitErrors: string[] = []
    let commitSuccess = 0
    for (const file of files) {
      const filePath = targetPath
        ? `${targetPath}/${skillId}/${file.relativePath}`
        : `${skillId}/${file.relativePath}`
      const contentBase64 = Buffer.from(file.content).toString('base64')

      const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
      const url = `${GITCODE_API_BASE}/repos/${targetRepo}/contents/${encodedPath}?access_token=${encodeURIComponent(token)}`

      // Check if file exists (to decide POST vs PUT)
      let existingSha: string | undefined
      try {
        const existingFile = await gitcodeApiFetch(`/repos/${targetRepo}/contents/${encodedPath}?ref=${encodeURIComponent(branchName)}`, { token })
        if (existingFile?.sha) {
          existingSha = existingFile.sha
        }
      } catch {
        // File doesn't exist, use POST
      }

      const body: Record<string, string> = {
        access_token: token,
        message: `Add ${file.relativePath}`,
        content: contentBase64,
        branch: branchName,
      }
      if (existingSha) {
        body.sha = existingSha
      }

      // POST for new files, PUT for updates
      const method = existingSha ? 'PUT' : 'POST'
      const putResp = await gitcodeFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (putResp.ok) {
        commitSuccess++
      } else {
        const errText = await putResp.text()
        commitErrors.push(`${filePath} (${method}): ${errText.slice(0, 150)}`)
      }
    }

    if (commitSuccess === 0) {
      return { success: false, error: `All files failed. First: ${commitErrors[0]}` }
    }

    // Create MR via GitCode API (non-fatal: if MR fails but files committed, still return success)
    const mrTitle = `Add skill: ${skillId}`
    const partialNote = commitErrors.length > 0 ? `\n\n⚠️ ${commitErrors.length} file(s) failed to upload.` : ''
    const mrBody = `## New Skill: ${skillId}\n\nThis MR adds a new skill submitted via AICO-Bot.\n\nFiles uploaded: ${commitSuccess}/${files.length}${partialNote}\n\n---\n*Submitted by @${username}*`
    const head = targetRepo === mrTargetRepo ? branchName : `${username}:${branchName}`

    const commitWarning = commitErrors.length > 0 ? `${commitErrors.length} file(s) failed: ${commitErrors.slice(0, 3).join('; ')}` : undefined
    const branchUrl = `https://gitcode.com/${targetRepo}/tree/${branchName}`

    let mrUrl: string | undefined
    let mrWarnings: string[] = commitWarning ? [commitWarning] : []

    try {
      const mrResp = await gitcodeFetch(`${GITCODE_API_BASE}/repos/${mrTargetRepo}/pulls?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: mrTitle,
          body: mrBody,
          head: head,
          base: baseBranch,
        }),
      })

      if (!mrResp.ok) {
        const errText = await mrResp.text()
        console.warn(`[GitCodeSkillSource] MR creation failed: ${mrResp.status} ${errText}`)
        mrWarnings.push(`MR creation failed (${mrResp.status}). Files committed to branch: ${branchUrl}`)
      } else {
        const mrData = await mrResp.json()
        mrUrl = mrData.html_url || mrData.web_url || mrData.url
        if (!mrUrl) {
          const mrNumber = mrData.number || mrData.iid
          if (mrNumber) {
            mrUrl = `https://gitcode.com/${mrTargetRepo}/pulls/${mrNumber}`
          } else {
            console.warn(`[GitCodeSkillSource] MR response has no URL fields:`, mrData)
            mrWarnings.push(`MR created but no URL returned. Branch: ${branchUrl}`)
          }
        }
      }
    } catch (mrError: any) {
      console.warn(`[GitCodeSkillSource] MR creation error: ${mrError.message}`)
      mrWarnings.push(`MR creation error: ${mrError.message}. Files committed to branch: ${branchUrl}`)
    }

    // If files were committed, always return success (MR creation is non-fatal)
    if (commitSuccess > 0) {
      const fallbackUrl = mrUrl || branchUrl
      const warning = mrWarnings.length > 0 ? mrWarnings.join('. ') : undefined
      return { success: true, mrUrl: fallbackUrl, warning }
    }
  } catch (error: any) {
    console.error('[GitCodeSkillSource] pushSkillAsMR error:', error)
    return {
      success: false,
      error: error.message || 'Failed to push skill to GitCode.',
    }
  }
}

/**
 * Read all local skill files (shared, not GitCode-specific).
 */
export { readLocalSkillContent, readLocalSkillFiles } from './github-skill-source.service'
