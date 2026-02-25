/**
 * apps/runtime -- App Runtime Service
 *
 * The core orchestration layer that connects all platform modules.
 * Translates App subscriptions into scheduler jobs and event-bus
 * subscriptions, manages the activation lifecycle, and delegates
 * execution to executeRun().
 *
 * This is the ONLY module that crosses layer boundaries:
 *   apps/ -> platform/ -> services/
 */

import { randomUUID } from 'crypto'
import type { InstalledApp, AppManagerService, RunOutcome, AppStatus } from '../manager'
import { AppNotFoundError } from '../manager'
import type { SchedulerService, SchedulerJob, SchedulerJobCreate } from '../../platform/scheduler'
import type { EventBusService, EventFilter, FilterRule } from '../../platform/event-bus'
import type { MemoryService } from '../../platform/memory'
import type { BackgroundService } from '../../platform/background'
import type { ActivityStore } from './store'
import type {
  AppRuntimeService,
  AppRuntimeDeps,
  ActivationState,
  AutomationAppState,
  AppRunResult,
  TriggerContext,
  EscalationResponse,
  ActivityQueryOptions,
  ActivityEntry,
  AutomationRun,
} from './types'
import { AppNotRunnableError, NoSubscriptionsError, EscalationNotFoundError, ConcurrencyLimitError } from './errors'
import { Semaphore } from './concurrency'
import { executeRun } from './execute'
import { broadcastToAll } from '../../http/websocket'
import { sendToRenderer } from '../../services/window.service'
import { notifyAppEvent } from '../../services/notification.service'

// ============================================
// Constants
// ============================================

/** Default max concurrent automation runs */
const DEFAULT_MAX_CONCURRENT = 10

/** Max consecutive errors before auto-pausing */
const MAX_CONSECUTIVE_ERRORS = 5

/** Keep-alive reason string for the background service */
const KEEP_ALIVE_REASON = 'automation-apps-active'

/** Default escalation timeout in hours (used when spec.escalation.timeout_hours is not set) */
const DEFAULT_ESCALATION_TIMEOUT_HOURS = 24

/** How often to check for timed-out escalations (5 minutes) */
const ESCALATION_CHECK_INTERVAL_MS = 5 * 60 * 1000

/** Minimum interval between data prune runs (24 hours) */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

// ============================================
// Service Factory
// ============================================

/**
 * Create the AppRuntimeService implementation.
 *
 * All state is held in closures (activation map, semaphore).
 * All persistent state is in SQLite via the ActivityStore.
 *
 * @param deps - Injected dependencies
 * @returns Fully initialized AppRuntimeService
 */
export function createAppRuntimeService(deps: AppRuntimeDeps): AppRuntimeService {
  const { store, appManager, scheduler, eventBus, memory, background } = deps

  // ── Internal State ──────────────────────────────────
  const activations = new Map<string, ActivationState>()
  const semaphore = new Semaphore(DEFAULT_MAX_CONCURRENT)
  // Keyed by unique execution key ("{appId}:{counter}") -- NOT by appId alone.
  // This avoids concurrent runs for the same App overwriting each other's
  // abort controller, ensuring deactivate() can cancel ALL running instances.
  const runningAbortControllers = new Map<string, AbortController>()
  let executionCounter = 0
  /**
   * Reference-counted map of app IDs waiting for a global semaphore slot.
   * Value = number of runs currently queued for that app. Used to:
   *   (a) expose 'queued' status to the renderer, and
   *   (b) enforce per-app dedup (reject a second trigger while one is queued/running).
   * A Map (vs Set) is required because the same app can be queued multiple times
   * (e.g. a scheduled run and an event run arrive simultaneously). Each caller
   * independently increments/decrements so the flag stays accurate until the last
   * queued run acquires its slot.
   */
  const pendingTriggers = new Map<string, number>()
  /** Interval handle for escalation timeout checker */
  let escalationCheckInterval: ReturnType<typeof setInterval> | null = null
  /** Timestamp of last successful prune (avoid running too frequently) */
  let lastPruneAtMs = 0

  // ── Helper: Build trigger context ───────────────────
  function buildScheduleTriggerContext(job: SchedulerJob, app: InstalledApp): TriggerContext {
    const subId = (job.metadata as any)?.subscriptionId || 'unknown'
    const schedule = job.schedule
    let scheduleDesc: string

    if (schedule.kind === 'every') {
      scheduleDesc = `every ${schedule.every}`
    } else if (schedule.kind === 'cron') {
      scheduleDesc = `cron: ${schedule.cron}`
    } else {
      scheduleDesc = `once at ${new Date(schedule.once).toISOString()}`
    }

    return {
      type: 'schedule',
      description: `Scheduled run for "${app.spec.name}" (${scheduleDesc}). ` +
        `Time: ${new Date().toISOString()}`,
      jobId: job.id,
    }
  }

  function buildEventTriggerContext(
    eventType: string,
    eventPayload: Record<string, unknown>,
    app: InstalledApp
  ): TriggerContext {
    return {
      type: 'event',
      description: `Triggered by event "${eventType}" for "${app.spec.name}". ` +
        `Time: ${new Date().toISOString()}`,
      eventPayload,
    }
  }

  function buildManualTriggerContext(app: InstalledApp): TriggerContext {
    return {
      type: 'manual',
      description: `Manually triggered run for "${app.spec.name}". ` +
        `Time: ${new Date().toISOString()}`,
    }
  }

  function buildEscalationTriggerContext(
    app: InstalledApp,
    originalQuestion: string,
    response: EscalationResponse
  ): TriggerContext {
    return {
      type: 'escalation_followup',
      description: `Follow-up run for "${app.spec.name}" after user responded to escalation. ` +
        `Original question: "${originalQuestion}". ` +
        `User response: "${response.text || response.choice || '(no text)'}". ` +
        `Time: ${new Date().toISOString()}`,
      escalation: {
        originalQuestion,
        userResponse: response,
      },
    }
  }

  // ── Helper: Broadcast app state change ──────────────
  function broadcastAppStatus(appId: string): void {
    try {
      const state = service.getAppState(appId)
      broadcastToAll('app:status_changed', { appId, state: state as unknown as Record<string, unknown> })
      sendToRenderer('app:status_changed', { appId, state })
    } catch (_err) {
      // Non-fatal — continue execution
    }
  }

  // ── Helper: Execute with concurrency control ────────
  async function executeWithConcurrency(
    app: InstalledApp,
    trigger: TriggerContext
  ): Promise<AppRunResult> {
    // Try to acquire a slot immediately without blocking.
    // If no slot is available, transition to 'queued' state and block.
    const immediateSlot = semaphore.tryAcquire()
    if (!immediateSlot) {
      // Slot not available — mark as queued and broadcast so the UI shows
      // the 'queued' status before we block on semaphore.acquire().
      pendingTriggers.set(app.id, (pendingTriggers.get(app.id) ?? 0) + 1)
      broadcastAppStatus(app.id)
      console.log(`[Runtime] app:queued (waiting for global slot): ${app.id}`)

      try {
        await semaphore.acquire()
      } finally {
        // Whether we got the slot or were rejected (e.g. shutdown), decrement queued count.
        // Only remove the key when the last queued run for this app has been resolved.
        const remaining = (pendingTriggers.get(app.id) ?? 1) - 1
        if (remaining <= 0) {
          pendingTriggers.delete(app.id)
        } else {
          pendingTriggers.set(app.id, remaining)
        }
      }
    }

    const abortController = new AbortController()
    // Use a unique per-run key so concurrent runs of the same App
    // each get their own abort controller entry.
    const executionKey = `${app.id}:${++executionCounter}`
    runningAbortControllers.set(executionKey, abortController)

    // Broadcast run-start status (app transitions from 'queued'/'idle' to 'running')
    broadcastAppStatus(app.id)

    try {
      const result = await executeRun({
        app,
        trigger,
        store,
        memory,
        abortSignal: abortController.signal,
      })

      const runTag = result.runId.slice(0, 8)

      // ── Fallback activity entry ──────────────────────
      // If the AI didn't call report_to_user (e.g., non-Anthropic model
      // couldn't find the tool, or simply didn't report), insert a synthetic
      // activity entry so the Activity Thread is never empty for a completed run.
      if (result.outcome !== 'error') {
        try {
          const existingEntries = store.getEntriesForRun(result.runId)
          if (existingEntries.length === 0) {
            const fallbackSummary = result.finalText
              ? result.finalText.slice(0, 500)
              : `${app.spec.name} completed (${result.durationMs}ms)`

            const fallbackEntry: ActivityEntry = {
              id: randomUUID(),
              appId: app.id,
              runId: result.runId,
              type: result.outcome === 'noop' ? 'run_skipped' : 'run_complete',
              ts: result.finishedAt,
              sessionKey: result.sessionKey,
              content: {
                summary: fallbackSummary,
                status: result.outcome === 'noop' ? 'skipped' : 'ok',
                durationMs: result.durationMs,
              },
            }

            store.insertEntry(fallbackEntry)
            console.log(`[Runtime][${runTag}] Fallback activity entry created (AI did not call report_to_user)`)

            // Broadcast to clients
            broadcastToAll('app:activity_entry:new', { appId: app.id, entry: fallbackEntry as unknown as Record<string, unknown> })
            sendToRenderer('app:activity_entry:new', { appId: app.id, entry: fallbackEntry })
          }
        } catch (fallbackErr) {
          console.error(`[Runtime][${runTag}] Failed to create fallback activity entry:`, fallbackErr)
        }
      }

      // Update manager with run outcome
      const outcome = result.outcome as RunOutcome
      appManager.updateLastRun(app.id, outcome, result.errorMessage)

      // Handle escalation result
      if (result.outcome === 'useful' && store.getRun(result.runId)?.status === 'waiting_user') {
        // The run resulted in an escalation - find the pending escalation entry
        const entries = store.getEntriesForApp(app.id, { type: 'escalation', limit: 1 })
        const pendingEntry = entries.find(e => !e.userResponse)
        if (pendingEntry) {
          appManager.updateStatus(app.id, 'waiting_user', {
            pendingEscalationId: pendingEntry.id,
          })
        }
      }

      // Handle consecutive errors -> auto-pause
      if (outcome === 'error') {
        const recentRuns = store.getRunsForApp(app.id, MAX_CONSECUTIVE_ERRORS)
        const consecutiveErrors = countConsecutiveErrors(recentRuns)
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.warn(
            `[Runtime] Auto-pausing app=${app.id}: ${consecutiveErrors} consecutive errors`
          )
          try {
            appManager.updateStatus(app.id, 'error', {
              errorMessage: `Auto-disabled after ${consecutiveErrors} consecutive errors`,
            })
            // Deactivate to stop scheduling
            await service.deactivate(app.id)
          } catch (statusErr) {
            console.error('[Runtime] Failed to auto-pause app:', statusErr)
          }
        }
      }

      // Handle output.notify — send notifications on successful completion
      const notifyConfig = app.spec.output?.notify
      const shouldNotify = notifyConfig && (notifyConfig.system !== false || (notifyConfig.channels && notifyConfig.channels.length > 0))
      console.log(`[Runtime][Notify] output.notify check: config=${JSON.stringify(notifyConfig)}, outcome=${outcome}`)
      if (shouldNotify && outcome !== 'error') {
        try {
          const entries = store.getEntriesForApp(app.id, { type: 'run_complete', limit: 1 })
          const latestComplete = entries[0]
          const body = latestComplete?.content?.summary ?? `${app.spec.name} completed`
          console.log(`[Runtime][Notify] Calling notifyAppEvent: title="${app.spec.name}", bodyLen=${body.length}`)
          notifyAppEvent(app.spec.name, body, {
            appId: app.id,
            channels: notifyConfig.channels,
            skipSystem: notifyConfig.system === false,
          })
          console.log(`[Runtime][Notify] notifyAppEvent returned`)
        } catch (notifyErr) {
          console.error('[Runtime] Failed to send output.notify notification:', notifyErr)
        }
      } else {
        console.log(`[Runtime][Notify] Skipped — condition not met (notify=${JSON.stringify(notifyConfig)}, outcome=${outcome})`)
      }

      return result
    } finally {
      runningAbortControllers.delete(executionKey)
      semaphore.release()

      // Broadcast run-end status (app transitions back to 'idle' or other state)
      broadcastAppStatus(app.id)
    }
  }

  // ── Helper: Count consecutive errors ────────────────
  function countConsecutiveErrors(runs: AutomationRun[]): number {
    let count = 0
    for (const run of runs) {
      if (run.status === 'error') {
        count++
      } else {
        break
      }
    }
    return count
  }

  // ── Helper: Check and auto-timeout stale escalations ──
  /**
   * Prune old runs and activity entries if enough time has passed
   * since the last prune. Runs at most once per PRUNE_INTERVAL_MS (24h).
   */
  function pruneOldDataIfNeeded(): void {
    const now = Date.now()
    if (now - lastPruneAtMs < PRUNE_INTERVAL_MS) return

    try {
      const pruned = store.pruneOldData()
      lastPruneAtMs = now
      if (pruned > 0) {
        console.log(`[Runtime] Pruned ${pruned} old automation runs (and their activity entries)`)
      }
    } catch (err) {
      console.error('[Runtime] Failed to prune old data:', err)
    }
  }

  /**
   * Periodically scans for pending escalations that have exceeded their
   * timeout (default: 24 hours). Timed-out escalations are:
   * 1. Auto-resolved with a timeout response
   * 2. Recorded as a run_error activity entry
   * 3. App status changed from waiting_user → error
   * 4. Desktop notification sent to inform the user
   */
  function checkEscalationTimeouts(): void {
    try {
      const pendingEscalations = store.getAllPendingEscalations()
      if (pendingEscalations.length === 0) return

      const now = Date.now()

      for (const entry of pendingEscalations) {
        const app = appManager.getApp(entry.appId)
        if (!app) continue

        // Only process apps that are actually in waiting_user state
        if (app.status !== 'waiting_user') continue

        // Determine timeout from app spec (default: 24 hours)
        const timeoutHours = app.spec.escalation?.timeout_hours ?? DEFAULT_ESCALATION_TIMEOUT_HOURS
        const timeoutMs = timeoutHours * 60 * 60 * 1000
        const elapsed = now - entry.ts

        if (elapsed < timeoutMs) continue

        const timeoutLabel = timeoutHours >= 24
          ? `${Math.round(timeoutHours / 24)} day(s)`
          : `${timeoutHours} hour(s)`

        console.log(
          `[Runtime] Escalation timed out: app=${app.id}, entry=${entry.id}, ` +
          `elapsed=${Math.round(elapsed / 3600000)}h, timeout=${timeoutLabel}`
        )

        // 1. Auto-resolve the escalation with a timeout response
        const timeoutResponse = {
          ts: now,
          text: `[Auto-closed] User did not respond within ${timeoutLabel}.`,
        }
        store.updateEntryResponse(entry.id, timeoutResponse)

        // 2. Insert a run_error activity entry
        const errorEntry = {
          id: randomUUID(),
          appId: app.id,
          runId: entry.runId,
          type: 'run_error' as const,
          ts: now,
          sessionKey: entry.sessionKey,
          content: {
            summary: `Escalation timed out — user did not respond within ${timeoutLabel}.`,
            status: 'error' as const,
            error: `Escalation timeout (${timeoutLabel})`,
          },
        }

        store.insertEntry(errorEntry)

        // Broadcast the new error entry
        broadcastToAll('app:activity_entry:new', { appId: app.id, entry: errorEntry as unknown as Record<string, unknown> })
        sendToRenderer('app:activity_entry:new', { appId: app.id, entry: errorEntry })

        // 3. Transition app status: waiting_user → error
        try {
          appManager.updateStatus(app.id, 'error', {
            errorMessage: `Escalation timed out after ${timeoutLabel}`,
          })
        } catch (statusErr) {
          console.error(`[Runtime] Failed to update status after escalation timeout: app=${app.id}:`, statusErr)
        }

        // 4. Notify the user
        notifyAppEvent(
          app.spec.name,
          `Escalation timed out — no response within ${timeoutLabel}.`,
          { appId: app.id }
        )
      }
    } catch (err) {
      console.error('[Runtime] Escalation timeout check failed:', err)
    }

    // Piggyback data pruning on the same interval (self-throttled to 24h)
    pruneOldDataIfNeeded()
  }

  // ── Helper: Map subscription to scheduler job ───────
  function subscriptionToSchedulerJob(
    app: InstalledApp,
    sub: NonNullable<InstalledApp['spec']['subscriptions']>[0],
    index: number
  ): SchedulerJobCreate | null {
    const subId = sub.id || `sub-${index}`

    if (sub.source.type === 'schedule') {
      const config = sub.source.config
      // Check for user frequency override
      const overriddenFreq = app.userOverrides.frequency?.[subId]

      if (config.every || overriddenFreq) {
        const every = overriddenFreq || config.every!
        return {
          id: `${app.id}:${subId}`,
          name: `${app.spec.name} - ${subId}`,
          schedule: { kind: 'every', every },
          enabled: true,
          metadata: { appId: app.id, subscriptionId: subId },
        }
      }

      if (config.cron) {
        return {
          id: `${app.id}:${subId}`,
          name: `${app.spec.name} - ${subId}`,
          schedule: { kind: 'cron', cron: config.cron },
          enabled: true,
          metadata: { appId: app.id, subscriptionId: subId },
        }
      }
    }

    return null
  }

  // ── Helper: Map subscription to event filter ────────
  function subscriptionToEventFilter(
    sub: NonNullable<InstalledApp['spec']['subscriptions']>[0]
  ): EventFilter | null {
    switch (sub.source.type) {
      case 'file': {
        const filter: EventFilter = { types: ['file.*'] }
        const rules: FilterRule[] = []

        // Apply pattern-based filtering if the subscription specifies a glob pattern
        const filePattern = sub.source.config.pattern
        if (filePattern) {
          rules.push({
            field: 'payload.relativePath',
            op: 'matches',
            value: filePattern,
          })
        }

        // Apply path-based filtering if the subscription specifies a directory
        const filePath = sub.source.config.path
        if (filePath) {
          const normalizedPath = filePath.replace(/\/+$/, '') // strip trailing slashes
          rules.push({
            field: 'payload.filePath',
            op: 'contains',
            value: normalizedPath,
          })
        }

        if (rules.length > 0) {
          filter.rules = rules
        }

        return filter
      }
      case 'webhook': {
        const filter: EventFilter = { types: ['webhook.received'] }
        // Add path-based filtering if the subscription specifies a webhook path
        const webhookPath = sub.source.config.path
        if (webhookPath) {
          filter.rules = [{
            field: 'payload.path',
            op: 'eq',
            value: webhookPath.replace(/^\/+|\/+$/g, ''), // normalize: strip leading/trailing slashes
          }]
        }
        return filter
      }
      case 'webpage':
        return { types: ['webpage.changed'] }
      case 'rss':
        return { types: ['rss.updated'] }
      default:
        return null
    }
  }

  // ── Service Implementation ──────────────────────────

  const service: AppRuntimeService = {
    // ── Activation ──────────────────────────────────

    async activate(appId: string): Promise<void> {
      // Idempotent - skip if already activated
      if (activations.has(appId)) {
        console.log(`[Runtime] App already activated: ${appId}`)
        return
      }

      const app = appManager.getApp(appId)
      if (!app) {
        throw new AppNotFoundError(appId)
      }

      if (app.spec.type !== 'automation') {
        console.log(`[Runtime] Skipping non-automation app: ${appId} (type=${app.spec.type})`)
        return
      }

      const subscriptions = app.spec.subscriptions
      if (!subscriptions || subscriptions.length === 0) {
        throw new NoSubscriptionsError(appId)
      }

      console.log(`[Runtime] Activating app: ${appId} (${app.spec.name})`)

      const state: ActivationState = {
        appId,
        schedulerJobIds: [],
        eventUnsubscribers: [],
        keepAliveDisposer: null,
      }

      // Register scheduler jobs for schedule-type subscriptions
      for (let i = 0; i < subscriptions.length; i++) {
        const sub = subscriptions[i]
        const jobCreate = subscriptionToSchedulerJob(app, sub, i)
        if (jobCreate) {
          // Check if job already exists (from a previous activation)
          const existingJob = scheduler.getJob(jobCreate.id)
          if (existingJob) {
            const scheduleChanged =
              JSON.stringify(existingJob.schedule) !== JSON.stringify(jobCreate.schedule)
            if (scheduleChanged) {
              // Schedule changed -- remove and re-add so anchorMs resets to now
              scheduler.removeJob(jobCreate.id)
              scheduler.addJob(jobCreate)
            } else {
              scheduler.resumeJob(jobCreate.id)
            }
          } else {
            scheduler.addJob(jobCreate)
          }
          state.schedulerJobIds.push(jobCreate.id)
          console.log(`[Runtime] Registered scheduler job: ${jobCreate.id}`)
        }
      }

      // Register event-bus subscriptions for event-type subscriptions
      for (let i = 0; i < subscriptions.length; i++) {
        const sub = subscriptions[i]
        const filter = subscriptionToEventFilter(sub)
        if (filter) {
          const unsub = eventBus.on(filter, async (event) => {
            // Check if app is still active
            const currentApp = appManager.getApp(appId)
            if (!currentApp || currentApp.status !== 'active') return

            console.log(`[Runtime] Event triggered: type=${event.type}, app=${appId}`)
            const trigger = buildEventTriggerContext(event.type, event.payload, currentApp)

            try {
              await executeWithConcurrency(currentApp, trigger)
            } catch (err) {
              console.error(`[Runtime] Event-triggered run failed: app=${appId}:`, err)
            }
          })
          state.eventUnsubscribers.push(unsub)
        }
      }

      // Register keep-alive reason if we have any active subscriptions
      if (state.schedulerJobIds.length > 0 || state.eventUnsubscribers.length > 0) {
        state.keepAliveDisposer = background.registerKeepAliveReason(
          `${KEEP_ALIVE_REASON}:${appId}`
        )
      }

      activations.set(appId, state)
      console.log(
        `[Runtime] App activated: ${appId}, ` +
        `jobs=${state.schedulerJobIds.length}, events=${state.eventUnsubscribers.length}`
      )
    },

    async deactivate(appId: string): Promise<void> {
      const state = activations.get(appId)
      if (!state) {
        console.log(`[Runtime] App not activated, skip deactivate: ${appId}`)
        return
      }

      console.log(`[Runtime] Deactivating app: ${appId}`)

      // Remove scheduler jobs
      for (const jobId of state.schedulerJobIds) {
        try {
          scheduler.removeJob(jobId)
        } catch (err) {
          console.error(`[Runtime] Failed to remove scheduler job ${jobId}:`, err)
        }
      }

      // Remove event-bus subscriptions
      for (const unsub of state.eventUnsubscribers) {
        try {
          unsub()
        } catch (err) {
          console.error(`[Runtime] Failed to unsubscribe event handler:`, err)
        }
      }

      // Release keep-alive
      if (state.keepAliveDisposer) {
        state.keepAliveDisposer()
      }

      // Abort all running executions for this App (handles concurrent runs)
      const prefix = `${appId}:`
      for (const [key, controller] of Array.from(runningAbortControllers.entries())) {
        if (key.startsWith(prefix)) {
          controller.abort()
          runningAbortControllers.delete(key)
        }
      }

      activations.delete(appId)
      console.log(`[Runtime] App deactivated: ${appId}`)
    },

    syncAppSchedule(appId: string): void {
      const state = activations.get(appId)
      if (!state) return // Not activated — nothing to sync

      const app = appManager.getApp(appId)
      if (!app) return

      const subscriptions = app.spec.subscriptions ?? []
      const desiredJobIds = new Set<string>()

      for (let i = 0; i < subscriptions.length; i++) {
        const sub = subscriptions[i]
        const jobCreate = subscriptionToSchedulerJob(app, sub, i)
        if (!jobCreate) continue

        desiredJobIds.add(jobCreate.id)
        const existingJob = scheduler.getJob(jobCreate.id)

        if (existingJob) {
          const scheduleChanged =
            JSON.stringify(existingJob.schedule) !== JSON.stringify(jobCreate.schedule)
          if (scheduleChanged) {
            scheduler.removeJob(jobCreate.id)
            scheduler.addJob(jobCreate)
            console.log(`[Runtime] Schedule hot-updated: ${jobCreate.id}`)
          }
        } else {
          scheduler.addJob(jobCreate)
          if (!state.schedulerJobIds.includes(jobCreate.id)) {
            state.schedulerJobIds.push(jobCreate.id)
          }
          console.log(`[Runtime] New scheduler job added: ${jobCreate.id}`)
        }
      }

      // Remove stale jobs that are no longer in the subscription list
      for (const jobId of [...state.schedulerJobIds]) {
        if (!desiredJobIds.has(jobId)) {
          scheduler.removeJob(jobId)
          state.schedulerJobIds = state.schedulerJobIds.filter(id => id !== jobId)
          console.log(`[Runtime] Stale scheduler job removed: ${jobId}`)
        }
      }
    },

    // ── Execution ───────────────────────────────────

    async triggerManually(appId: string): Promise<AppRunResult> {
      const app = appManager.getApp(appId)
      if (!app) {
        throw new AppNotFoundError(appId)
      }

      if (app.status === 'error') {
        // Manual trigger from error state is treated as user-initiated retry.
        // Resume resets status to 'active' and re-activates the scheduler,
        // which is the same path as pause → resume in the UI.
        console.log(`[Runtime] app:trigger recovering from error state: ${appId}`)
        appManager.resume(appId)
      } else if (app.status !== 'active' && app.status !== 'paused') {
        throw new AppNotRunnableError(appId, app.status)
      }

      // Per-app dedup: reject if this specific app is already running or queued.
      // Each app should have at most one active execution at a time to avoid
      // redundant work (e.g. a monitoring app running 50 identical checks).
      const appIsRunning = Array.from(runningAbortControllers.keys()).some(k => k.startsWith(`${appId}:`))
      const appIsQueued = (pendingTriggers.get(appId) ?? 0) > 0
      if (appIsRunning || appIsQueued) {
        throw new ConcurrencyLimitError(DEFAULT_MAX_CONCURRENT, appId)
      }

      const trigger = buildManualTriggerContext(app)
      return executeWithConcurrency(app, trigger)
    },

    // ── State Queries ───────────────────────────────

    getAppState(appId: string): AutomationAppState {
      const app = appManager.getApp(appId)
      if (!app) {
        return {
          status: 'idle',
        }
      }

      // Map AppStatus to AutomationAppState.status
      let status: AutomationAppState['status']
      const appPrefix = `${appId}:`
      const isRunning = Array.from(runningAbortControllers.keys()).some(k => k.startsWith(appPrefix))
      const isQueued = (pendingTriggers.get(appId) ?? 0) > 0

      switch (app.status) {
        case 'active':
          if (isRunning) status = 'running'
          else if (isQueued) status = 'queued'
          else status = 'idle'
          break
        case 'paused':
          status = 'paused'
          break
        case 'waiting_user':
          status = 'waiting_user'
          break
        case 'error':
        case 'needs_login':
          status = 'error'
          break
        default:
          status = 'idle'
      }

      const state: AutomationAppState = {
        status,
        pendingEscalationId: app.pendingEscalationId,
      }

      // Get latest run info
      const latestRun = store.getLatestRunForApp(appId)
      if (latestRun) {
        state.lastRunAtMs = latestRun.startedAt
        state.lastDurationMs = latestRun.durationMs
        if (latestRun.status === 'ok') state.lastStatus = 'ok'
        else if (latestRun.status === 'error') state.lastStatus = 'error'
        else if (latestRun.status === 'skipped') state.lastStatus = 'skipped'

        if (latestRun.status === 'running') {
          state.runningAtMs = latestRun.startedAt
          state.runningRunId = latestRun.runId
          state.runningSessionKey = latestRun.sessionKey
        }
      }

      // Get consecutive errors
      const recentRuns = store.getRunsForApp(appId, MAX_CONSECUTIVE_ERRORS)
      state.consecutiveErrors = countConsecutiveErrors(recentRuns)

      // Get last error
      if (app.errorMessage) {
        state.lastError = app.errorMessage
      }

      // Get next run time from scheduler
      const activation = activations.get(appId)
      if (activation && activation.schedulerJobIds.length > 0) {
        let earliestNextRun = Infinity
        for (const jobId of activation.schedulerJobIds) {
          const job = scheduler.getJob(jobId)
          if (job && job.nextRunAtMs < earliestNextRun) {
            earliestNextRun = job.nextRunAtMs
          }
        }
        if (earliestNextRun !== Infinity) {
          state.nextRunAtMs = earliestNextRun
        }
      }

      return state
    },

    // ── Escalation ──────────────────────────────────

    async respondToEscalation(
      appId: string,
      entryId: string,
      response: EscalationResponse
    ): Promise<void> {
      // Verify the escalation exists and is pending
      const entry = store.getPendingEscalation(appId, entryId)
      if (!entry) {
        throw new EscalationNotFoundError(appId, entryId)
      }

      // Record the user's response
      store.updateEntryResponse(entryId, response)

      console.log(`[Runtime] Escalation responded: app=${appId}, entry=${entryId}`)

      // Broadcast escalation resolved event for multi-client sync
      broadcastToAll('app:escalation:resolved', { appId, entryId, response })
      sendToRenderer('app:escalation:resolved', { appId, entryId, response })

      // Clear the waiting_user status
      const app = appManager.getApp(appId)
      if (app && app.status === 'waiting_user') {
        appManager.updateStatus(appId, 'active')
      }

      // Trigger a follow-up run with the escalation context
      if (app) {
        const originalQuestion = entry.content.question || entry.content.summary
        const trigger = buildEscalationTriggerContext(app, originalQuestion, response)

        // Execute asynchronously (don't block the response)
        executeWithConcurrency(app, trigger).catch((err) => {
          console.error(
            `[Runtime] Escalation follow-up run failed: app=${appId}:`,
            err
          )
        })
      }
    },

    // ── Activity Queries ────────────────────────────

    getActivityEntries(appId: string, options?: ActivityQueryOptions): ActivityEntry[] {
      return store.getEntriesForApp(appId, options)
    },

    getRun(runId: string): AutomationRun | null {
      return store.getRun(runId)
    },

    getRunsForApp(appId: string, limit?: number): AutomationRun[] {
      return store.getRunsForApp(appId, limit)
    },

    // ── Lifecycle ───────────────────────────────────

    async activateAll(): Promise<void> {
      console.log('[Runtime] Activating all active automation apps...')
      const apps = appManager.listApps({ status: 'active', type: 'automation' })

      let activated = 0
      for (const app of apps) {
        try {
          await service.activate(app.id)
          activated++
        } catch (err) {
          console.error(`[Runtime] Failed to activate app ${app.id}:`, err)
        }
      }

      // Start escalation timeout checker
      if (!escalationCheckInterval) {
        // Run once immediately at startup to catch any escalations that timed
        // out while the app was not running.
        checkEscalationTimeouts()
        escalationCheckInterval = setInterval(checkEscalationTimeouts, ESCALATION_CHECK_INTERVAL_MS)
        console.log(`[Runtime] Escalation timeout checker started (interval=${ESCALATION_CHECK_INTERVAL_MS / 60000}m)`)
      }

      console.log(`[Runtime] Activated ${activated}/${apps.length} automation apps`)
    },

    async deactivateAll(): Promise<void> {
      console.log('[Runtime] Deactivating all apps...')
      const appIds = Array.from(activations.keys())

      for (const appId of appIds) {
        try {
          await service.deactivate(appId)
        } catch (err) {
          console.error(`[Runtime] Failed to deactivate app ${appId}:`, err)
        }
      }

      // Stop escalation timeout checker
      if (escalationCheckInterval) {
        clearInterval(escalationCheckInterval)
        escalationCheckInterval = null
        console.log('[Runtime] Escalation timeout checker stopped')
      }

      // Reject all waiting semaphore callers
      semaphore.rejectAll('Runtime shutting down')

      console.log(`[Runtime] Deactivated ${appIds.length} apps`)
    },
  }

  // ── Register scheduler handler ──────────────────────
  // This connects the scheduler's onJobDue to our execution logic
  scheduler.onJobDue(async (job: SchedulerJob): Promise<RunOutcome> => {
    const appId = (job.metadata as any)?.appId
    if (!appId) {
      console.warn(`[Runtime] Scheduler job ${job.id} has no appId in metadata`)
      return 'skipped'
    }

    const app = appManager.getApp(appId)
    if (!app) {
      console.warn(`[Runtime] App not found for scheduler job: ${job.id}, appId=${appId}`)
      return 'skipped'
    }

    if (app.status !== 'active') {
      console.log(`[Runtime] Skipping scheduled run: app=${appId} status=${app.status}`)
      return 'skipped'
    }

    const trigger = buildScheduleTriggerContext(job, app)

    try {
      const result = await executeWithConcurrency(app, trigger)
      return result.outcome as RunOutcome
    } catch (err) {
      console.error(`[Runtime] Scheduled run failed: app=${appId}, job=${job.id}:`, err)
      return 'error'
    }
  })

  // ── Listen for App status changes ───────────────────
  appManager.onAppStatusChange((appId: string, _oldStatus: AppStatus, newStatus: AppStatus) => {
    // When an app is paused, deactivate it
    if (newStatus === 'paused' || newStatus === 'error') {
      service.deactivate(appId).catch(err => {
        console.error(`[Runtime] Failed to deactivate on status change: ${appId}:`, err)
      })
    }
    // When an app is resumed/activated, activate it
    if (newStatus === 'active') {
      service.activate(appId).catch(err => {
        console.error(`[Runtime] Failed to activate on status change: ${appId}:`, err)
      })
    }

    // Broadcast status change to all connected remote clients for real-time UI
    try {
      const state = service.getAppState(appId)
      broadcastToAll('app:status_changed', { appId, state: state as unknown as Record<string, unknown> })
      sendToRenderer('app:status_changed', { appId, state })
    } catch (err) {
      console.warn(`[Runtime] Failed to broadcast status change for app=${appId}:`, err)
    }
  })

  return service
}
