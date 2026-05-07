/**
 * GitCode Skill Source - API Infrastructure
 *
 * Concurrency control, rate limiting, and authenticated fetch for GitCode API.
 */

import { getGitCodeToken } from '../config.service';
import { proxyFetch } from '../proxy';

export { getGitCodeToken };

export const GITCODE_API_BASE = 'https://api.gitcode.com/api/v5';

// ── Global concurrency semaphore ───────────────────────────────────────

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

export const _apiSemaphore = new Semaphore();

// ── Rate Limiter ──────────────────────────────────────────────────

const RATE_LIMIT_MAX_TOKENS = 150;
const RATE_LIMIT_MIN_INTERVAL_MS = 100;
const RATE_LIMIT_REFILL_INTERVAL_MS = 1000;

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
    await new Promise<void>((r) => setTimeout(r, RATE_LIMIT_REFILL_INTERVAL_MS));
    this.refill();
    this._tokens = Math.max(this._tokens - 1, 0);
    this._lastAcquire = Date.now();
  }
}

export const _rateLimiter = new RateLimiter();

export let _requestCount = 0;

/** Increment the request counter (called from other modules). */
export function incrementRequestCount(): void {
  _requestCount++;
}

/**
 * Run an async function with global concurrency control (semaphore only).
 */
export async function withConcurrency<T>(fn: () => Promise<T>): Promise<T> {
  await _apiSemaphore.acquire();
  try {
    return await fn();
  } finally {
    _apiSemaphore.release();
  }
}

const GITCODE_FETCH_TIMEOUT_MS = 30_000;

/**
 * Proxy-aware fetch for GitCode API with 30s timeout.
 */
export async function gitcodeFetch(url: string, init?: RequestInit): Promise<Response> {
  return proxyFetch(url, init, GITCODE_FETCH_TIMEOUT_MS);
}

/**
 * Authenticated fetch for GitCode write operations.
 */
export async function gitcodeAuthFetch(url: string, init: RequestInit, token: string): Promise<Response> {
  await _rateLimiter.acquire();
  _requestCount++;
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) || {}),
    'private-token': token,
  };
  return gitcodeFetch(url, { ...init, headers });
}

interface GitCodeApiOptions {
  token?: string;
}

/**
 * Main GitCode API fetch with rate limiting, retry, and error handling.
 */
export async function gitcodeApiFetch(path: string, options?: GitCodeApiOptions): Promise<any> {
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
