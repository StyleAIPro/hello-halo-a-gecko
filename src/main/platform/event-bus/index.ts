/**
 * platform/event-bus -- Public API
 *
 * Unified event routing hub for the Halo platform layer.
 * Connects information sources (file changes, webhooks, scheduler)
 * to automation event handlers.
 *
 * Usage in bootstrap/extended.ts:
 *
 *   import { initEventBus, shutdownEventBus } from '../platform/event-bus'
 *
 *   const eventBus = initEventBus({ dedup: { ttlMs: 60_000 } })
 *   eventBus.registerSource(fileWatcherSource)
 *   eventBus.registerSource(webhookSource)
 *   eventBus.registerSource(scheduleBridgeSource)
 *   eventBus.start()
 *
 *   // Subscribe
 *   const unsub = eventBus.on({ types: ['file.*'] }, async (event) => { ... })
 *
 *   // On shutdown:
 *   eventBus.stop()
 */

import { createEventBus } from './event-bus'
import type { EventBusDeps, EventBusService } from './types'

// Re-export types for consumers
export type {
  HaloEvent,
  EventFilter,
  FilterRule,
  EventHandler,
  EventBusService,
  EventSourceAdapter,
  EventSourceType,
  EventSourceInfo,
  EventEmitFn,
  Unsubscribe,
  DedupConfig,
  EventBusDeps
} from './types'

// Re-export source adapters for bootstrap wiring
export { FileWatcherSource } from './sources/file-watcher.source'
export type { WatcherHostLike } from './sources/file-watcher.source'
export { WebhookSource } from './sources/webhook.source'
export type { WebhookSecretResolver } from './sources/webhook.source'
export { ScheduleBridgeSource } from './sources/schedule-bridge.source'
export type { SchedulerLike, ScheduledJobInfo } from './sources/schedule-bridge.source'

// Re-export filter utilities for testing
export { matchesFilter, matchTypeGlob, getByPath } from './filter'

// Re-export dedup for testing
export { createDedupCache } from './dedup'

// ---------------------------------------------------------------------------
// Module State
// ---------------------------------------------------------------------------

let serviceInstance: EventBusService | null = null

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the event bus module.
 *
 * Creates the core event bus with dedup cache. Source adapters should be
 * registered separately via `bus.registerSource()` after initialization.
 *
 * @param deps - Optional dependencies (dedup config, db for future V2).
 * @returns The EventBusService instance.
 */
export function initEventBus(deps?: EventBusDeps): EventBusService {
  if (serviceInstance) {
    return serviceInstance
  }

  const start = performance.now()

  serviceInstance = createEventBus(deps?.dedup)

  const duration = performance.now() - start
  console.log(`[EventBus] Initialized in ${duration.toFixed(1)}ms`)

  return serviceInstance
}

/**
 * Shutdown the event bus module.
 *
 * Stops all source adapters, clears subscriptions and dedup cache.
 */
export function shutdownEventBus(): void {
  if (serviceInstance) {
    serviceInstance.stop()
    serviceInstance = null
    console.log('[EventBus] Shutdown complete')
  }
}
