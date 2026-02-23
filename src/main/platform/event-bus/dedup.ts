/**
 * platform/event-bus -- Dedup Cache
 *
 * In-memory TTL-based deduplication cache for HaloEvent streams.
 *
 * When an event has a `dedupKey`, the cache checks if the same key
 * was seen within the TTL window. If so, the event is considered a
 * duplicate and should be dropped.
 *
 * Design decisions:
 * - In-memory Map (not SQLite): dedup state does not need to survive
 *   process restarts. Consumers are idempotent by design.
 * - TTL default 60s: covers webhook retries and file-watcher bursts.
 * - maxSize 10,000: bounds memory to ~1MB worst case.
 * - Pruning on insert: old entries are evicted lazily when new entries
 *   are added, using the Map insertion-order iteration.
 */

import type { DedupConfig } from './types'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 60_000    // 60 seconds
const DEFAULT_MAX_SIZE = 10_000  // 10k entries

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DedupCache {
  /**
   * Check if a key is a duplicate.
   *
   * @param key - The dedup key to check. If null/undefined, always returns false.
   * @param now - Current timestamp in ms (default: Date.now()). Exposed for testing.
   * @returns `true` if this key was already seen within the TTL (duplicate),
   *          `false` if this is the first occurrence (not a duplicate).
   *
   * Side effect: the key is always recorded (or refreshed) in the cache.
   */
  isDuplicate(key: string | undefined | null, now?: number): boolean

  /** Remove all entries from the cache. */
  clear(): void

  /** Current number of entries in the cache. */
  size(): number
}

/**
 * Create a new dedup cache with the given configuration.
 */
export function createDedupCache(config?: Partial<DedupConfig>): DedupCache {
  const ttlMs = Math.max(0, config?.ttlMs ?? DEFAULT_TTL_MS)
  const maxSize = Math.max(1, Math.floor(config?.maxSize ?? DEFAULT_MAX_SIZE))

  // Map<key, timestamp> -- insertion order preserved by ES Map spec
  const cache = new Map<string, number>()

  function touch(key: string, now: number): void {
    // Delete + re-set to move the entry to the end (most recent position)
    cache.delete(key)
    cache.set(key, now)
  }

  function prune(now: number): void {
    // Evict expired entries
    if (ttlMs > 0) {
      const cutoff = now - ttlMs
      for (const [entryKey, entryTs] of Array.from(cache)) {
        if (entryTs < cutoff) {
          cache.delete(entryKey)
        } else {
          // Map is ordered by insertion; once we hit a non-expired entry,
          // all subsequent entries are newer. However, since touch() reorders,
          // we cannot break early. We iterate the full map for correctness.
          // This is still O(n) but n is bounded by maxSize.
        }
      }
    }

    // Evict oldest entries if over capacity
    while (cache.size > maxSize) {
      const oldestKey = cache.keys().next().value
      if (oldestKey === undefined) break
      cache.delete(oldestKey)
    }
  }

  return {
    isDuplicate(key, now = Date.now()): boolean {
      if (!key) return false

      const existing = cache.get(key)
      if (existing !== undefined && (ttlMs <= 0 || now - existing < ttlMs)) {
        // Key exists and is within TTL -- this is a duplicate
        touch(key, now)
        return true
      }

      // Not a duplicate -- record and prune
      touch(key, now)
      prune(now)
      return false
    },

    clear(): void {
      cache.clear()
    },

    size(): number {
      return cache.size
    }
  }
}
