/**
 * apps/manager -- Public API
 *
 * App lifecycle management: install, configure, pause, resume, uninstall.
 *
 * This is the data/persistence layer for App management. It does NOT execute
 * Apps, trigger scheduling, or call Agents. Those responsibilities belong
 * to apps/runtime, which consumes this module's AppManagerService interface.
 *
 * Usage in bootstrap/extended.ts:
 *
 *   import { initAppManager } from '../apps/manager'
 *   import type { DatabaseManager } from '../platform/store'
 *
 *   const appManager = await initAppManager({ db })
 *
 * Usage in consuming modules:
 *
 *   import type { AppManagerService, InstalledApp } from '../apps/manager'
 *
 *   function activate(appManager: AppManagerService, appId: string) {
 *     const app = appManager.getApp(appId)
 *     if (!app) throw new Error('App not found')
 *     // ...
 *   }
 */

import type { DatabaseManager } from '../../platform/store'
import { getSpace } from '../../services/space.service'
import { AppManagerStore } from './store'
import { createAppManagerService } from './service'
import { MIGRATION_NAMESPACE, migrations } from './migrations'
import type { AppManagerService } from './types'

// Re-export types for consumers
export type {
  AppManagerService,
  InstalledApp,
  AppStatus,
  RunOutcome,
  AppListFilter,
  StatusChangeHandler,
  Unsubscribe,
  UninstallOptions,
} from './types'

// Re-export error types
export {
  AppNotFoundError,
  AppAlreadyInstalledError,
  InvalidStatusTransitionError,
  SpaceNotFoundError,
} from './errors'

// ============================================
// Module State
// ============================================

let managerInstance: AppManagerService | null = null

/**
 * Get the current App Manager singleton.
 * Returns null if initAppManager() has not yet been called.
 */
export function getAppManager(): AppManagerService | null {
  return managerInstance
}

// ============================================
// Initialization
// ============================================

/** Dependencies required to initialize the App Manager */
interface InitAppManagerDeps {
  /** DatabaseManager from platform/store */
  db: DatabaseManager
}

/**
 * Initialize the App Manager module.
 *
 * 1. Gets the app-level database from DatabaseManager
 * 2. Runs schema migrations (installed_apps table)
 * 3. Creates the store and service instances
 * 4. Returns the AppManagerService interface
 *
 * This function must be called after initStore() and initAppSpec() in the
 * bootstrap sequence (Phase 2 per architecture doc 8B.4).
 *
 * @param deps - Injected dependencies
 * @returns Initialized AppManagerService
 */
export async function initAppManager(
  deps: InitAppManagerDeps
): Promise<AppManagerService> {
  const start = performance.now()
  console.log('[AppManager] Initializing...')

  // Get the app-level database
  const appDb = deps.db.getAppDatabase()

  // Run migrations
  deps.db.runMigrations(appDb, MIGRATION_NAMESPACE, migrations)

  // Create the store (prepared statements on the database)
  const store = new AppManagerStore(appDb)

  // Create the service with injected dependencies
  const service = createAppManagerService({
    store,
    getSpacePath: (spaceId: string): string | null => {
      const space = getSpace(spaceId)
      return space?.path ?? null
    },
  })

  managerInstance = service

  const duration = performance.now() - start
  console.log(`[AppManager] Initialized in ${duration.toFixed(1)}ms`)

  return service
}

/**
 * Shutdown the App Manager module.
 *
 * Currently a no-op -- all state is in SQLite (managed by platform/store)
 * and in-memory event handlers (garbage collected).
 *
 * Exists to satisfy the bootstrap shutdown contract.
 */
export async function shutdownAppManager(): Promise<void> {
  managerInstance = null
  console.log('[AppManager] Shutdown complete')
}
