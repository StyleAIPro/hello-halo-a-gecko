/**
 * Bootstrap State - Centralized state management for bootstrap lifecycle
 *
 * This module provides a pull-based mechanism for renderer to query bootstrap status,
 * complementing the push-based event system. This is particularly useful for:
 *
 * 1. HMR (Hot Module Replacement): When renderer reloads, main process won't re-emit
 *    the bootstrap:extended-ready event. Renderer can query current state instead.
 *
 * 2. Error Recovery: If renderer crashes and restarts, it can immediately know
 *    whether services are ready without waiting for timeout.
 *
 * 3. Race Conditions: Eliminates timing issues where renderer mounts after
 *    the event was already sent.
 */

import { ipcMain } from 'electron';

export interface BootstrapStatus {
  /** Whether extended services have been initialized */
  extendedReady: boolean;
  /** Timestamp when extended services became ready (0 if not ready) */
  extendedReadyAt: number;
}

// Internal state
let extendedServicesReady = false;
let extendedReadyTimestamp = 0;

/**
 * Mark extended services as ready
 * Called after initializeExtendedServices completes
 */
export function markExtendedServicesReady(): void {
  extendedServicesReady = true;
  extendedReadyTimestamp = Date.now();
  console.log('[Bootstrap] Extended services marked as ready');
}

/**
 * Get current bootstrap status
 * Used by IPC handler for renderer queries
 */
export function getBootstrapStatus(): BootstrapStatus {
  return {
    extendedReady: extendedServicesReady,
    extendedReadyAt: extendedReadyTimestamp,
  };
}

/**
 * Register IPC handler for bootstrap status queries
 * Should be called during essential services initialization (before extended)
 */
export function registerBootstrapStatusHandler(): void {
  ipcMain.handle('bootstrap:get-status', () => {
    // Return standard IpcResponse format for consistency with other handlers
    return {
      success: true,
      data: getBootstrapStatus(),
    };
  });
  console.log('[Bootstrap] Status handler registered');
}
