/**
 * Scoped Logger Utility
 *
 * Uses electron-log's log.create() API to create per-module loggers.
 * Debug-level calls are no-ops in production (log.transports.console.level = 'info').
 * Error/warn/info calls always pass through.
 *
 * Usage:
 *   import { createLogger } from '../utils/logger'
 *   const log = createLogger('remote-ws')
 *   log.debug('hot path message')   // only shows in dev
 *   log.info('lifecycle event')      // always shows
 *   log.error('something failed')    // always shows
 */
import log from 'electron-log/main.js'

export type LogFn = (...params: any[]) => void

export interface ScopedLogger {
  debug: LogFn
  info: LogFn
  warn: LogFn
  error: LogFn
  silly: LogFn
}

/**
 * Create a scoped logger for a module.
 * Output format: [scope] Your message here
 */
export function createLogger(scope: string): ScopedLogger {
  return log.create({ logId: scope }) as unknown as ScopedLogger
}
