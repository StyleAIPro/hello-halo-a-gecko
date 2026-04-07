/**
 * Recovery UI - Native dialog-based recovery prompts
 *
 * Provides user-facing dialogs for recovery actions that require consent.
 * Uses Electron's native dialog API for consistent platform experience.
 *
 * Design reference: health-system-design.md section 7.3
 */

import { dialog, BrowserWindow } from 'electron'
import type { RecoveryStrategyId, RecoveryStrategy } from '../types'
import { getStrategy, RECOVERY_STRATEGIES } from './strategies'

// ============================================
// State
// ============================================

/** Track if user has chosen to suppress dialogs for this session */
let suppressDialogs = false

/** Track recent dialog displays to prevent spam */
let lastDialogTime = 0
const DIALOG_COOLDOWN_MS = 10_000  // 10 seconds between dialogs

// ============================================
// Dialog Options
// ============================================

export type RecoveryDialogResult = {
  /** User's chosen action */
  action: 'tryFix' | 'restart' | 'factoryReset' | 'ignore'
  /** Whether to suppress future dialogs this session */
  suppressFuture: boolean
}

export interface RecoveryDialogOptions {
  /** Error count to display */
  consecutiveFailures: number
  /** Primary error message */
  errorMessage?: string
  /** Suggested strategy (determines which buttons to show) */
  suggestedStrategy: RecoveryStrategyId
  /** Parent window for modal behavior */
  parentWindow?: BrowserWindow | null
}

// ============================================
// Dialog Display
// ============================================

/**
 * Show recovery dialog to user
 *
 * Returns the user's chosen action. If dialogs are suppressed or
 * on cooldown, returns 'ignore' without showing a dialog.
 */
export async function showRecoveryDialog(
  options: RecoveryDialogOptions
): Promise<RecoveryDialogResult> {
  const { consecutiveFailures, errorMessage, suggestedStrategy, parentWindow } = options

  // Check if dialogs are suppressed
  if (suppressDialogs) {
    console.log('[Health][UI] Dialogs suppressed for this session')
    return { action: 'ignore', suppressFuture: true }
  }

  // Check cooldown
  const now = Date.now()
  if (now - lastDialogTime < DIALOG_COOLDOWN_MS) {
    console.log('[Health][UI] Dialog on cooldown')
    return { action: 'ignore', suppressFuture: false }
  }
  lastDialogTime = now

  const strategy = getStrategy(suggestedStrategy)

  // Build dialog message
  const title = 'AICO-Bot is having trouble'
  const message = buildDialogMessage(consecutiveFailures, errorMessage, strategy)

  // Build buttons based on strategy
  const buttons = buildDialogButtons(suggestedStrategy)

  try {
    const result = await dialog.showMessageBox(parentWindow || undefined as any, {
      type: 'warning',
      title,
      message: title,
      detail: message,
      buttons: buttons.labels,
      defaultId: 0,
      cancelId: buttons.labels.length - 1,
      checkboxLabel: "Don't show again this session",
      checkboxChecked: false
    })

    // Handle checkbox
    if (result.checkboxChecked) {
      suppressDialogs = true
    }

    // Map button index to action
    const action = buttons.actions[result.response] || 'ignore'

    console.log(`[Health][UI] User selected: ${action}, suppress: ${result.checkboxChecked}`)

    return {
      action: action as RecoveryDialogResult['action'],
      suppressFuture: result.checkboxChecked
    }
  } catch (error) {
    console.error('[Health][UI] Dialog error:', error)
    return { action: 'ignore', suppressFuture: false }
  }
}

/**
 * Show simple notification dialog (no choices)
 * Internal use only - not exported from module
 */
async function showNotificationDialog(
  title: string,
  message: string,
  type: 'info' | 'warning' | 'error' = 'info',
  parentWindow?: BrowserWindow | null
): Promise<void> {
  try {
    await dialog.showMessageBox(parentWindow || undefined as any, {
      type,
      title,
      message: title,
      detail: message,
      buttons: ['OK']
    })
  } catch (error) {
    console.error('[Health][UI] Notification dialog error:', error)
  }
}

/**
 * Show confirmation dialog for destructive actions
 * Internal use only - not exported from module
 */
async function showConfirmationDialog(
  title: string,
  message: string,
  confirmLabel: string = 'Confirm',
  parentWindow?: BrowserWindow | null
): Promise<boolean> {
  try {
    const result = await dialog.showMessageBox(parentWindow || undefined as any, {
      type: 'warning',
      title,
      message: title,
      detail: message,
      buttons: [confirmLabel, 'Cancel'],
      defaultId: 1,  // Default to Cancel
      cancelId: 1
    })

    return result.response === 0
  } catch (error) {
    console.error('[Health][UI] Confirmation dialog error:', error)
    return false
  }
}

// ============================================
// Dialog Content Builders
// ============================================

function buildDialogMessage(
  failures: number,
  errorMessage: string | undefined,
  strategy: RecoveryStrategy
): string {
  const lines: string[] = []

  // Primary message
  if (errorMessage) {
    lines.push(errorMessage)
  } else {
    lines.push('AI services failed to respond multiple times.')
  }

  lines.push('')  // Empty line

  // Failure count
  lines.push(`Consecutive failures: ${failures}`)

  lines.push('')  // Empty line

  // Strategy description
  lines.push(`Recommended action: ${strategy.name}`)
  lines.push(strategy.description)

  return lines.join('\n')
}

function buildDialogButtons(strategyId: RecoveryStrategyId): {
  labels: string[]
  actions: string[]
} {
  switch (strategyId) {
    case 'S2':
      // Reset Agent Engine - auto recovery, no consent needed
      // But if shown, offer manual options
      return {
        labels: ['Try to Fix', 'Ignore'],
        actions: ['tryFix', 'ignore']
      }

    case 'S3':
      // Restart App - requires consent
      return {
        labels: ['Restart App', 'Try to Fix', 'Ignore'],
        actions: ['restart', 'tryFix', 'ignore']
      }

    case 'S4':
      // Factory Reset - requires consent
      return {
        labels: ['Factory Reset', 'Restart App', 'Ignore'],
        actions: ['factoryReset', 'restart', 'ignore']
      }

    default:
      return {
        labels: ['Try to Fix', 'Ignore'],
        actions: ['tryFix', 'ignore']
      }
  }
}

// ============================================
// State Management
// ============================================

/**
 * Reset dialog suppression (e.g., on new session)
 */
export function resetDialogSuppression(): void {
  suppressDialogs = false
  console.log('[Health][UI] Dialog suppression reset')
}

/**
 * Check if dialogs are currently suppressed
 */
export function isDialogSuppressed(): boolean {
  return suppressDialogs
}

/**
 * Manually suppress dialogs
 */
export function suppressAllDialogs(): void {
  suppressDialogs = true
}

// ============================================
// Specific Recovery Dialogs
// ============================================

/**
 * Show dialog for S3 (Restart App) recovery
 */
export async function showRestartAppDialog(
  failures: number,
  parentWindow?: BrowserWindow | null
): Promise<boolean> {
  const result = await showRecoveryDialog({
    consecutiveFailures: failures,
    suggestedStrategy: 'S3',
    parentWindow
  })

  return result.action === 'restart'
}

/**
 * Show dialog for S4 (Factory Reset) recovery
 */
export async function showFactoryResetDialog(
  parentWindow?: BrowserWindow | null
): Promise<boolean> {
  // Factory reset is destructive, always show confirmation
  return showConfirmationDialog(
    'Factory Reset',
    'This will clear all cached data and reset configuration to defaults.\n\n' +
    'Your conversation data will be preserved, but you will need to reconfigure your API settings.\n\n' +
    'Are you sure you want to continue?',
    'Reset & Restart',
    parentWindow
  )
}

/**
 * Show dialog when recovery succeeded
 */
export async function showRecoverySuccessDialog(
  strategyName: string,
  parentWindow?: BrowserWindow | null
): Promise<void> {
  await showNotificationDialog(
    'Recovery Successful',
    `${strategyName} completed successfully.\n\nAICO-Bot should be working normally now.`,
    'info',
    parentWindow
  )
}

/**
 * Show dialog when recovery failed
 */
export async function showRecoveryFailedDialog(
  strategyName: string,
  errorMessage: string,
  parentWindow?: BrowserWindow | null
): Promise<void> {
  await showNotificationDialog(
    'Recovery Failed',
    `${strategyName} could not be completed.\n\nError: ${errorMessage}\n\n` +
    'You may need to restart AICO-Bot manually or contact support.',
    'error',
    parentWindow
  )
}
