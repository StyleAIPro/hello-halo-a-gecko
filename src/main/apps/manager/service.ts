/**
 * apps/manager -- Service Implementation
 *
 * Implements the AppManagerService interface with:
 * - State machine enforcement for status transitions
 * - Work directory creation on install
 * - Event notification on status changes
 * - Delegation to AppManagerStore for persistence
 *
 * This is the single implementation class. It is created by initAppManager()
 * in index.ts and returned as the AppManagerService interface.
 */

import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { v4 as uuidv4 } from 'uuid'

import type { AppSpec } from '../spec'
import { validateAppSpec } from '../spec'
import type {
  AppManagerService,
  InstalledApp,
  AppStatus,
  RunOutcome,
  AppListFilter,
  StatusChangeHandler,
  Unsubscribe,
  UninstallOptions,
} from './types'
import { AppManagerStore } from './store'
import {
  AppNotFoundError,
  AppAlreadyInstalledError,
  InvalidStatusTransitionError,
  SpaceNotFoundError,
} from './errors'

// ============================================
// State Machine
// ============================================

/**
 * Defines which status transitions are legal.
 *
 * Key: current status
 * Value: set of statuses that can be transitioned TO
 */
const VALID_TRANSITIONS: Record<AppStatus, ReadonlySet<AppStatus>> = {
  active: new Set<AppStatus>(['paused', 'error', 'needs_login', 'waiting_user', 'uninstalled']),
  paused: new Set<AppStatus>(['active', 'uninstalled']),
  error: new Set<AppStatus>(['active', 'paused', 'uninstalled']),
  needs_login: new Set<AppStatus>(['active', 'paused', 'uninstalled']),
  waiting_user: new Set<AppStatus>(['active', 'paused', 'error', 'uninstalled']),
  uninstalled: new Set<AppStatus>(['active']),
}

/**
 * Check if a status transition is legal according to the state machine.
 */
function isValidTransition(from: AppStatus, to: AppStatus): boolean {
  return VALID_TRANSITIONS[from]?.has(to) ?? false
}

// ============================================
// Service Implementation
// ============================================

/** Dependencies injected from the outside */
export interface AppManagerDeps {
  /** SQLite store for installed_apps CRUD */
  store: AppManagerStore

  /**
   * Resolve a space ID to its filesystem path.
   * Returns null if the space does not exist.
   */
  getSpacePath: (spaceId: string) => string | null
}

/**
 * Create the AppManagerService implementation.
 *
 * @param deps - Injected dependencies
 * @returns A fully functional AppManagerService
 */
export function createAppManagerService(deps: AppManagerDeps): AppManagerService {
  const { store, getSpacePath } = deps

  // Status change event listeners
  const statusChangeHandlers: StatusChangeHandler[] = []

  /**
   * Notify all registered status change handlers.
   * Errors in handlers are caught and logged (do not propagate).
   */
  function notifyStatusChange(appId: string, oldStatus: AppStatus, newStatus: AppStatus): void {
    for (const handler of statusChangeHandlers) {
      try {
        handler(appId, oldStatus, newStatus)
      } catch (error) {
        console.error('[AppManager] Status change handler error:', error)
      }
    }
  }

  /**
   * Get an App or throw if not found.
   * Internal helper used by most methods.
   */
  function requireApp(appId: string): InstalledApp {
    const app = store.getById(appId)
    if (!app) {
      throw new AppNotFoundError(appId)
    }
    return app
  }

  /**
   * Resolve the work directory path for an App.
   * Format: {spacePath}/apps/{appId}/
   */
  function resolveWorkDir(spacePath: string, appId: string): string {
    return join(spacePath, 'apps', appId)
  }

  /**
   * Ensure a directory exists, creating it recursively if needed.
   */
  function ensureDir(dirPath: string): void {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true })
    }
  }

  // ── Service Interface Implementation ─────────

  const service: AppManagerService = {
    // ── Installation ──────────────────────────

    async install(
      spaceId: string,
      spec: AppSpec,
      userConfig?: Record<string, unknown>
    ): Promise<string> {
      // Validate space exists
      const spacePath = getSpacePath(spaceId)
      if (!spacePath) {
        throw new SpaceNotFoundError(spaceId)
      }

      // Validate spec before any DB operations
      validateAppSpec(spec)

      // Check for duplicate installation
      const specId = spec.name // Use spec name as the canonical spec identifier
      const existing = store.getBySpecAndSpace(specId, spaceId)
      if (existing) {
        throw new AppAlreadyInstalledError(specId, spaceId)
      }

      // Generate unique ID
      const appId = uuidv4()

      // Build the InstalledApp record
      const app: InstalledApp = {
        id: appId,
        specId,
        spaceId,
        spec,
        status: 'active',
        userConfig: userConfig ?? {},
        userOverrides: {},
        permissions: {
          granted: [],
          denied: [],
        },
        installedAt: Date.now(),
      }

      // Persist to SQLite first (atomic: if this fails, no filesystem side effects).
      // Catch UNIQUE constraint violations from concurrent installs and convert to
      // the domain error, so callers receive AppAlreadyInstalledError regardless of
      // whether the duplicate was detected by the pre-check or by the DB constraint.
      try {
        store.insert(app)
      } catch (dbError: unknown) {
        const sqliteCode = (dbError as { code?: string })?.code
        if (sqliteCode === 'SQLITE_CONSTRAINT_UNIQUE' || sqliteCode === 'SQLITE_CONSTRAINT') {
          throw new AppAlreadyInstalledError(specId, spaceId)
        }
        throw dbError
      }

      // Create work directories after the DB record is committed.
      // If directory creation fails, roll back the DB record to avoid orphaned rows.
      const workDir = resolveWorkDir(spacePath, appId)
      const memoryDir = join(workDir, 'memory')

      try {
        ensureDir(workDir)
        ensureDir(memoryDir)
      } catch (dirError) {
        // Roll back the DB record to keep the install atomic
        try { store.delete(appId) } catch { /* best-effort rollback */ }
        throw dirError
      }

      console.log(
        `[AppManager] Installed app '${spec.name}' (${appId}) in space ${spaceId}`
      )

      return appId
    },

    async uninstall(appId: string, _options?: UninstallOptions): Promise<void> {
      const app = requireApp(appId)

      // Soft-delete: transition to 'uninstalled' status and record timestamp
      const oldStatus = app.status
      const newStatus: AppStatus = 'uninstalled'

      if (!isValidTransition(oldStatus, newStatus)) {
        throw new InvalidStatusTransitionError(appId, oldStatus, newStatus)
      }

      store.updateStatus(appId, newStatus, null, null)
      store.updateUninstalledAt(appId, Date.now())
      notifyStatusChange(appId, oldStatus, newStatus)

      console.log(
        `[AppManager] Soft-deleted app ${appId} (was: ${oldStatus})`
      )
    },

    reinstall(appId: string): void {
      const app = requireApp(appId)
      const oldStatus = app.status
      const newStatus: AppStatus = 'active'

      if (oldStatus !== 'uninstalled') {
        throw new InvalidStatusTransitionError(appId, oldStatus, newStatus)
      }

      store.updateStatus(appId, newStatus, null, null)
      store.updateUninstalledAt(appId, null)
      notifyStatusChange(appId, oldStatus, newStatus)

      console.log(`[AppManager] Reinstalled app ${appId}`)
    },

    async deleteApp(appId: string): Promise<void> {
      const app = requireApp(appId)

      if (app.status !== 'uninstalled') {
        throw new InvalidStatusTransitionError(
          appId,
          app.status,
          'uninstalled' as AppStatus,
          'App must be uninstalled before permanent deletion'
        )
      }

      // Hard-delete the database record
      store.delete(appId)

      // Purge the work directory
      const spacePath = getSpacePath(app.spaceId)
      if (spacePath) {
        const workDir = resolveWorkDir(spacePath, appId)
        if (existsSync(workDir)) {
          try {
            rmSync(workDir, { recursive: true, force: true })
            console.log(`[AppManager] Purged work directory: ${workDir}`)
          } catch (error) {
            console.error(`[AppManager] Failed to purge work directory ${workDir}:`, error)
          }
        }
      }

      console.log(`[AppManager] Permanently deleted app ${appId}`)
    },

    // ── Status Management ─────────────────────

    pause(appId: string): void {
      const app = requireApp(appId)
      const oldStatus = app.status
      const newStatus: AppStatus = 'paused'

      if (!isValidTransition(oldStatus, newStatus)) {
        throw new InvalidStatusTransitionError(appId, oldStatus, newStatus)
      }

      store.updateStatus(appId, newStatus, null, null)
      notifyStatusChange(appId, oldStatus, newStatus)

      console.log(`[AppManager] App ${appId}: ${oldStatus} -> ${newStatus}`)
    },

    resume(appId: string): void {
      const app = requireApp(appId)
      const oldStatus = app.status
      const newStatus: AppStatus = 'active'

      if (!isValidTransition(oldStatus, newStatus)) {
        throw new InvalidStatusTransitionError(appId, oldStatus, newStatus)
      }

      // Clear error-related fields on resume
      store.updateStatus(appId, newStatus, null, null)
      notifyStatusChange(appId, oldStatus, newStatus)

      console.log(`[AppManager] App ${appId}: ${oldStatus} -> ${newStatus}`)
    },

    updateStatus(
      appId: string,
      status: AppStatus,
      extra?: { errorMessage?: string; pendingEscalationId?: string }
    ): void {
      const app = requireApp(appId)
      const oldStatus = app.status

      if (oldStatus === status) {
        // No-op: already in the target status.
        // Still update extra fields if provided.
        store.updateStatus(
          appId,
          status,
          extra?.pendingEscalationId ?? app.pendingEscalationId ?? null,
          extra?.errorMessage ?? app.errorMessage ?? null
        )
        return
      }

      if (!isValidTransition(oldStatus, status)) {
        throw new InvalidStatusTransitionError(appId, oldStatus, status)
      }

      store.updateStatus(
        appId,
        status,
        extra?.pendingEscalationId ?? null,
        extra?.errorMessage ?? null
      )

      notifyStatusChange(appId, oldStatus, status)

      console.log(`[AppManager] App ${appId}: ${oldStatus} -> ${status}`)
    },

    // ── Configuration ─────────────────────────

    updateConfig(appId: string, config: Record<string, unknown>): void {
      requireApp(appId) // Throws if not found
      store.updateConfig(appId, config)
    },

    updateFrequency(appId: string, subscriptionId: string, frequency: string): void {
      const app = requireApp(appId)
      const overrides = { ...app.userOverrides }
      if (!overrides.frequency) {
        overrides.frequency = {}
      }
      overrides.frequency[subscriptionId] = frequency
      store.updateOverrides(appId, overrides)
    },

    updateOverrides(appId: string, partial: Partial<InstalledApp['userOverrides']>): void {
      const app = requireApp(appId)
      const merged = { ...app.userOverrides, ...partial }
      store.updateOverrides(appId, merged)
    },

    updateSpec(appId: string, specPatch: Record<string, unknown>): void {
      const app = requireApp(appId)

      // JSON Merge Patch: merge top-level fields, null = delete
      const currentSpec = app.spec as unknown as Record<string, unknown>
      const merged: Record<string, unknown> = { ...currentSpec }

      for (const [key, value] of Object.entries(specPatch)) {
        if (value === null) {
          delete merged[key]
        } else {
          merged[key] = value
        }
      }

      // Re-validate the merged spec through Zod
      const validatedSpec = validateAppSpec(merged)

      // Persist
      store.updateSpec(appId, validatedSpec)

      console.log(`[AppManager] Updated spec for app ${appId}`)
    },

    // ── Run Tracking ──────────────────────────

    updateLastRun(appId: string, outcome: RunOutcome, errorMessage?: string): void {
      requireApp(appId) // Throws if not found
      store.updateLastRun(appId, Date.now(), outcome, errorMessage ?? null)
    },

    // ── Queries ───────────────────────────────

    getApp(appId: string): InstalledApp | null {
      return store.getById(appId)
    },

    listApps(filter?: AppListFilter): InstalledApp[] {
      return store.list(filter)
    },

    // ── Permissions ───────────────────────────

    grantPermission(appId: string, permission: string): void {
      const app = requireApp(appId)
      const permissions = { ...app.permissions }

      // Add to granted if not already there
      if (!permissions.granted.includes(permission)) {
        permissions.granted = [...permissions.granted, permission]
      }

      // Remove from denied if present
      permissions.denied = permissions.denied.filter(p => p !== permission)

      store.updatePermissions(appId, permissions)
    },

    revokePermission(appId: string, permission: string): void {
      const app = requireApp(appId)
      const permissions = { ...app.permissions }

      // Remove from granted
      permissions.granted = permissions.granted.filter(p => p !== permission)

      // Add to denied if not already there
      if (!permissions.denied.includes(permission)) {
        permissions.denied = [...permissions.denied, permission]
      }

      store.updatePermissions(appId, permissions)
    },

    // ── File System ───────────────────────────

    getAppWorkDir(appId: string): string {
      const app = requireApp(appId)
      const spacePath = getSpacePath(app.spaceId)

      if (!spacePath) {
        throw new SpaceNotFoundError(app.spaceId)
      }

      const workDir = resolveWorkDir(spacePath, appId)

      // Auto-create if missing (contract: returned path always exists)
      ensureDir(workDir)

      // Also ensure the memory subdirectory exists
      ensureDir(join(workDir, 'memory'))

      return workDir
    },

    // ── Events ────────────────────────────────

    onAppStatusChange(handler: StatusChangeHandler): Unsubscribe {
      statusChangeHandlers.push(handler)

      return () => {
        const index = statusChangeHandlers.indexOf(handler)
        if (index > -1) {
          statusChangeHandlers.splice(index, 1)
        }
      }
    },
  }

  return service
}
