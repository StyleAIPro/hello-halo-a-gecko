import log from 'electron-log/main.js';
import type { ScopedLogger, LogConfig } from './types';
export type { ScopedLogger, LogConfig } from './types';
export { cleanupOldLogs } from './log-cleanup';

/**
 * Initialize the logging system.
 * Must be called early in app startup (after electron imports, before other modules).
 *
 * Responsibilities:
 * 1. log.initialize() — enable renderer IPC transport
 * 2. Configure file/console transport levels
 * 3. Configure log file path and size
 * 4. Object.assign(console, log.functions) — global console replacement
 *
 * Note: log.errorHandler.startCatching() is NOT called here because
 * EPIPE/network-error filters must be registered BEFORE it.
 * Call startCatching() in index.ts after registering those filters.
 */
export function initLogger(config: LogConfig): void {
  const {
    logDir,
    isDev,
    fileLevel = 'info',
    consoleLevel = isDev ? 'debug' : 'info',
    maxFileSize = 5 * 1024 * 1024,
  } = config;

  log.initialize();
  log.transports.file.level = fileLevel;
  log.transports.console.level = consoleLevel;
  log.transports.file.maxSize = maxFileSize;
  log.transports.file.resolvePathFn = () => logDir;

  Object.assign(console, log.functions);
}

/**
 * Create a scoped logger for a module.
 * Output format: [scope] Your message here
 */
export function createLogger(scope: string): ScopedLogger {
  return log.create({ logId: scope }) as unknown as ScopedLogger;
}
