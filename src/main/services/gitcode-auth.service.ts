/**
 * GitCode Auth Service
 *
 * Simple token-based authentication for GitCode (gitcode.com).
 * Unlike GitHub (which uses `gh` CLI), GitCode just needs a PAT
 * stored in config and validated via /user API.
 */

import { getGitCodeToken, setGitCodeToken } from './config.service'
import { gitcodeFetch } from './skill/gitcode-skill-source.service'

const GITCODE_API_BASE = 'https://gitcode.com/api/v5'

interface GitCodeAuthStatus {
  authenticated: boolean
  user: string | null
  name: string | null
  avatarUrl: string | null
  error?: string
}

/**
 * Get current GitCode authentication status by validating stored token
 */
export async function getGitCodeAuthStatus(): Promise<GitCodeAuthStatus> {
  const token = getGitCodeToken()
  if (!token) {
    return { authenticated: false, user: null, name: null, avatarUrl: null }
  }

  try {
    const response = await gitcodeFetch(`${GITCODE_API_BASE}/user`, {
      headers: { 'private-token': token }
    })

    if (!response.ok) {
      return {
        authenticated: false,
        user: null,
        name: null,
        avatarUrl: null,
        error: `Token invalid (${response.status})`
      }
    }

    const data = await response.json()
    return {
      authenticated: true,
      user: data.login || data.username || data.name || null,
      name: data.name || data.login || null,
      avatarUrl: data.avatar_url || data.avatar_url || null,
    }
  } catch (error: any) {
    return {
      authenticated: false,
      user: null,
      name: null,
      avatarUrl: null,
      error: error.message || 'Failed to validate token'
    }
  }
}

/**
 * Login with a Personal Access Token
 */
export async function loginWithGitCodeToken(token: string): Promise<{ success: boolean; error?: string; user?: string }> {
  try {
    const response = await gitcodeFetch(`${GITCODE_API_BASE}/user`, {
      headers: { 'private-token': token }
    })

    if (!response.ok) {
      const text = await response.text()
      return { success: false, error: `Invalid token (${response.status}): ${text}` }
    }

    const data = await response.json()
    // Save token on success
    setGitCodeToken(token)

    return {
      success: true,
      user: data.login || data.username || data.name
    }
  } catch (error: any) {
    return { success: false, error: error.message || 'Failed to login' }
  }
}

/**
 * Logout (remove stored token)
 */
export function logoutGitCode(): { success: boolean } {
  setGitCodeToken(undefined)
  return { success: true }
}
