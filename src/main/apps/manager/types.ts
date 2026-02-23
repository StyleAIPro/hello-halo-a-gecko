/**
 * apps/manager -- Type Definitions
 *
 * Public types for the App lifecycle management layer.
 * Consumed by apps/runtime, IPC handlers, and renderer (via shared types).
 */

import type { AppSpec, AppType } from '../spec'

// ============================================
// App Status
// ============================================

/**
 * Runtime status of an installed App.
 *
 * - active:        Running normally (automation) or available for use (mcp/skill)
 * - paused:        User manually paused; subscriptions inactive
 * - error:         Consecutive failures hit threshold; auto-disabled
 * - needs_login:   AI Browser detected expired login session
 * - waiting_user:  AI triggered escalation; awaiting user decision
 * - uninstalled:   Soft-deleted; hidden from default views, can be reinstalled or permanently deleted
 */
export type AppStatus = 'active' | 'paused' | 'error' | 'needs_login' | 'waiting_user' | 'uninstalled'

/**
 * Outcome of a single App execution run.
 * Matches the scheduler's RunOutcome type.
 */
export type RunOutcome = 'useful' | 'noop' | 'error' | 'skipped'

// ============================================
// Installed App
// ============================================

/**
 * Full representation of an installed App instance.
 *
 * Each installed App has a unique `id` (UUID), belongs to a specific `spaceId`,
 * and stores a snapshot of the AppSpec at install time plus user configuration.
 */
export interface InstalledApp {
  /** Unique installation ID (UUID v4) */
  id: string

  /** App specification identifier (from spec.name or a registry ID) */
  specId: string

  /** Space this App is installed in */
  spaceId: string

  /** Full AppSpec (initially set at install time, updatable via updateSpec) */
  spec: AppSpec

  /** Current runtime status */
  status: AppStatus

  /**
   * Opaque escalation ID set when status is 'waiting_user'.
   * Points to an activity_entries record (managed by apps/runtime).
   * No FK constraint -- decoupled from runtime schema.
   */
  pendingEscalationId?: string

  /** User-provided configuration values (corresponds to spec.config_schema) */
  userConfig: Record<string, unknown>

  /** User overrides for subscription frequencies and other tunable settings */
  userOverrides: {
    frequency?: Record<string, string>  // subscriptionId -> frequency string
    /** Notification level: 'all' | 'important' | 'none'. Defaults to 'important'. */
    notificationLevel?: 'all' | 'important' | 'none'
    /** Override AI source for this App. When set, uses this source instead of the global one. */
    modelSourceId?: string
    /** Override model within the selected AI source. Used together with modelSourceId. */
    modelId?: string
  }

  /** Permission grants and denials */
  permissions: {
    granted: string[]
    denied: string[]
  }

  /** Unix timestamp (ms) when the App was installed */
  installedAt: number

  /** Unix timestamp (ms) of the last execution run */
  lastRunAt?: number

  /** Outcome of the last execution run */
  lastRunOutcome?: RunOutcome

  /** Error message from the last failed run or status change */
  errorMessage?: string

  /** Unix timestamp (ms) when the App was soft-deleted (uninstalled). Undefined if active. */
  uninstalledAt?: number
}

// ============================================
// Service Interface
// ============================================

/** Filter criteria for listApps() */
export interface AppListFilter {
  spaceId?: string
  status?: AppStatus
  type?: AppType
}

/** Callback signature for status change notifications */
export type StatusChangeHandler = (appId: string, oldStatus: AppStatus, newStatus: AppStatus) => void

/** Unsubscribe function returned by event registration */
export type Unsubscribe = () => void

/** Options for the uninstall operation */
export interface UninstallOptions {
  /** If true, delete the App's work directory. Default: false (preserve data). */
  purge?: boolean
}

/**
 * App Manager Service -- lifecycle management for installed Apps.
 *
 * This is the public API consumed by apps/runtime and IPC handlers.
 * All mutations are persisted to SQLite immediately.
 */
export interface AppManagerService {
  // ── Installation ────────────────────────────────

  /**
   * Install an App into a space.
   *
   * Creates the App record in SQLite, generates a UUID, creates the work directory
   * at `{space.path}/apps/{appId}/` and `{space.path}/apps/{appId}/memory/`.
   *
   * @param spaceId - Target space ID
   * @param spec - Validated AppSpec
   * @param userConfig - User-provided config values (optional)
   * @returns The generated App ID (UUID)
   * @throws AppAlreadyInstalledError if same specId+spaceId combination exists
   */
  install(spaceId: string, spec: AppSpec, userConfig?: Record<string, unknown>): Promise<string>

  /**
   * Uninstall an App (soft-delete).
   *
   * Sets the App status to 'uninstalled' and records uninstalled_at timestamp.
   * The App remains in the database and can be reinstalled or permanently deleted.
   *
   * @throws AppNotFoundError if the App does not exist
   */
  uninstall(appId: string, options?: UninstallOptions): Promise<void>

  /**
   * Reinstall a previously uninstalled App.
   *
   * Transitions the App from 'uninstalled' back to 'active' and clears uninstalled_at.
   *
   * @throws AppNotFoundError if the App does not exist
   * @throws InvalidStatusTransitionError if the App is not in 'uninstalled' status
   */
  reinstall(appId: string): void

  /**
   * Permanently delete an uninstalled App from the database.
   *
   * Only allowed when the App is in 'uninstalled' status. Removes the record
   * from SQLite and optionally purges the work directory.
   *
   * @throws AppNotFoundError if the App does not exist
   * @throws InvalidStatusTransitionError if the App is not in 'uninstalled' status
   */
  deleteApp(appId: string): Promise<void>

  // ── Status Management ──────────────────────────

  /**
   * Pause an App (user action).
   * Only valid from 'active' status.
   *
   * @throws AppNotFoundError if the App does not exist
   * @throws InvalidStatusTransitionError if current status is not 'active'
   */
  pause(appId: string): void

  /**
   * Resume an App (user action).
   * Valid from 'paused', 'error', or 'needs_login' status.
   *
   * @throws AppNotFoundError if the App does not exist
   * @throws InvalidStatusTransitionError if current status does not allow resume
   */
  resume(appId: string): void

  /**
   * Update App status (runtime action).
   * Used by apps/runtime to set error, needs_login, or waiting_user states.
   * Enforces the state machine -- throws on illegal transitions.
   *
   * @param extra - Optional metadata: errorMessage, pendingEscalationId
   * @throws AppNotFoundError if the App does not exist
   * @throws InvalidStatusTransitionError if the transition is not allowed
   */
  updateStatus(
    appId: string,
    status: AppStatus,
    extra?: { errorMessage?: string; pendingEscalationId?: string }
  ): void

  // ── Configuration ──────────────────────────────

  /**
   * Update user configuration for an App.
   * Replaces the entire userConfig object.
   */
  updateConfig(appId: string, config: Record<string, unknown>): void

  /**
   * Update the user's frequency override for a specific subscription.
   */
  updateFrequency(appId: string, subscriptionId: string, frequency: string): void

  /**
   * Update user overrides for an App (e.g. notificationLevel, model).
   * Merges the provided partial overrides into the existing overrides object.
   */
  updateOverrides(appId: string, overrides: Partial<InstalledApp['userOverrides']>): void

  /**
   * Update the App spec (JSON Merge Patch semantics).
   *
   * Provided fields overwrite existing values. Fields set to `null` are
   * removed from the spec. Omitted fields are preserved.
   *
   * The merged result is re-validated through the AppSpec Zod schema
   * before being persisted, so callers cannot produce invalid specs.
   *
   * @throws AppNotFoundError if the App does not exist
   * @throws AppSpecValidationError if the merged spec is invalid
   */
  updateSpec(appId: string, specPatch: Record<string, unknown>): void

  // ── Run Tracking ───────────────────────────────

  /**
   * Record the result of an App execution run.
   * Called by apps/runtime after each run completes.
   */
  updateLastRun(appId: string, outcome: RunOutcome, errorMessage?: string): void

  // ── Queries ────────────────────────────────────

  /**
   * Get a single installed App by ID.
   * Returns null if not found.
   */
  getApp(appId: string): InstalledApp | null

  /**
   * List installed Apps with optional filtering.
   * Supports filtering by spaceId, status, and App type.
   */
  listApps(filter?: AppListFilter): InstalledApp[]

  // ── Permissions ────────────────────────────────

  /** Grant a permission to an App. */
  grantPermission(appId: string, permission: string): void

  /** Revoke a previously granted permission. */
  revokePermission(appId: string, permission: string): void

  // ── File System ────────────────────────────────

  /**
   * Get the work directory path for an App.
   * Ensures the directory exists (auto-creates if missing).
   *
   * @returns Absolute path to `{space.path}/apps/{appId}/`
   * @throws AppNotFoundError if the App does not exist
   */
  getAppWorkDir(appId: string): string

  // ── Events ─────────────────────────────────────

  /**
   * Register a callback for App status changes.
   * Returns an unsubscribe function.
   */
  onAppStatusChange(handler: StatusChangeHandler): Unsubscribe
}
