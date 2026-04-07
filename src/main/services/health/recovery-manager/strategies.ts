/**
 * Recovery Strategies - Definitions and configurations
 *
 * Defines the available recovery strategies and their parameters.
 * - S1: Restart Single Process (no consent)
 * - S2: Reset Agent Engine (no consent)
 * - S3: Restart App (requires consent)
 * - S4: Factory Reset (requires consent, manual only)
 */

import type { RecoveryStrategy, RecoveryStrategyId } from '../types'

/**
 * All available recovery strategies
 */
export const RECOVERY_STRATEGIES: Record<RecoveryStrategyId, RecoveryStrategy> = {
  S1: {
    id: 'S1',
    name: 'Restart Single Process',
    description: 'Kills and recreates a single unhealthy process',
    trigger: 'Single process unhealthy',
    actions: [
      'Kill the unhealthy process',
      'Wait for process to terminate',
      'Process will be recreated on next use'
    ],
    requiresConsent: false
  },

  S2: {
    id: 'S2',
    name: 'Reset Agent Engine',
    description: 'Kills all V2 sessions and restarts the OpenAI Router',
    trigger: '3+ consecutive agent errors',
    actions: [
      'Close all active V2 sessions',
      'Kill all SDK CLI processes',
      'Restart OpenAI compat router (if active)',
      'Clear agent error counters'
    ],
    requiresConsent: false
  },

  S3: {
    id: 'S3',
    name: 'Restart Application',
    description: 'Completely restarts the AICO-Bot application',
    trigger: '5+ consecutive errors',
    actions: [
      'Save current state (if possible)',
      'Close all windows and processes',
      'Relaunch application'
    ],
    requiresConsent: true
  },

  S4: {
    id: 'S4',
    name: 'Factory Reset',
    description: 'Clears all caches and resets configuration to defaults',
    trigger: 'Manual trigger only',
    actions: [
      'Clear all cached data',
      'Reset configuration to defaults',
      'Clear conversation index (preserves data)',
      'Restart application'
    ],
    requiresConsent: true
  }
}

/**
 * Error thresholds for automatic strategy selection
 */
export const ERROR_THRESHOLDS = {
  /** Trigger S2 (Reset Agent Engine) after this many consecutive errors */
  AGENT_RESET: 3,
  /** Trigger S3 (Restart App) after this many consecutive errors */
  APP_RESTART: 5,
  /** Time window for counting consecutive errors (ms) */
  ERROR_WINDOW_MS: 60_000
}

/**
 * Get strategy by ID
 */
export function getStrategy(id: RecoveryStrategyId): RecoveryStrategy {
  return RECOVERY_STRATEGIES[id]
}

/**
 * Select appropriate recovery strategy based on error count
 */
export function selectRecoveryStrategy(
  errorCount: number,
  source: string
): RecoveryStrategyId | null {
  // S2: Reset agent engine after 3+ errors
  if (errorCount >= ERROR_THRESHOLDS.AGENT_RESET && errorCount < ERROR_THRESHOLDS.APP_RESTART) {
    // Only for agent-related errors
    if (source.includes('agent') || source.includes('session')) {
      return 'S2'
    }
  }

  // S3: Restart app after 5+ errors
  if (errorCount >= ERROR_THRESHOLDS.APP_RESTART) {
    return 'S3'
  }

  // S1: For single process issues (handled case-by-case)
  return null
}

/**
 * Check if a strategy requires user consent
 */
export function requiresConsent(strategyId: RecoveryStrategyId): boolean {
  return RECOVERY_STRATEGIES[strategyId].requiresConsent
}
