/**
 * Registry Service Internal Types
 *
 * Implementation-specific types used only within the main process.
 * Shared types are in src/shared/store/store-types.ts.
 */

import type { RegistryIndex, RegistryEntry, RegistrySource, StoreQuery, StoreAppDetail, UpdateInfo } from '../../shared/store/store-types'
import type { AppSpec } from '../apps/spec/schema'

// Re-export shared types for convenience
export type { RegistryIndex, RegistryEntry, RegistrySource, StoreQuery, StoreAppDetail, UpdateInfo }

/** Cached index with metadata */
export interface CachedIndex {
  /** The parsed index */
  index: RegistryIndex
  /** When this index was fetched (unix ms) */
  fetchedAt: number
  /** Which registry source this belongs to */
  registryId: string
}

/** Cached spec with metadata */
export interface CachedSpec {
  /** The parsed AppSpec */
  spec: AppSpec
  /** Cache key (registryId:slug) */
  key: string
  /** When this spec was fetched (unix ms) */
  fetchedAt: number
}

/** Registry service configuration */
export interface RegistryServiceConfig {
  /** Configured registry sources */
  registries: RegistrySource[]
  /** Cache TTL in milliseconds (default: 3600000 = 1h) */
  cacheTtlMs: number
  /** Whether to auto-check updates (default: true) */
  autoCheckUpdates: boolean
}
