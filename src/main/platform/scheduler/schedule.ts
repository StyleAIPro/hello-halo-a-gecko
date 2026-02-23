/**
 * platform/scheduler -- Schedule Computation
 *
 * Pure functions for computing next run times from schedule definitions.
 * This is the mathematical core of the scheduler, with no side effects.
 *
 * Supported schedule kinds:
 * - `every` (anchor-grid alignment): The run grid is anchor, anchor+every, ...
 *   computeNextRun() always returns the first grid point strictly after `now`.
 *   This prevents catch-up storms after offline periods.
 * - `cron` (croner library): Standard 5-part or 6-part cron expressions with
 *   optional IANA timezone. Same no-catch-up-storm semantics.
 * - `once`: Single future execution at an absolute timestamp.
 */

import { Cron } from 'croner'
import type { Schedule } from './types'

// ---------------------------------------------------------------------------
// Interval parsing
// ---------------------------------------------------------------------------

/**
 * Minimum allowed interval in milliseconds (10 seconds).
 * Prevents CPU thrashing from overly aggressive schedules.
 */
const MIN_INTERVAL_MS = 10_000

/**
 * Parse a human-readable interval string into milliseconds.
 *
 * Supported formats:
 *   "30s"  -> 30,000
 *   "5m"   -> 300,000
 *   "2h"   -> 7,200,000
 *   "1d"   -> 86,400,000
 *   "1.5h" -> 5,400,000
 *
 * @throws {Error} If the string cannot be parsed.
 */
export function parseEveryString(every: string): number {
  const trimmed = every.trim().toLowerCase()
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/)
  if (!match) {
    throw new Error(
      `Invalid interval string "${every}". ` +
      'Expected format: "<number><unit>" where unit is s, m, h, or d. ' +
      'Examples: "30s", "5m", "2h", "1d".'
    )
  }

  const value = parseFloat(match[1])
  const unit = match[2]

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid interval value "${every}": value must be a positive number.`)
  }

  let ms: number
  switch (unit) {
    case 's':
      ms = value * 1_000
      break
    case 'm':
      ms = value * 60_000
      break
    case 'h':
      ms = value * 3_600_000
      break
    case 'd':
      ms = value * 86_400_000
      break
    default:
      throw new Error(`Unknown interval unit "${unit}" in "${every}".`)
  }

  return Math.max(MIN_INTERVAL_MS, Math.floor(ms))
}

// ---------------------------------------------------------------------------
// Next run computation
// ---------------------------------------------------------------------------

/**
 * Compute the next run time for an `every` schedule using anchor-grid alignment.
 *
 * The run grid is: anchor, anchor + every, anchor + 2*every, ...
 * Returns the first grid point strictly after `nowMs`.
 *
 * Edge cases:
 * - `nowMs < anchorMs`: Returns `anchorMs` (job hasn't started yet).
 * - `nowMs === anchorMs`: Returns `anchorMs + everyMs` (anchor is "now", next is one step ahead).
 * - Process was offline for many periods: Returns only the next future grid point.
 * - Clock rollback: `Math.ceil` naturally handles this.
 *
 * @param anchorMs - The grid origin timestamp (epoch ms).
 * @param everyMs - The interval between grid points (ms, must be > 0).
 * @param nowMs - The current time (epoch ms).
 * @returns The next run time (epoch ms), always > nowMs.
 */
export function computeNextRunEvery(anchorMs: number, everyMs: number, nowMs: number): number {
  const interval = Math.max(1, Math.floor(everyMs))
  const anchor = Math.max(0, Math.floor(anchorMs))

  if (nowMs < anchor) {
    return anchor
  }

  const elapsed = nowMs - anchor
  // Math.ceil(elapsed / interval) gives the number of complete intervals since
  // anchor. We want the NEXT grid point after now, so use ceil. However, if
  // nowMs falls exactly on a grid point, ceil returns that point, which is not
  // "strictly after now". We handle this by using (elapsed / interval) and
  // checking for exact alignment.
  //
  // Equivalent alternative: Math.floor((elapsed + interval - 1) / interval)
  // This is equivalent to Math.ceil(elapsed / interval) for non-zero elapsed,
  // and correctly returns 1 when elapsed is 0 (i.e., now === anchor).
  const steps = Math.max(1, Math.ceil(elapsed / interval) || 1)

  const candidate = anchor + steps * interval
  // If candidate === nowMs (exact grid alignment), advance by one more step
  if (candidate <= nowMs) {
    return anchor + (steps + 1) * interval
  }
  return candidate
}

/**
 * Compute the next run time for a `once` schedule.
 *
 * Returns the scheduled time if it is in the future, or undefined if it has
 * already passed (and presumably already been executed).
 *
 * @param onceMs - The target execution time (epoch ms).
 * @param nowMs - The current time (epoch ms).
 * @returns The next run time, or undefined if the time has passed.
 */
export function computeNextRunOnce(onceMs: number, nowMs: number): number | undefined {
  return onceMs > nowMs ? onceMs : undefined
}

// ---------------------------------------------------------------------------
// Cron computation
// ---------------------------------------------------------------------------

/**
 * Minimum allowed cron expression length.
 * Standard 5-part cron ("* * * * *") is 9 chars.
 */
const MIN_CRON_LENGTH = 5

/**
 * Compute the next run time for a `cron` schedule.
 *
 * Uses the `croner` library (zero-dependency cron parser) to evaluate standard
 * cron expressions with optional timezone support.
 *
 * Supported cron formats:
 *   - Standard 5-part:  "minute hour dom month dow"     e.g. "0 9 * * *"
 *   - Extended 6-part:  "second minute hour dom month dow"
 *
 * After offline periods, only the NEXT future occurrence is returned (same
 * no-catch-up-storm semantics as the `every` scheduler).
 *
 * @param cron - Standard cron expression string.
 * @param timezone - Optional IANA timezone (e.g. "Asia/Shanghai"). Defaults to system timezone.
 * @param nowMs - The current time (epoch ms).
 * @returns The next run time (epoch ms), or undefined if no future occurrence exists.
 * @throws {Error} If the cron expression is invalid.
 */
export function computeNextRunCron(cron: string, timezone: string | undefined, nowMs: number): number | undefined {
  const trimmed = cron.trim()
  if (trimmed.length < MIN_CRON_LENGTH) {
    throw new Error(
      `Invalid cron expression "${cron}": too short. ` +
      'Expected standard cron format, e.g. "0 9 * * *".'
    )
  }

  try {
    const job = new Cron(trimmed, {
      timezone,
      // Do not schedule execution -- we only need the pattern parser.
      paused: true,
      // Use standard 5-or-6-part mode to avoid ambiguity.
      mode: '5-or-6-parts',
    })

    const nextDate = job.nextRun(new Date(nowMs))
    if (!nextDate) {
      return undefined
    }

    const nextMs = nextDate.getTime()
    // Ensure we always return strictly after nowMs
    return nextMs > nowMs ? nextMs : undefined
  } catch (err) {
    // Re-throw with a more descriptive message
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Invalid cron expression "${cron}": ${message}`
    )
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Compute the next run time for any schedule type.
 *
 * @param schedule - The schedule definition.
 * @param anchorMs - The anchor timestamp (used for `every` schedules).
 * @param nowMs - The current time (epoch ms).
 * @returns The next run time (epoch ms), or undefined if no future run is possible.
 */
export function computeNextRun(schedule: Schedule, anchorMs: number, nowMs: number): number | undefined {
  switch (schedule.kind) {
    case 'every': {
      const everyMs = parseEveryString(schedule.every)
      return computeNextRunEvery(anchorMs, everyMs, nowMs)
    }

    case 'once': {
      return computeNextRunOnce(schedule.once, nowMs)
    }

    case 'cron': {
      return computeNextRunCron(schedule.cron, schedule.timezone, nowMs)
    }

    default: {
      const _exhaustive: never = schedule
      throw new Error(`Unknown schedule kind: ${(_exhaustive as Schedule).kind}`)
    }
  }
}
