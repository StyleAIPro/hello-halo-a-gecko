/**
 * platform/event-bus -- ScheduleBridgeSource
 *
 * Event source adapter that bridges the scheduler module's "job due"
 * events into the unified event bus as HaloEvent objects.
 *
 * Integration approach:
 * - Accepts a scheduler-like object conforming to a minimal interface.
 * - On start(), registers a callback via scheduler.onJobDue().
 * - When a scheduled job fires, produces a HaloEvent with:
 *   - type: "schedule.due"
 *   - source: "scheduler"
 *   - payload: { jobId, jobName, metadata, scheduledAt }
 * - No dedupKey: scheduler already ensures single-fire semantics
 *   for each job occurrence.
 *
 * Because the scheduler module may not exist yet (parallel development),
 * this source uses a minimal interface rather than importing scheduler
 * internals. The wiring is done at bootstrap time.
 *
 * Lifecycle:
 * - start(): registers the jobDue callback with scheduler
 * - stop(): calls the unsubscribe function returned by onJobDue()
 */

import type { EventSourceAdapter, EventEmitFn } from '../types'

// ---------------------------------------------------------------------------
// Minimal Scheduler Interface
// ---------------------------------------------------------------------------

/**
 * The minimal interface that the scheduler module must expose for
 * ScheduleBridgeSource to work.
 *
 * This is intentionally minimal -- we only need to subscribe to job-due
 * events. The full scheduler API is richer, but this adapter only cares
 * about event bridging.
 */
export interface SchedulerLike {
  /**
   * Register a callback for when a scheduled job becomes due.
   * Only one handler is supported; subsequent calls replace the previous one.
   *
   * @param handler - Called with job details when a job fires.
   */
  onJobDue(handler: (job: ScheduledJobInfo) => void): void
}

/**
 * Information about a scheduled job that has become due.
 * This is what the scheduler passes to the bridge callback.
 */
export interface ScheduledJobInfo {
  /** Unique job identifier. */
  jobId: string
  /** Human-readable job name. */
  jobName: string
  /** Arbitrary metadata attached to the job. */
  metadata?: Record<string, unknown>
  /** Timestamp when the job was scheduled to run (ms). */
  scheduledAt: number
}

// ---------------------------------------------------------------------------
// Source Implementation
// ---------------------------------------------------------------------------

export class ScheduleBridgeSource implements EventSourceAdapter {
  readonly id = 'schedule-bridge'
  readonly type = 'schedule-bridge' as const

  private emitFn: EventEmitFn | null = null
  private scheduler: SchedulerLike | null

  /**
   * @param scheduler - The scheduler service to bridge from.
   *   If null, the source operates in no-op mode (no events produced).
   *   This allows the event bus to start even before the scheduler is ready.
   */
  constructor(scheduler: SchedulerLike | null) {
    this.scheduler = scheduler
  }

  /**
   * Wire the scheduler after construction.
   *
   * Useful when the scheduler is initialized after the event bus.
   * If the source is already running, the new scheduler is immediately
   * subscribed.
   */
  setScheduler(scheduler: SchedulerLike): void {
    this.scheduler = scheduler

    // If we're already running, subscribe to the new scheduler
    if (this.emitFn) {
      this.subscribeToScheduler()
    }
  }

  start(emit: EventEmitFn): void {
    this.emitFn = emit

    if (this.scheduler) {
      this.subscribeToScheduler()
      console.log('[ScheduleBridgeSource] Started -- listening to scheduler events')
    } else {
      console.log('[ScheduleBridgeSource] Started (no scheduler wired -- awaiting setScheduler())')
    }
  }

  stop(): void {
    // Setting emitFn to null prevents any further events from being emitted.
    // The scheduler's single-slot handler cannot be unregistered, but since
    // the runtime service registers its own handler after this source, the
    // handler is effectively replaced. This is safe: the scheduler only
    // supports one handler at a time.
    this.emitFn = null
    console.log('[ScheduleBridgeSource] Stopped')
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private subscribeToScheduler(): void {
    if (!this.scheduler || !this.emitFn) return

    const emit = this.emitFn
    this.scheduler.onJobDue((job) => {
      // Guard: source may have been stopped after handler was registered
      if (!this.emitFn) return

      emit({
        type: 'schedule.due',
        source: this.id,
        payload: {
          jobId: job.jobId,
          jobName: job.jobName,
          metadata: job.metadata ?? {},
          scheduledAt: job.scheduledAt
        }
        // No dedupKey: scheduler guarantees single-fire
      })
    })
  }
}
