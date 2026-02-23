/**
 * Notify Channels — Token Manager
 *
 * Generic token management for WeCom, DingTalk, and Feishu.
 * Handles caching, proactive refresh, and invalidation.
 */

export interface TokenFetcher {
  (): Promise<{ token: string; expiresIn: number }>
}

/**
 * In-memory access token manager with proactive refresh.
 * Refreshes 5 minutes before expiry to avoid mid-request failures.
 */
export class TokenManager {
  private token = ''
  private expiresAt = 0
  private refreshPromise: Promise<string> | null = null

  constructor(
    private readonly label: string,
    private readonly fetcher: TokenFetcher
  ) {}

  /**
   * Get a valid access token. Refreshes automatically when needed.
   */
  async getToken(): Promise<string> {
    const now = Date.now()
    // Return cached token if still valid (with 5-min buffer)
    if (this.token && now < this.expiresAt - 300_000) {
      return this.token
    }

    // Deduplicate concurrent refresh requests
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.refreshPromise = this.refresh()
    try {
      return await this.refreshPromise
    } finally {
      this.refreshPromise = null
    }
  }

  /**
   * Invalidate the current token (e.g., on 401/expired error).
   * Next getToken() call will fetch a fresh token.
   */
  invalidate(): void {
    this.token = ''
    this.expiresAt = 0
    console.log(`[NotifyChannel][${this.label}] Token invalidated`)
  }

  private async refresh(): Promise<string> {
    console.log(`[NotifyChannel][${this.label}] Refreshing access token...`)
    const { token, expiresIn } = await this.fetcher()
    this.token = token
    this.expiresAt = Date.now() + expiresIn * 1000
    console.log(`[NotifyChannel][${this.label}] Token refreshed, expires in ${expiresIn}s`)
    return this.token
  }
}

/**
 * Retry a function once if the token appears expired.
 * Checks for common expired-token error codes across platforms.
 */
export async function withTokenRetry<T extends { errcode?: number }>(
  manager: TokenManager,
  fn: (token: string) => Promise<T>
): Promise<T> {
  let token = await manager.getToken()
  let result = await fn(token)

  // Common expired/invalid token error codes:
  // WeCom: 42001 (expired), 40014 (invalid)
  // DingTalk: 88 (invalid/expired), 40014 (invalid)
  const code = result.errcode
  if (code === 42001 || code === 40014 || code === 88) {
    console.log(`[NotifyChannel] Token error (code=${code}), retrying with fresh token...`)
    manager.invalidate()
    token = await manager.getToken()
    result = await fn(token)
  }

  return result
}
