/**
 * apps/runtime -- Public API
 *
 * App execution engine: activate, execute, report, escalate.
 *
 * This is the core glue layer that connects all platform modules
 * (scheduler, event-bus, memory, background) with the Agent service
 * to provide autonomous App execution capabilities.
 *
 * Usage in bootstrap/extended.ts:
 *
 *   import { initAppRuntime, shutdownAppRuntime } from '../apps/runtime'
 *
 *   const runtime = await initAppRuntime({
 *     db, appManager, scheduler, eventBus, memory, background
 *   })
 *
 *   // At shutdown:
 *   await shutdownAppRuntime()
 *
 * Usage in IPC handlers:
 *
 *   import type { AppRuntimeService } from '../apps/runtime'
 *
 *   function handleManualTrigger(runtime: AppRuntimeService, appId: string) {
 *     return runtime.triggerManually(appId)
 *   }
 */

import type { DatabaseManager } from '../../platform/store'
import type { AppManagerService } from '../manager'
import type { SchedulerService } from '../../platform/scheduler'
import type { EventBusService } from '../../platform/event-bus'
import type { MemoryService } from '../../platform/memory'
import type { BackgroundService } from '../../platform/background'
import { getSpace } from '../../services/space.service'
import { ActivityStore } from './store'
import { createAppRuntimeService } from './service'
import { MIGRATION_NAMESPACE, migrations } from './migrations'
import type { AppRuntimeService } from './types'

// Re-export types for consumers
export type {
  AppRuntimeService,
  AppRunResult,
  AutomationAppState,
  AutomationRun,
  ActivityEntry,
  ActivityEntryContent,
  ActivityEntryType,
  ActivityQueryOptions,
  EscalationResponse,
  TriggerContext,
  TriggerType,
  RunStatus,
  ActivationState,
  AppRuntimeDeps,
} from './types'

// Re-export error types
export {
  AppNotRunnableError,
  NoSubscriptionsError,
  ConcurrencyLimitError,
  EscalationNotFoundError,
  RunExecutionError,
} from './errors'

// Re-export concurrency for testing
export { Semaphore } from './concurrency'

// Re-export app chat functions
export {
  sendAppChatMessage,
  stopAppChat,
  isAppChatGenerating,
  loadAppChatMessages,
  getAppChatSessionState,
  getAppChatConversationId,
  cleanupAppChatBrowserContext,
} from './app-chat'
export type { AppChatRequest } from './app-chat'

// ============================================
// Module State
// ============================================

let runtimeService: AppRuntimeService | null = null
let memoryServiceRef: MemoryService | null = null

// ============================================
// Initialization
// ============================================

/** Dependencies required to initialize the App Runtime */
interface InitAppRuntimeDeps {
  /** DatabaseManager from platform/store */
  db: DatabaseManager
  /** App Manager service */
  appManager: AppManagerService
  /** Scheduler service */
  scheduler: SchedulerService
  /** Event Bus service */
  eventBus: EventBusService
  /** Memory service */
  memory: MemoryService
  /** Background service */
  background: BackgroundService
}

/**
 * Initialize the App Runtime module.
 *
 * 1. Gets the app-level database from DatabaseManager
 * 2. Runs schema migrations (automation_runs + activity_entries)
 * 3. Creates the ActivityStore and AppRuntimeService
 * 4. Activates all Apps with status='active'
 * 5. Returns the AppRuntimeService interface
 *
 * Must be called after all Phase 1 + Phase 2 modules are initialized:
 * - platform/store (Phase 0)
 * - apps/spec (Phase 0)
 * - platform/scheduler (Phase 1)
 * - platform/event-bus (Phase 1)
 * - platform/memory (Phase 1)
 * - platform/background (Phase 1)
 * - apps/manager (Phase 2)
 *
 * @param deps - Injected dependencies
 * @returns Initialized AppRuntimeService
 */
export async function initAppRuntime(
  deps: InitAppRuntimeDeps
): Promise<AppRuntimeService> {
  const start = performance.now()
  console.log('[Runtime] Initializing App Runtime...')

  // Get the app-level database
  const appDb = deps.db.getAppDatabase()

  // Run migrations
  deps.db.runMigrations(appDb, MIGRATION_NAMESPACE, migrations)

  // Create the activity store
  const store = new ActivityStore(appDb)

  // Create the runtime service
  const service = createAppRuntimeService({
    store,
    appManager: deps.appManager,
    scheduler: deps.scheduler,
    eventBus: deps.eventBus,
    memory: deps.memory,
    background: deps.background,
    getSpacePath: (spaceId: string): string | null => {
      const space = getSpace(spaceId)
      return space?.path ?? null
    },
  })

  // Activate all active automation Apps
  await service.activateAll()

  runtimeService = service
  memoryServiceRef = deps.memory

  const duration = performance.now() - start
  console.log(`[Runtime] App Runtime initialized in ${duration.toFixed(1)}ms`)

  return service
}

/**
 * Get the current runtime service instance.
 * Returns null if not yet initialized.
 */
export function getAppRuntime(): AppRuntimeService | null {
  return runtimeService
}

/**
 * Get the memory service instance captured during init.
 * Used by app-chat.ts to build app-specific memory tools.
 */
export function getAppMemoryService(): MemoryService | null {
  return memoryServiceRef
}

/**
 * Shutdown the App Runtime module.
 *
 * 1. Deactivates all Apps (removes scheduler jobs + event subscriptions)
 * 2. Cancels all running executions
 * 3. Clears the module state
 */
export async function shutdownAppRuntime(): Promise<void> {
  console.log('[Runtime] Shutting down App Runtime...')

  if (runtimeService) {
    await runtimeService.deactivateAll()
    runtimeService = null
    memoryServiceRef = null
  }

  console.log('[Runtime] App Runtime shutdown complete')
}
