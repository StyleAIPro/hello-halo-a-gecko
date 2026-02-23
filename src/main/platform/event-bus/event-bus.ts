/**
 * platform/event-bus -- Core EventBus Implementation
 *
 * The central event routing hub. Manages:
 * - Subscription registry (filter + handler pairs)
 * - Event deduplication via in-memory TTL cache
 * - Source adapter lifecycle (start/stop)
 * - Sequential dispatch with error isolation
 *
 * This module does NOT know about AI/LLM. It is a pure event router.
 */

import { randomUUID } from 'crypto'
import type {
  HaloEvent,
  EventFilter,
  EventHandler,
  EventBusService,
  EventSourceAdapter,
  EventSourceInfo,
  EventEmitFn,
  Unsubscribe,
  DedupConfig
} from './types'
import { matchesFilter } from './filter'
import { createDedupCache, type DedupCache } from './dedup'

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

interface Subscription {
  id: string
  filter: EventFilter
  handler: EventHandler
}

// ---------------------------------------------------------------------------
// EventBus Class
// ---------------------------------------------------------------------------

export function createEventBus(dedupConfig?: Partial<DedupConfig>): EventBusService {
  const subscriptions = new Map<string, Subscription>()
  const sources = new Map<string, { adapter: EventSourceAdapter; running: boolean }>()
  const dedup: DedupCache = createDedupCache(dedupConfig)
  let running = false

  // The emit function passed to source adapters.
  // Wraps the public emit() with proper id/timestamp assignment.
  const emitFn: EventEmitFn = (partial) => {
    bus.emit(partial)
  }

  const bus: EventBusService = {
    emit(partial) {
      if (!running) return

      // Assign id and timestamp
      const event: HaloEvent = {
        id: randomUUID(),
        timestamp: Date.now(),
        ...partial
      }

      // Deduplication check
      if (event.dedupKey && dedup.isDuplicate(event.dedupKey)) {
        return
      }

      // Dispatch to matching subscribers (sequential, error-isolated)
      // We use void Promise to avoid unhandled rejections while keeping
      // the emit() signature synchronous (fire-and-forget for sources).
      void dispatchEvent(event)
    },

    on(filter, handler) {
      const subId = randomUUID()
      subscriptions.set(subId, { id: subId, filter, handler })

      // Return unsubscribe function
      const unsub: Unsubscribe = () => {
        subscriptions.delete(subId)
      }
      return unsub
    },

    registerSource(source) {
      if (sources.has(source.id)) {
        console.warn(`[EventBus] Source already registered: ${source.id}. Replacing.`)
        // Stop the existing one first
        const existing = sources.get(source.id)
        if (existing?.running) {
          try { existing.adapter.stop() } catch { /* ignore */ }
        }
      }

      const entry = { adapter: source, running: false }
      sources.set(source.id, entry)

      // If bus is already running, start the source immediately
      if (running) {
        try {
          source.start(emitFn)
          entry.running = true
          console.log(`[EventBus] Source started: ${source.id} (${source.type})`)
        } catch (err) {
          console.error(`[EventBus] Failed to start source ${source.id}:`, err)
        }
      }
    },

    removeSource(sourceId) {
      const entry = sources.get(sourceId)
      if (!entry) return

      if (entry.running) {
        try {
          entry.adapter.stop()
        } catch (err) {
          console.error(`[EventBus] Error stopping source ${sourceId}:`, err)
        }
      }

      sources.delete(sourceId)
      console.log(`[EventBus] Source removed: ${sourceId}`)
    },

    listSources() {
      const result: EventSourceInfo[] = []
      for (const entry of Array.from(sources.values())) {
        result.push({
          id: entry.adapter.id,
          type: entry.adapter.type,
          running: entry.running
        })
      }
      return result
    },

    start() {
      if (running) return
      running = true
      console.log(`[EventBus] Starting with ${sources.size} source(s)...`)

      for (const entry of Array.from(sources.values())) {
        if (entry.running) continue
        try {
          entry.adapter.start(emitFn)
          entry.running = true
          console.log(`[EventBus] Source started: ${entry.adapter.id} (${entry.adapter.type})`)
        } catch (err) {
          console.error(`[EventBus] Failed to start source ${entry.adapter.id}:`, err)
        }
      }

      console.log(`[EventBus] Started. ${subscriptions.size} subscription(s) active.`)
    },

    stop() {
      if (!running) return
      running = false
      console.log('[EventBus] Stopping...')

      // Stop all sources
      for (const entry of Array.from(sources.values())) {
        if (!entry.running) continue
        try {
          entry.adapter.stop()
          entry.running = false
        } catch (err) {
          console.error(`[EventBus] Error stopping source ${entry.adapter.id}:`, err)
        }
      }

      // Clear subscriptions and dedup cache
      subscriptions.clear()
      dedup.clear()

      console.log('[EventBus] Stopped.')
    }
  }

  // -------------------------------------------------------------------------
  // Internal: Dispatch
  // -------------------------------------------------------------------------

  /**
   * Dispatch an event to all matching subscribers.
   *
   * Handlers are invoked sequentially. If a handler throws or rejects,
   * the error is logged and the next handler is still called (error isolation).
   */
  async function dispatchEvent(event: HaloEvent): Promise<void> {
    for (const sub of Array.from(subscriptions.values())) {
      if (!matchesFilter(event, sub.filter)) continue

      try {
        const result = sub.handler(event)
        // Await if the handler is async
        if (result && typeof (result as Promise<void>).then === 'function') {
          await result
        }
      } catch (err) {
        console.error(
          `[EventBus] Handler error (sub=${sub.id}, event=${event.type}):`,
          err
        )
      }
    }
  }

  return bus
}
