import { join } from 'node:path';
import log from 'electron-log/main.js';
import type { ScopedLogger, LogConfig } from './types';
export type { ScopedLogger, LogConfig } from './types';
export { cleanupOldLogs } from './log-cleanup';

export function createLogResolvePath(logDir: string) {
  return () => {
    const dateStr = new Date().toISOString().split('T')[0];
    return join(logDir, `main-${dateStr}.log`);
  };
}

/**
 * Initialize the logging system.
 * Must be called early in app startup (after electron imports, before other modules).
 *
 * Responsibilities:
 * 1. log.initialize() — enable renderer IPC transport
 * 2. Configure file/console transport levels
 * 3. Configure log file path and size (daily rotation)
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

  // Daily log rotation: main-YYYY-MM-DD.log
  log.transports.file.resolvePathFn = createLogResolvePath(logDir);

  // Filter periodic heartbeat/polling noise from file transport only.
  // Console output is unaffected — dev mode still sees all logs.
  log.hooks.push((message, transport) => {
    if (transport !== log.transports.file) return message;
    if (message.level === 'debug') return false;

    const text = String(message.data?.[0] ?? '');

    const heartbeatPatterns = [
      '[SSHManager] Connection closed, reason:',
      '[SSHManager] Ready event fired - connection ready',
      '[SSHManager] Already connected to same server',
      '[SSHManager] Cleaning up existing connection',
      '[SSHManager] Connecting with basic config',
      '[Health][Runtime] Running passive status collection',
      '[Health][Runtime] Passive check complete:',
      '[Health][Runtime] Debounced: returning cached',
      'heartbeat from worker',
      'extended deadline by',
      'Message sent: ping',
    ];

    for (const pattern of heartbeatPatterns) {
      if (text.includes(pattern)) return false;
    }

    return message;
  });

  Object.assign(console, log.functions);
}

/**
 * Create a scoped logger for a module.
 * Output format: [scope] Your message here
 */
export function createLogger(scope: string): ScopedLogger {
  return log.create({ logId: scope }) as unknown as ScopedLogger;
}
