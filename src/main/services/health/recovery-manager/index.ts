/**
 * Recovery Manager Module
 *
 * Exports recovery strategy definitions and execution functions.
 */

// Strategies
export {
  RECOVERY_STRATEGIES,
  ERROR_THRESHOLDS,
  getStrategy,
  selectRecoveryStrategy,
  requiresConsent,
} from './strategies';

// Executor
export {
  executeRecovery,
  executeRecoveryWithUI,
  injectSessionCleanup,
  canRecover,
  getRecoveryStats,
  updateErrorCount,
  requestRecoveryConsent,
} from './executor';

// UI
export {
  showRecoveryDialog,
  showRestartAppDialog,
  showFactoryResetDialog,
  showRecoverySuccessDialog,
  showRecoveryFailedDialog,
  resetDialogSuppression,
  isDialogSuppressed,
  suppressAllDialogs,
} from './ui';
export type { RecoveryDialogResult, RecoveryDialogOptions } from './ui';

// Re-export types
export type { RecoveryStrategy, RecoveryResult, RecoveryStrategyId } from '../types';
