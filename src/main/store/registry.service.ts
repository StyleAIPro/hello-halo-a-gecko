/**
 * Registry Service
 *
 * Core service for fetching, caching, querying, and installing
 * apps from remote registries. Manages multiple registry sources
 * and provides a unified view of available apps.
 *
 * Design principles:
 * - Registry-agnostic: works with any source that serves index.json
 * - Cache-first: minimizes network requests with configurable TTL
 * - Graceful degradation: offline mode uses cached data
 * - Multi-registry: merges indexes, first-wins on slug conflict
 */

import { v4 as uuidv4 } from 'uuid'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { getConfig, saveConfig as saveHaloConfig } from '../services/config.service'
import { getAppManager } from '../apps/manager'
import { getAppRuntime } from '../apps/runtime'
import { AppSpecSchema } from '../apps/spec/schema'
import type { AppSpec } from '../apps/spec/schema'
import type {
  RegistryIndex,
  RegistryEntry,
  RegistrySource,
  StoreQuery,
  StoreAppDetail,
  UpdateInfo,
  RegistryServiceConfig,
  CachedIndex,
} from './registry.types'
import {
  readCachedIndex,
  writeCachedIndex,
  readCachedSpec,
  writeCachedSpec,
  clearCache,
} from './registry.cache'

// ============================================
// Constants
// ============================================

/** Default registry source */
const DEFAULT_REGISTRY: RegistrySource = {
  id: 'official',
  name: 'Digital Human Protocol',
  url: 'https://openkursar.github.io/digital-human-protocol',
  enabled: true,
  isDefault: true,
}

/** Default cache TTL: 1 hour */
const DEFAULT_CACHE_TTL_MS = 3600000

/** Fetch timeout: 10 seconds */
const FETCH_TIMEOUT_MS = 10000

/** Config key used in HaloConfig for store settings */
const CONFIG_KEY = 'appStore'

/** Supported app types in index.json */
const APP_TYPE_VALUES = ['automation', 'skill', 'mcp', 'extension'] as const

// ============================================
// Runtime Validation Schemas (main-process only)
// ============================================

const RegistrySourceSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().trim().min(1),
  url: z.string().url(),
  enabled: z.boolean(),
  isDefault: z.boolean().optional(),
})

const RegistryEntrySchema = z.object({
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  name: z.string().trim().min(1),
  version: z.string().trim().min(1),
  author: z.string().trim().min(1),
  description: z.string().trim().min(1),
  type: z.enum(APP_TYPE_VALUES),
  format: z.literal('bundle'),
  path: z.string().trim().min(1),
  download_url: z.string().url().optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  checksum: z.string().trim().min(1).optional(),
  category: z.string().trim().default('other'),
  tags: z.array(z.string()).default([]),
  icon: z.string().optional(),
  locale: z.string().optional(),
  min_app_version: z.string().optional(),
  requires_mcps: z.array(z.string()).optional(),
  requires_skills: z.array(z.string()).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})

const RegistryIndexSchema = z.object({
  version: z.number(),
  generated_at: z.string(),
  source: z.string(),
  apps: z.array(RegistryEntrySchema),
})

// ============================================
// Module State (singleton pattern)
// ============================================

let initialized = false
let config: RegistryServiceConfig = {
  registries: [DEFAULT_REGISTRY],
  cacheTtlMs: DEFAULT_CACHE_TTL_MS,
  autoCheckUpdates: true,
}

/** In-memory index cache (keyed by registryId) */
const indexCache = new Map<string, CachedIndex>()

/** In-memory mapping of entry slug -> registryId for cross-referencing */
const slugToRegistryMap = new Map<string, string>()

// ============================================
// Initialization / Shutdown
// ============================================

/**
 * Initialize the Registry Service.
 *
 * Loads persisted configuration from the main config file. If no
 * configuration exists, uses defaults with the official registry.
 *
 * @param overrides - Optional partial config for testing or customization
 */
export function initRegistryService(overrides?: Partial<RegistryServiceConfig>): void {
  if (initialized) {
    console.log('[RegistryService] Already initialized, skipping')
    return
  }

  const start = performance.now()
  console.log('[RegistryService] Initializing...')

  // Load persisted config
  const persisted = loadConfig()
  config = {
    ...persisted,
    ...overrides,
    registries: normalizeRegistries(overrides?.registries ?? persisted.registries),
    cacheTtlMs: normalizeCacheTtl(overrides?.cacheTtlMs ?? persisted.cacheTtlMs),
  }

  const defaultChanged = ensureDefaultRegistry()
  if (defaultChanged) {
    saveConfigToFile()
  }

  initialized = true

  const duration = performance.now() - start
  console.log(`[RegistryService] Initialized in ${duration.toFixed(1)}ms (${config.registries.length} registries)`)
}

/**
 * Shutdown the Registry Service.
 *
 * Persists current configuration and clears in-memory caches.
 */
export function shutdownRegistryService(): void {
  if (!initialized) return

  saveConfigToFile()
  indexCache.clear()
  slugToRegistryMap.clear()
  initialized = false

  console.log('[RegistryService] Shutdown complete')
}

// ============================================
// Index Management
// ============================================

/**
 * Refresh the index from one or all registries.
 *
 * Fetches the latest index.json from each enabled registry, updates
 * both in-memory and disk caches. On network failure, logs the error
 * and retains any existing cached data.
 *
 * @param registryId - If provided, only refresh this registry. Otherwise refresh all.
 */
export async function refreshIndex(registryId?: string): Promise<void> {
  ensureInitialized()

  const registries = registryId
    ? config.registries.filter(r => r.id === registryId && r.enabled)
    : config.registries.filter(r => r.enabled)

  if (registries.length === 0) {
    console.log('[RegistryService] No enabled registries to refresh')
    return
  }

  const results = await Promise.allSettled(
    registries.map(registry => fetchAndCacheIndex(registry))
  )

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const registry = registries[i]
    if (result.status === 'rejected') {
      console.error(`[RegistryService] Failed to refresh index for "${registry.name}":`, result.reason)
    }
  }
}

/**
 * Get the merged index from all enabled registries.
 *
 * Returns entries from all enabled registries, merged with first-wins
 * semantics on slug conflicts (higher-priority registries listed first).
 * Uses cached data when available and within TTL.
 */
export async function getIndex(): Promise<RegistryEntry[]> {
  ensureInitialized()

  const enabledRegistries = config.registries.filter(r => r.enabled)
  const allEntries: RegistryEntry[] = []
  const seenSlugs = new Set<string>()

  // Rebuild on each call so removed/disabled registries do not leave stale mappings.
  slugToRegistryMap.clear()

  for (const registry of enabledRegistries) {
    const index = await loadIndexForRegistry(registry)

    if (!index) continue

    for (const entry of index.apps) {
      // Guard against stale cache entries from old registries that used legacy
      // yaml-only packaging. Bundle is the only supported package format.
      if (!isBundleFormat(entry)) {
        continue
      }

      if (!seenSlugs.has(entry.slug)) {
        seenSlugs.add(entry.slug)
        slugToRegistryMap.set(entry.slug, registry.id)
        allEntries.push(entry)
      }
    }
  }

  return allEntries
}

// ============================================
// Querying
// ============================================

/**
 * List apps from the registry with optional filtering.
 *
 * @param query - Optional search/filter criteria
 * @returns Filtered list of registry entries
 */
export async function listApps(query?: StoreQuery): Promise<RegistryEntry[]> {
  const entries = await getIndex()

  if (!query) return entries

  return entries.filter(entry => {
    // Search: case-insensitive match against name, description, tags
    if (query.search) {
      const search = query.search.toLowerCase()
      const nameMatch = entry.name.toLowerCase().includes(search)
      const descMatch = entry.description.toLowerCase().includes(search)
      const tagMatch = entry.tags.some(t => t.toLowerCase().includes(search))
      if (!nameMatch && !descMatch && !tagMatch) return false
    }

    // Category: exact match
    if (query.category && entry.category !== query.category) {
      return false
    }

    // Type: exact match
    if (query.type && entry.type !== query.type) {
      return false
    }

    // Tags: intersection (entry must have ALL queried tags)
    if (query.tags && query.tags.length > 0) {
      const entryTags = new Set(entry.tags.map(tag => tag.toLowerCase()))
      const hasAllTags = query.tags.every(tag => entryTags.has(tag.toLowerCase()))
      if (!hasAllTags) return false
    }

    return true
  })
}

/**
 * Get detailed information about a store app by slug.
 *
 * Fetches the full spec from the registry and merges with registry source
 * information.
 *
 * @param slug - The app slug to look up
 * @returns Detailed app information including full spec
 * @throws Error if the slug is not found in any registry
 */
export async function getAppDetail(slug: string): Promise<StoreAppDetail> {
  ensureInitialized()

  // Find the entry in the merged index
  const entries = await getIndex()
  const entry = entries.find(e => e.slug === slug)
  if (!entry) {
    throw new Error(`App not found in store: ${slug}`)
  }

  // Resolve the registry ID for this entry
  const registryId = resolveRegistryId(entry)

  // Fetch the full spec
  const spec = await fetchSpec(entry, registryId)

  return {
    entry,
    spec,
    registryId,
  }
}

// ============================================
// Installation
// ============================================

/**
 * Install an app from the store into a specific space.
 *
 * Fetches the full spec, applies user configuration, and delegates
 * to the App Manager for installation and runtime activation.
 *
 * @param slug - The app slug to install
 * @param spaceId - The target space ID
 * @param userConfig - Optional user configuration values
 * @returns The installed app ID
 */
export async function installFromStore(
  slug: string,
  spaceId: string,
  userConfig?: Record<string, unknown>
): Promise<string> {
  ensureInitialized()

  // Find the entry
  const entries = await getIndex()
  const entry = entries.find(e => e.slug === slug)
  if (!entry) {
    throw new Error(`App not found in store: ${slug}`)
  }

  if (!isBundleFormat(entry)) {
    throw new Error(
      `This app uses legacy package format "${String(entry.format)}". Bundle packages are required in this build.`
    )
  }

  // Resolve the registry ID for this entry
  const registryId = resolveRegistryId(entry)

  // Fetch the full spec
  const spec = await fetchSpec(entry, registryId)

  // Ensure store metadata includes slug for update tracking.
  // Merge with any existing store metadata from the spec YAML, preserving
  // category/tags/locale etc. Only add fields that StoreMetadataSchema allows.
  const specWithStore = withInstallStoreMetadata(spec, entry.slug, registryId)

  // Delegate to App Manager
  const manager = getAppManager()
  if (!manager) {
    throw new Error('App Manager is not yet initialized')
  }

  const appId = await manager.install(spaceId, specWithStore, userConfig)

  // Auto-activate in runtime if available
  const runtime = getAppRuntime()
  if (runtime) {
    try {
      await runtime.activate(appId)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.warn(`[RegistryService] installFromStore: runtime activate failed (non-fatal): ${errMsg}`)
    }
  }

  console.log(`[RegistryService] Installed "${entry.name}" (${slug}) as ${appId} in space ${spaceId}`)
  return appId
}

// ============================================
// Updates
// ============================================

/**
 * Check for available updates for installed apps.
 *
 * Compares installed app versions with the latest versions in the registry.
 * Only checks apps that have store metadata (slug) from a prior store install.
 *
 * @param installedApps - List of installed apps to check
 * @returns List of available updates
 */
export async function checkUpdates(
  installedApps: Array<{
    id: string
    spec: { name: string; version: string; store?: { slug?: string; registry_id?: string } }
  }>
): Promise<UpdateInfo[]> {
  ensureInitialized()

  const mergedEntries = await getIndex()
  const updates: UpdateInfo[] = []
  const registryEntriesCache = new Map<string, RegistryEntry[]>()

  const getEntriesForRegistry = async (registryId: string): Promise<RegistryEntry[]> => {
    if (registryEntriesCache.has(registryId)) {
      return registryEntriesCache.get(registryId) ?? []
    }

    const registry = config.registries.find(r => r.id === registryId && r.enabled)
    if (!registry) {
      registryEntriesCache.set(registryId, [])
      return []
    }

    const index = await loadIndexForRegistry(registry)
    const entries = (index?.apps ?? []).filter(isBundleFormat)
    registryEntriesCache.set(registryId, entries)
    return entries
  }

  for (const app of installedApps) {
    const slug = app.spec.store?.slug
    if (!slug) continue

    const preferredRegistryId = app.spec.store?.registry_id
    let entry: RegistryEntry | undefined

    if (preferredRegistryId) {
      const preferredEntries = await getEntriesForRegistry(preferredRegistryId)
      entry = preferredEntries.find(e => e.slug === slug)
    } else {
      entry = mergedEntries.find(e => e.slug === slug)
    }

    if (!entry) continue

    // Only report if registry has a newer version (not just different)
    if (isNewerVersion(entry.version, app.spec.version)) {
      updates.push({
        appId: app.id,
        currentVersion: app.spec.version,
        latestVersion: entry.version,
        entry,
      })
    }
  }

  return updates
}

// ============================================
// Registry Source Management
// ============================================

/**
 * Get the list of configured registry sources.
 */
export function getRegistries(): RegistrySource[] {
  ensureInitialized()
  return [...config.registries]
}

/**
 * Add a new registry source.
 *
 * @param registry - Registry source without ID (ID is auto-generated)
 * @returns The created registry source with assigned ID
 */
export function addRegistry(registry: Omit<RegistrySource, 'id'>): RegistrySource {
  ensureInitialized()

  const normalizedUrl = normalizeRegistryUrl(registry.url)
  if (!isHttpUrl(normalizedUrl)) {
    throw new Error('Registry URL must use http:// or https://')
  }

  const duplicate = config.registries.find(
    r => normalizeRegistryUrl(r.url) === normalizedUrl
  )
  if (duplicate) {
    throw new Error(`Registry already exists: ${duplicate.name}`)
  }

  const newRegistry: RegistrySource = {
    ...registry,
    id: uuidv4(),
    url: normalizedUrl,
    isDefault: false,
  }

  config.registries.push(newRegistry)
  saveConfigToFile()

  console.log(`[RegistryService] Added registry: "${newRegistry.name}" (${newRegistry.id})`)
  return newRegistry
}

/**
 * Remove a registry source by ID.
 *
 * @param registryId - The registry ID to remove
 * @throws Error if attempting to remove the default registry
 */
export function removeRegistry(registryId: string): void {
  ensureInitialized()

  const registry = config.registries.find(r => r.id === registryId)
  if (!registry) {
    throw new Error(`Registry not found: ${registryId}`)
  }
  if (isDefaultRegistry(registry)) {
    throw new Error('Cannot remove the default registry')
  }

  config.registries = config.registries.filter(r => r.id !== registryId)
  indexCache.delete(registryId)
  clearCache(registryId)
  saveConfigToFile()

  console.log(`[RegistryService] Removed registry: "${registry.name}" (${registryId})`)
}

/**
 * Enable or disable a registry source.
 *
 * @param registryId - The registry ID to toggle
 * @param enabled - Whether the registry should be enabled
 */
export function toggleRegistry(registryId: string, enabled: boolean): void {
  ensureInitialized()

  const registry = config.registries.find(r => r.id === registryId)
  if (!registry) {
    throw new Error(`Registry not found: ${registryId}`)
  }

  registry.enabled = enabled
  saveConfigToFile()

  console.log(`[RegistryService] Registry "${registry.name}" ${enabled ? 'enabled' : 'disabled'}`)
}

// ============================================
// Config Persistence
// ============================================

/**
 * Load registry service configuration from the main HaloConfig.
 * Returns defaults if no configuration exists.
 */
export function loadConfig(): RegistryServiceConfig {
  try {
    const haloConfig = getConfig()
    const storeConfig = (haloConfig as Record<string, unknown>)[CONFIG_KEY] as Record<string, unknown> | undefined

    if (!storeConfig) {
      return {
        registries: [DEFAULT_REGISTRY],
        cacheTtlMs: DEFAULT_CACHE_TTL_MS,
        autoCheckUpdates: true,
      }
    }

    return {
      registries: normalizeRegistries(
        Array.isArray(storeConfig.registries)
          ? (storeConfig.registries as RegistrySource[])
          : [DEFAULT_REGISTRY]
      ),
      cacheTtlMs: normalizeCacheTtl(
        typeof storeConfig.cacheTtlMs === 'number'
          ? storeConfig.cacheTtlMs
          : DEFAULT_CACHE_TTL_MS
      ),
      autoCheckUpdates: typeof storeConfig.autoCheckUpdates === 'boolean'
        ? storeConfig.autoCheckUpdates
        : true,
    }
  } catch (error) {
    console.error('[RegistryService] Failed to load config, using defaults:', error)
    return {
      registries: [DEFAULT_REGISTRY],
      cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      autoCheckUpdates: true,
    }
  }
}

/**
 * Persist the current registry service configuration to the main HaloConfig.
 */
export function saveConfig(): void {
  saveConfigToFile()
}

// ============================================
// Internal Helpers
// ============================================

/**
 * Compare two version strings to determine if `latest` is newer than `current`.
 * Supports SemVer core numbers and falls back to numeric dot-segment comparison.
 *
 * @returns true if latest > current
 */
function isNewerVersion(latest: string, current: string): boolean {
  if (latest === current) return false

  const parsedLatest = parseSemver(latest)
  const parsedCurrent = parseSemver(current)
  if (parsedLatest && parsedCurrent) {
    for (let i = 0; i < 3; i++) {
      if (parsedLatest[i] > parsedCurrent[i]) return true
      if (parsedLatest[i] < parsedCurrent[i]) return false
    }
    return false
  }

  const l = parseNumericDotVersion(latest)
  const c = parseNumericDotVersion(current)
  const len = Math.max(l.length, c.length)

  for (let i = 0; i < len; i++) {
    const lv = l[i] ?? 0
    const cv = c[i] ?? 0
    if (lv > cv) return true
    if (lv < cv) return false
  }

  return false
}

function parseSemver(version: string): [number, number, number] | null {
  const match = version.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function parseNumericDotVersion(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((segment) => {
      const numeric = segment.match(/^(\d+)/)
      return numeric ? Number(numeric[1]) : 0
    })
}

function normalizeCacheTtl(cacheTtlMs: number): number {
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0) {
    return DEFAULT_CACHE_TTL_MS
  }
  return Math.floor(cacheTtlMs)
}

function normalizeRegistries(registries: RegistrySource[]): RegistrySource[] {
  const result: RegistrySource[] = []
  const seenIds = new Set<string>()
  const seenUrls = new Set<string>()

  for (const registry of registries) {
    const parsed = RegistrySourceSchema.safeParse(registry)
    if (!parsed.success) {
      continue
    }

    const normalizedUrl = normalizeRegistryUrl(parsed.data.url)
    if (!isHttpUrl(normalizedUrl)) {
      continue
    }

    const normalized: RegistrySource = {
      ...parsed.data,
      url: normalizedUrl,
    }

    if (seenIds.has(normalized.id) || seenUrls.has(normalized.url)) {
      continue
    }

    seenIds.add(normalized.id)
    seenUrls.add(normalized.url)
    result.push(normalized)
  }

  return result
}

function normalizeRegistryUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function isDefaultRegistry(registry: RegistrySource): boolean {
  return registry.id === DEFAULT_REGISTRY.id || registry.isDefault === true
}

function ensureDefaultRegistry(): boolean {
  const official = config.registries.find((registry) => registry.id === DEFAULT_REGISTRY.id)
  if (official) {
    let changed = false
    const wasEnabled = official.enabled
    const wasName = official.name
    const wasUrl = official.url
    const wasDefault = official.isDefault

    official.id = DEFAULT_REGISTRY.id
    official.name = DEFAULT_REGISTRY.name
    official.url = DEFAULT_REGISTRY.url
    official.isDefault = true
    official.enabled = official.enabled !== false

    if (wasEnabled !== official.enabled || wasName !== official.name || wasUrl !== official.url || wasDefault !== official.isDefault) {
      changed = true
    }

    for (const registry of config.registries) {
      if (registry !== official && registry.isDefault) {
        registry.isDefault = false
        changed = true
      }
    }

    const officialIndex = config.registries.indexOf(official)
    if (officialIndex > 0) {
      config.registries.splice(officialIndex, 1)
      config.registries.unshift(official)
      changed = true
    }

    return changed
  }

  const markedDefault = config.registries.find((registry) => registry.isDefault)
  if (!markedDefault) {
    config.registries.unshift({ ...DEFAULT_REGISTRY })
    return true
  }

  let changed = false
  const wasId = markedDefault.id
  const wasName = markedDefault.name
  const wasUrl = markedDefault.url
  const wasEnabled = markedDefault.enabled

  markedDefault.isDefault = true
  markedDefault.id = DEFAULT_REGISTRY.id
  markedDefault.name = DEFAULT_REGISTRY.name
  markedDefault.url = DEFAULT_REGISTRY.url
  markedDefault.enabled = markedDefault.enabled !== false

  if (
    wasId !== markedDefault.id
    || wasName !== markedDefault.name
    || wasUrl !== markedDefault.url
    || wasEnabled !== markedDefault.enabled
  ) {
    changed = true
  }

  for (const registry of config.registries) {
    if (registry !== markedDefault && registry.isDefault) {
      registry.isDefault = false
      changed = true
    }
  }

  const markedIndex = config.registries.indexOf(markedDefault)
  if (markedIndex > 0) {
    config.registries.splice(markedIndex, 1)
    config.registries.unshift(markedDefault)
    changed = true
  }

  return changed
}

function withInstallStoreMetadata(spec: AppSpec, slug: string, registryId: string): AppSpec {
  return {
    ...spec,
    store: {
      ...(spec.store ?? {}),
      slug: spec.store?.slug ?? slug,
      registry_id: registryId,
    },
  }
}

/**
 * Ensure the service has been initialized before use.
 * @throws Error if not initialized
 */
function ensureInitialized(): void {
  if (!initialized) {
    initRegistryService()
  }
}

/**
 * Persist current config to the HaloConfig file.
 */
function saveConfigToFile(): void {
  try {
    saveHaloConfig({
      [CONFIG_KEY]: {
        registries: config.registries,
        cacheTtlMs: config.cacheTtlMs,
        autoCheckUpdates: config.autoCheckUpdates,
      },
    })
  } catch (error) {
    console.error('[RegistryService] Failed to save config:', error)
  }
}

/**
 * Get a valid (within TTL) cached index for a registry.
 * Checks in-memory first, then disk.
 */
function getValidCachedIndex(registryId: string): CachedIndex | null {
  const now = Date.now()

  // Check in-memory cache first
  const memCached = indexCache.get(registryId)
  if (memCached && (now - memCached.fetchedAt) < config.cacheTtlMs) {
    return memCached
  }

  // Check disk cache
  const diskCached = readCachedIndex(registryId)
  if (diskCached && (now - diskCached.fetchedAt) < config.cacheTtlMs) {
    // Populate in-memory cache
    indexCache.set(registryId, diskCached)
    return diskCached
  }

  return null
}

async function loadIndexForRegistry(registry: RegistrySource): Promise<RegistryIndex | null> {
  const cached = getValidCachedIndex(registry.id)
  if (cached) {
    return cached.index
  }

  // Try to fetch, fallback to stale cache on failure
  try {
    return await fetchAndCacheIndex(registry)
  } catch {
    // Try stale disk cache (ignoring TTL)
    const stale = readCachedIndex(registry.id)
    if (stale) {
      console.log(`[RegistryService] Using stale cache for "${registry.name}"`)
      // Update in-memory cache with stale data so repeated calls don't re-fetch
      indexCache.set(registry.id, stale)
      return stale.index
    }
    return null
  }
}

/**
 * Fetch the index.json from a registry and update caches.
 *
 * @param registry - The registry source to fetch from
 * @returns The parsed RegistryIndex
 * @throws Error on network failure or invalid response
 */
async function fetchAndCacheIndex(registry: RegistrySource): Promise<RegistryIndex> {
  const url = `${registry.url.replace(/\/+$/, '')}/index.json`

  console.log(`[RegistryService] Fetching index from "${registry.name}": ${url}`)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Halo-Store/1.0',
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = await response.json() as unknown
    const parsed = RegistryIndexSchema.safeParse(data)
    if (!parsed.success) {
      throw new Error(
        `Invalid index format: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ') || 'schema mismatch'}`
      )
    }

    const index: RegistryIndex = parsed.data

    const duplicateSlugs = findDuplicateSlugs(index.apps)
    if (duplicateSlugs.length > 0) {
      throw new Error(`Invalid index: duplicate slug(s): ${duplicateSlugs.join(', ')}`)
    }

    // Update caches
    const cached: CachedIndex = {
      index,
      fetchedAt: Date.now(),
      registryId: registry.id,
    }
    indexCache.set(registry.id, cached)
    writeCachedIndex(registry.id, index)

    console.log(`[RegistryService] Fetched index from "${registry.name}": ${index.apps.length} apps`)
    return index
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Resolve the registry ID for a given entry.
 * Uses the slug-to-registry mapping populated during getIndex().
 * Falls back to 'official' if no mapping is found.
 */
function resolveRegistryId(entry: RegistryEntry): string {
  const mapped = slugToRegistryMap.get(entry.slug)
  if (mapped) return mapped

  const defaultRegistry = config.registries.find(isDefaultRegistry)
  return defaultRegistry?.id ?? DEFAULT_REGISTRY.id
}

/**
 * Fetch and parse a spec file for a registry entry.
 *
 * Checks the disk cache first. On cache miss, fetches from the registry,
 * parses YAML, validates against AppSpecSchema, and caches the result.
 *
 * @param entry - The registry entry to fetch the spec for
 * @param registryId - The registry ID this entry belongs to
 * @returns The parsed and validated AppSpec
 * @throws Error on network failure, parse error, or validation failure
 */
async function fetchSpec(entry: RegistryEntry, registryId: string): Promise<AppSpec> {
  // Check disk cache first
  const cached = readCachedSpec(registryId, entry.slug)
  if (
    cached &&
    (Date.now() - cached.fetchedAt) < config.cacheTtlMs &&
    cached.spec.version === entry.version &&
    cached.spec.type === entry.type &&
    (!cached.spec.store?.slug || cached.spec.store.slug === entry.slug)
  ) {
    return withInstallStoreMetadata(cached.spec, entry.slug, registryId)
  }

  // Find the registry URL
  const registry = config.registries.find(r => r.id === registryId)
  if (!registry) {
    throw new Error(`Registry not found for entry: ${entry.slug}`)
  }

  // Bundle packages are directory-based; the install spec is always {path}/spec.yaml.
  const specPath = `${entry.path}/spec.yaml`
  const specUrl = entry.download_url || `${registry.url.replace(/\/+$/, '')}/${specPath}`

  console.log(`[RegistryService] Fetching spec for "${entry.slug}" from: ${specUrl}`)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(specUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Halo-Store/1.0',
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const text = await response.text()

    // Parse as YAML (which also handles plain JSON)
    const raw = parseYaml(text)

    // Validate against AppSpecSchema
    const parsedSpec = AppSpecSchema.parse(raw)

    if (parsedSpec.type !== entry.type) {
      throw new Error(
        `Spec type mismatch for "${entry.slug}": index=${entry.type}, spec=${parsedSpec.type}`
      )
    }
    if (parsedSpec.store?.slug && parsedSpec.store.slug !== entry.slug) {
      throw new Error(
        `Spec slug mismatch for "${entry.slug}": index=${entry.slug}, spec=${parsedSpec.store.slug}`
      )
    }

    const spec = withInstallStoreMetadata(parsedSpec, entry.slug, registryId)

    // Cache the validated spec
    writeCachedSpec(registryId, entry.slug, spec)

    return spec
  } finally {
    clearTimeout(timeout)
  }
}

function findDuplicateSlugs(entries: RegistryEntry[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()

  for (const entry of entries) {
    if (seen.has(entry.slug)) {
      duplicates.add(entry.slug)
    } else {
      seen.add(entry.slug)
    }
  }

  return [...duplicates]
}

function isBundleFormat(entry: { format?: string }): entry is { format: 'bundle' } {
  return entry.format === 'bundle'
}
