/**
 * Shared Store Types
 *
 * Pure TypeScript type definitions for the Store / Registry system.
 * These types are used by both the main process and the renderer process.
 *
 * IMPORTANT: This file must NOT import any Node.js or Electron APIs.
 * It is included in the renderer (web) tsconfig.
 */

import type { AppType } from '../apps/spec-types'

// ============================================
// Registry Source Configuration
// ============================================

/** A configured registry source */
export interface RegistrySource {
  /** Unique identifier */
  id: string
  /** Display name */
  name: string
  /** Base URL for fetching index.json and packages */
  url: string
  /** Whether this registry is enabled */
  enabled: boolean
  /** Whether this is the built-in official registry (cannot be deleted) */
  isDefault?: boolean
}

// ============================================
// Registry Index (fetched from registry)
// ============================================

/** Top-level structure of index.json */
export interface RegistryIndex {
  /** Index format version */
  version: number
  /** ISO timestamp when the index was generated */
  generated_at: string
  /** Registry source identifier URL */
  source: string
  /** List of available apps */
  apps: RegistryEntry[]
}

/** A single app entry in the registry index */
export interface RegistryEntry {
  // Identity
  /** URL-safe unique identifier */
  slug: string
  /** Display name */
  name: string
  /** Current version (semver) */
  version: string
  /** Author name */
  author: string
  /** Short description */
  description: string
  /** App type */
  type: AppType

  // Distribution
  /** Package format (bundle-only; minimum bundle is a folder with spec.yaml) */
  format: 'bundle'
  /** Relative bundle directory path within the registry */
  path: string
  /** Absolute download URL (for non-Git sources) */
  download_url?: string
  /** Package size in bytes */
  size_bytes?: number
  /** Integrity checksum (sha256:...) */
  checksum?: string

  // Discovery
  /** Primary category */
  category: string
  /** Free-form tags */
  tags: string[]
  /** Icon (emoji or URL) */
  icon?: string
  /** Primary locale (BCP 47) */
  locale?: string

  // Compatibility
  /** Minimum client version required */
  min_app_version?: string

  // Dependency summary (for display without fetching full spec)
  /** Required MCP IDs */
  requires_mcps?: string[]
  /** Required Skill IDs */
  requires_skills?: string[]

  // Timestamps
  /** ISO timestamp when first published */
  created_at?: string
  /** ISO timestamp of last update */
  updated_at?: string
}

// ============================================
// Store Query & Filtering
// ============================================

/** Query parameters for listing store apps */
export interface StoreQuery {
  /** Free-text search (matches name, description, tags) */
  search?: string
  /** Filter by category */
  category?: string
  /** Filter by app type */
  type?: AppType
  /** Filter by tags */
  tags?: string[]
}

// ============================================
// Store App Detail (full spec + entry)
// ============================================

/** Full detail for a single store app (entry + resolved spec) */
export interface StoreAppDetail {
  /** Registry entry metadata */
  entry: RegistryEntry
  /** Full AppSpec (fetched on demand) */
  spec: import('../apps/spec-types').AppSpec
  /** Which registry source this came from */
  registryId: string
}

// ============================================
// Update Information
// ============================================

/** Information about an available update for an installed app */
export interface UpdateInfo {
  /** Installed app ID */
  appId: string
  /** Currently installed version */
  currentVersion: string
  /** Latest available version */
  latestVersion: string
  /** Registry entry for the latest version */
  entry: RegistryEntry
}

// ============================================
// Store Categories
// ============================================

/** Predefined store categories */
export const STORE_CATEGORIES = [
  'shopping',
  'news',
  'content',
  'dev-tools',
  'productivity',
  'data',
  'social',
  'other',
] as const

export type StoreCategory = typeof STORE_CATEGORIES[number]

/** Category display metadata */
export interface StoreCategoryMeta {
  id: StoreCategory
  /** i18n key for the display label */
  labelKey: string
  /** Emoji icon for the category */
  icon: string
}

/** Category metadata for UI rendering */
export const STORE_CATEGORY_META: StoreCategoryMeta[] = [
  { id: 'shopping', labelKey: 'Shopping', icon: '🛒' },
  { id: 'news', labelKey: 'News', icon: '📰' },
  { id: 'content', labelKey: 'Content', icon: '✍️' },
  { id: 'dev-tools', labelKey: 'Dev Tools', icon: '🛠️' },
  { id: 'productivity', labelKey: 'Productivity', icon: '⚡' },
  { id: 'data', labelKey: 'Data', icon: '📊' },
  { id: 'social', labelKey: 'Social', icon: '💬' },
  { id: 'other', labelKey: 'Other', icon: '📦' },
]
