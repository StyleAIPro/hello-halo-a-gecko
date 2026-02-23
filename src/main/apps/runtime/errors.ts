/**
 * apps/runtime -- Error Types
 *
 * Domain-specific errors for the App execution engine.
 */

import type { AppStatus } from '../manager'

/**
 * Thrown when attempting to execute an App that is not in a runnable state.
 */
export class AppNotRunnableError extends Error {
  readonly name = 'AppNotRunnableError'
  readonly appId: string
  readonly status: AppStatus

  constructor(appId: string, status: AppStatus) {
    super(`App ${appId} is not runnable (status: ${status})`)
    this.appId = appId
    this.status = status
  }
}

/**
 * Thrown when attempting to activate an App that has no subscriptions.
 */
export class NoSubscriptionsError extends Error {
  readonly name = 'NoSubscriptionsError'
  readonly appId: string

  constructor(appId: string) {
    super(`App ${appId} has no subscriptions to activate`)
    this.appId = appId
  }
}

/**
 * Thrown when concurrency limit is reached and the caller cannot wait.
 */
export class ConcurrencyLimitError extends Error {
  readonly name = 'ConcurrencyLimitError'
  readonly maxConcurrent: number

  constructor(maxConcurrent: number) {
    super(`Concurrency limit reached (max: ${maxConcurrent})`)
    this.maxConcurrent = maxConcurrent
  }
}

/**
 * Thrown when an escalation entry is not found or has already been responded to.
 */
export class EscalationNotFoundError extends Error {
  readonly name = 'EscalationNotFoundError'
  readonly appId: string
  readonly entryId: string

  constructor(appId: string, entryId: string) {
    super(`Escalation not found: app=${appId}, entry=${entryId}`)
    this.appId = appId
    this.entryId = entryId
  }
}

/**
 * Thrown when an App execution fails due to an Agent/SDK error.
 */
export class RunExecutionError extends Error {
  readonly name = 'RunExecutionError'
  readonly appId: string
  readonly runId: string

  constructor(appId: string, runId: string, cause: string) {
    super(`Run execution failed: app=${appId}, run=${runId}: ${cause}`)
    this.appId = appId
    this.runId = runId
  }
}
