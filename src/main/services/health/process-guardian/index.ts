/**
 * Process Guardian Module
 *
 * Central module for process tracking and orphan cleanup.
 * Exports all process management functionality.
 */

// Re-export registry functions
export {
  markInstanceStart,
  getCurrentInstanceId,
  getPreviousInstanceId,
  loadRegistry,
  registerProcess,
  unregisterProcess,
  updateHeartbeat,
  getCurrentProcesses,
  getOrphanProcesses,
  clearOrphanEntries,
  markCleanExit,
  wasLastExitClean,
  getRegistryStats
} from './registry'

// Re-export cleaner functions
export {
  cleanupOrphans,
  forceKillProcess,
  isAicoBotManagedProcess,
  getRunningAicoBotProcesses,
  verifyCleanup
} from './cleaner'

// Re-export platform operations
export { getPlatformOps } from './platform'

// Re-export types
export type { ProcessEntry, ProcessType, CleanupResult } from '../types'
