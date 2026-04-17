/**
 * Health Checker Module
 *
 * Exports startup checks, runtime monitoring, and event handling.
 */

// Startup checks
export { runStartupChecks, runQuickHealthCheck } from './startup-checker';

// Runtime monitoring
export {
  startFallbackPolling,
  stopFallbackPolling,
  isPollingActive,
  runImmediateCheck,
  getRuntimeStatus,
  runPpidScanAndCleanup,
} from './runtime-checker';

// Event handling
export {
  onHealthEvent,
  emitHealthEvent,
  trackError,
  resetErrorCounter,
  getErrorCount,
  getTotalErrorCount,
  getRecentEvents,
  clearRecentEvents,
  emitAgentError,
  emitProcessExit,
  emitRendererCrash,
  emitRendererUnresponsive,
  emitNetworkError,
  emitConfigChange,
  emitRecoverySuccess,
  emitStartupCheck,
} from './event-listener';

// Probes (for direct access if needed)
export { runConfigProbe } from './probes/config-probe';
export { runPortProbe, findAvailablePort } from './probes/port-probe';
export { runDiskProbe } from './probes/disk-probe';
export { runProcessProbe } from './probes/process-probe';
export { checkOpenAIRouter, checkHttpServer } from './probes/service-probe';
