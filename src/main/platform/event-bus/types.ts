/**
 * platform/event-bus -- Type Definitions
 *
 * Public types for the unified event routing system.
 * Consumed by apps/runtime for event subscription and by
 * bootstrap/extended.ts for initialization.
 *
 * The event-bus is the central routing hub connecting information sources
 * (file changes, webhooks, scheduled triggers) to automation Apps.
 * It performs filtering and deduplication but does NOT process events
 * or know about AI/LLM.
 */

// ---------------------------------------------------------------------------
// Core Event
// ---------------------------------------------------------------------------

/**
 * A normalized event flowing through the event bus.
 *
 * All event sources (file-watcher, webhook, scheduler bridge) produce
 * HaloEvent instances. Subscribers receive these after filtering and dedup.
 */
export interface HaloEvent {
  /** Unique event identifier (UUID v4, assigned by the bus on emit). */
  id: string
  /**
   * Dotted event type string.
   *
   * Convention: `{source-category}.{verb}`
   * Examples: "file.changed", "file.created", "file.deleted",
   *           "webhook.received", "schedule.due"
   */
  type: string
  /** Identifier of the event source adapter that produced this event. */
  source: string
  /** Unix timestamp in milliseconds when the event was emitted. */
  timestamp: number
  /** Arbitrary payload data specific to the event type. */
  payload: Record<string, unknown>
  /**
   * Optional deduplication key.
   *
   * If set, events with the same dedupKey within the TTL window
   * are silently dropped. Useful for preventing duplicate webhook
   * deliveries, file-watcher burst events, etc.
   */
  dedupKey?: string
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Subscription filter. All specified criteria must match (AND logic).
 * Omitted fields are treated as "match any".
 */
export interface EventFilter {
  /**
   * Event types to match. Supports simple glob:
   * - `"file.changed"` -- exact match
   * - `"file.*"` -- matches any type starting with `"file."`
   * - `"*"` -- matches everything
   */
  types?: string[]
  /** Source adapter IDs to match. Exact match only. */
  sources?: string[]
  /** Rule-based field matching (zero LLM cost pre-filtering). */
  rules?: FilterRule[]
}

/**
 * A single field-level filter rule.
 *
 * Rules are evaluated against the full HaloEvent object, so `field` can
 * reference any property path: `"type"`, `"source"`, `"payload.extension"`,
 * `"payload.items[0].price"`, etc.
 */
export interface FilterRule {
  /**
   * Dot-separated field path into the HaloEvent.
   * Supports array index notation: `"payload.items[0].name"`
   */
  field: string
  /** Comparison operator. */
  op: 'eq' | 'neq' | 'contains' | 'matches' | 'gt' | 'lt' | 'in' | 'nin'
  /** Value to compare against. Type depends on the operator. */
  value: unknown
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Event handler callback. May be sync or async. */
export type EventHandler = (event: HaloEvent) => void | Promise<void>

/** Function to unsubscribe a previously registered handler. */
export type Unsubscribe = () => void

// ---------------------------------------------------------------------------
// EventBus Service
// ---------------------------------------------------------------------------

/**
 * The public interface of the event bus.
 *
 * This is the contract that apps/runtime depends on.
 * Implementation details (dedup cache, filter engine) are internal.
 */
export interface EventBusService {
  /**
   * Emit an event into the bus.
   *
   * The bus assigns `id` and `timestamp` automatically.
   * If `dedupKey` is set and a duplicate is detected within the TTL,
   * the event is silently dropped.
   *
   * Matching subscribers are invoked sequentially with error isolation.
   */
  emit(event: Omit<HaloEvent, 'id' | 'timestamp'>): void

  /**
   * Subscribe to events matching the given filter.
   *
   * @returns An unsubscribe function. Calling it removes this subscription.
   */
  on(filter: EventFilter, handler: EventHandler): Unsubscribe

  /**
   * Register an event source adapter.
   *
   * The source is started immediately if the bus is already running,
   * otherwise it will be started when `start()` is called.
   */
  registerSource(source: EventSourceAdapter): void

  /**
   * Remove and stop a previously registered event source adapter.
   */
  removeSource(sourceId: string): void

  /**
   * List all registered event source adapters with basic info.
   */
  listSources(): EventSourceInfo[]

  /**
   * Start the event bus and all registered source adapters.
   */
  start(): void

  /**
   * Stop the event bus and all registered source adapters.
   * Clears all subscriptions and the dedup cache.
   */
  stop(): void
}

// ---------------------------------------------------------------------------
// Event Source Adapters
// ---------------------------------------------------------------------------

/** Supported event source types. */
export type EventSourceType =
  | 'file-watcher'
  | 'webhook'
  | 'schedule-bridge'
  | 'webpage'    // V2 placeholder
  | 'rss'        // V2 placeholder
  | 'internal'

/**
 * Unified interface for all information source adapters.
 *
 * V1 implements three built-in adapters:
 * - FileWatcherSource: wraps the existing file-watcher worker
 * - WebhookSource: mounts POST /hooks/* on the existing Express server
 * - ScheduleBridgeSource: bridges scheduler jobDue events to HaloEvent
 *
 * V2 will add WebPageSource (AI Browser snapshot + diff) and RSSSource.
 */
export interface EventSourceAdapter {
  /** Unique identifier for this source instance. */
  id: string
  /** Type discriminator. */
  type: EventSourceType
  /**
   * Start producing events.
   *
   * @param emit - Callback to push events into the bus. The source calls
   *   this whenever it has a new event. The bus handles id/timestamp assignment,
   *   dedup, filtering, and dispatch.
   */
  start(emit: EventEmitFn): void
  /**
   * Stop producing events and clean up all listeners/routes.
   *
   * Must be safe to call multiple times. Must not throw.
   */
  stop(): void
}

/** The emit function signature provided to source adapters. */
export type EventEmitFn = (event: Omit<HaloEvent, 'id' | 'timestamp'>) => void

/** Summary information about a registered source adapter. */
export interface EventSourceInfo {
  id: string
  type: EventSourceType
  running: boolean
}

// ---------------------------------------------------------------------------
// Dedup Configuration
// ---------------------------------------------------------------------------

/** Configuration for the in-memory dedup cache. */
export interface DedupConfig {
  /** Time-to-live in milliseconds for dedup entries. Default: 60_000 (60s). */
  ttlMs: number
  /** Maximum number of entries in the cache. Default: 10_000. */
  maxSize: number
}

// ---------------------------------------------------------------------------
// Init Dependencies
// ---------------------------------------------------------------------------

/**
 * Dependencies passed to `initEventBus()`.
 *
 * All fields are optional. If omitted, sensible defaults are used.
 * The `db` field is reserved for future SQLite-backed dedup (V2).
 */
export interface EventBusDeps {
  /** Database manager -- reserved for V2 persistent dedup. Not used in V1. */
  db?: unknown
  /** Dedup cache configuration override. */
  dedup?: Partial<DedupConfig>
}
