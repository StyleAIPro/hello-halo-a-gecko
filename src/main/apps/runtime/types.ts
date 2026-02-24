/**
 * apps/runtime -- Type Definitions
 *
 * Public types for the App execution engine.
 * Consumed by IPC handlers, renderer (via shared types), and bootstrap.
 */

import type { RunOutcome, AppStatus } from '../manager'

// ============================================
// Trigger Types
// ============================================

/** What caused a run to execute */
export type TriggerType = 'schedule' | 'event' | 'manual' | 'escalation_followup'

/** Structured trigger context passed to the AI */
export interface TriggerContext {
  type: TriggerType
  /** Human-readable description of the trigger */
  description: string
  /** Scheduler job ID (for schedule triggers) */
  jobId?: string
  /** Event data (for event triggers) */
  eventPayload?: Record<string, unknown>
  /** Escalation context (for escalation follow-ups) */
  escalation?: {
    originalQuestion: string
    userResponse: EscalationResponse
  }
}

// ============================================
// Run Status & Result
// ============================================

/** Status of a single automation run */
export type RunStatus = 'running' | 'ok' | 'error' | 'skipped' | 'waiting_user'

/** Result of a completed App execution run */
export interface AppRunResult {
  appId: string
  runId: string
  sessionKey: string
  outcome: RunOutcome
  startedAt: number
  finishedAt: number
  durationMs: number
  tokensUsed?: number
  errorMessage?: string
  /** Final text output from the AI (used for fallback activity entry) */
  finalText?: string
}

// ============================================
// Automation Run (DB record)
// ============================================

/** Persistent record of an automation run */
export interface AutomationRun {
  runId: string
  appId: string
  sessionKey: string
  status: RunStatus
  triggerType: TriggerType
  triggerData?: Record<string, unknown>
  startedAt: number
  finishedAt?: number
  durationMs?: number
  tokensUsed?: number
  errorMessage?: string
}

// ============================================
// Activity Entries
// ============================================

/** Types of activity entries written by the AI via report_to_user */
export type ActivityEntryType =
  | 'run_complete'
  | 'run_skipped'
  | 'run_error'
  | 'milestone'
  | 'escalation'
  | 'output'

/** Content of an activity entry */
export interface ActivityEntryContent {
  /** Human-readable summary (required, written by AI) */
  summary: string
  /** Run status indicator */
  status?: 'ok' | 'error' | 'skipped'
  /** Run duration in milliseconds */
  durationMs?: number
  /** Error message */
  error?: string
  /** Next retry time (for run_error) */
  nextRetryMs?: number
  /** Structured output data (tables, lists) */
  data?: unknown
  /** Question for the user (escalation only) */
  question?: string
  /** Preset choices for escalation */
  choices?: string[]
  /** File URL for output type */
  outputUrl?: string
}

/** User response to an escalation */
export interface EscalationResponse {
  ts: number
  choice?: string
  text?: string
}

/** A single Activity Thread entry */
export interface ActivityEntry {
  id: string
  appId: string
  runId: string
  type: ActivityEntryType
  ts: number
  sessionKey?: string
  content: ActivityEntryContent
  userResponse?: EscalationResponse
}

// ============================================
// App Runtime State
// ============================================

/** Real-time state of an automation App (for UI display) */
export interface AutomationAppState {
  /**
   * - running:      Actively executing a run right now
   * - queued:       Manually triggered; waiting for a global concurrency slot
   * - idle:         Active and scheduled, no run in progress
   * - paused:       User paused the app; subscriptions inactive
   * - waiting_user: AI escalated; awaiting user decision
   * - error:        Consecutive failures hit threshold; auto-disabled
   */
  status: 'running' | 'queued' | 'idle' | 'paused' | 'waiting_user' | 'error'
  nextRunAtMs?: number
  runningAtMs?: number
  /** Run ID of the currently executing run (only set when status === 'running') */
  runningRunId?: string
  /** Session key of the currently executing run (only set when status === 'running') */
  runningSessionKey?: string
  lastRunAtMs?: number
  lastStatus?: 'ok' | 'error' | 'skipped'
  lastError?: string
  lastDurationMs?: number
  consecutiveErrors?: number
  pendingEscalationId?: string
}

// ============================================
// Query Options
// ============================================

/** Options for querying activity entries */
export interface ActivityQueryOptions {
  limit?: number
  offset?: number
  type?: ActivityEntryType
  since?: number
}

// ============================================
// Internal Activation State
// ============================================

/** Tracks resources for an activated App (not exported publicly) */
export interface ActivationState {
  appId: string
  /** Scheduler job IDs registered for this App */
  schedulerJobIds: string[]
  /** Event-bus unsubscribe functions */
  eventUnsubscribers: Array<() => void>
  /** Keep-alive disposer from background service */
  keepAliveDisposer: (() => void) | null
}

// ============================================
// Service Dependencies
// ============================================

/** Dependencies injected into the runtime service */
export interface AppRuntimeDeps {
  store: import('./store').ActivityStore
  appManager: import('../manager').AppManagerService
  scheduler: import('../../platform/scheduler').SchedulerService
  eventBus: import('../../platform/event-bus').EventBusService
  memory: import('../../platform/memory').MemoryService
  background: import('../../platform/background').BackgroundService
  getSpacePath: (spaceId: string) => string | null
}

// ============================================
// Service Interface
// ============================================

/**
 * App Runtime Service -- the core execution engine.
 *
 * This is the public API consumed by IPC handlers and bootstrap.
 */
export interface AppRuntimeService {
  // ── Activation ──────────────────────────────

  /**
   * Activate an App: register scheduler jobs + event-bus subscriptions.
   * Idempotent -- safe to call multiple times for the same App.
   *
   * @throws AppNotFoundError if the App does not exist
   */
  activate(appId: string): Promise<void>

  /**
   * Deactivate an App: remove scheduler jobs + event-bus subscriptions.
   * Idempotent -- safe to call for non-activated Apps.
   */
  deactivate(appId: string): Promise<void>

  /**
   * Hot-sync scheduler jobs for an activated App without interrupting
   * running executions. Re-reads the App's current config/overrides and
   * updates (remove + re-add) any scheduler jobs whose schedule has changed.
   *
   * No-op if the App is not currently activated.
   */
  syncAppSchedule(appId: string): void

  // ── Execution ───────────────────────────────

  /**
   * Manually trigger an App execution.
   * Respects concurrency limits.
   */
  triggerManually(appId: string): Promise<AppRunResult>

  // ── State Queries ───────────────────────────

  /**
   * Get the real-time state of an automation App.
   * Combines manager state with runtime scheduling info.
   */
  getAppState(appId: string): AutomationAppState

  // ── Escalation ──────────────────────────────

  /**
   * Respond to an escalation: triggers a follow-up run with
   * the escalation context and user's response.
   */
  respondToEscalation(
    appId: string,
    entryId: string,
    response: EscalationResponse
  ): Promise<void>

  // ── Activity Queries ────────────────────────

  /** Get activity entries for an App */
  getActivityEntries(appId: string, options?: ActivityQueryOptions): ActivityEntry[]

  /** Get a specific run record */
  getRun(runId: string): AutomationRun | null

  /** Get runs for an App */
  getRunsForApp(appId: string, limit?: number): AutomationRun[]

  // ── Lifecycle ───────────────────────────────

  /** Activate all Apps with status='active'. Called at bootstrap. */
  activateAll(): Promise<void>

  /** Deactivate all Apps. Called at shutdown. */
  deactivateAll(): Promise<void>
}
