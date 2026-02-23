/**
 * platform/background -- Type Definitions
 *
 * Public interface for the background service module.
 * This module manages process survival, system tray, and the daemon browser.
 */

import type { BrowserWindow } from 'electron'

/**
 * Background service operational status.
 * - online: Automation tasks are allowed to run.
 * - offline: Automation tasks should be paused.
 */
export type BackgroundStatus = 'online' | 'offline'

/**
 * Callback for status change events.
 */
export type StatusChangeHandler = (status: BackgroundStatus) => void

/**
 * Function to unsubscribe from an event or unregister a resource.
 */
export type Unsubscribe = () => void

/**
 * BackgroundService -- The public contract consumed by apps/runtime and bootstrap.
 *
 * This interface is the sole dependency boundary. Consumers import only this type
 * and never reach into internal modules.
 */
export interface BackgroundService {
  // ──────────────────────────────────────────────
  // System Tray
  // ──────────────────────────────────────────────

  /**
   * Initialize the system tray icon and context menu.
   * Safe to call multiple times (idempotent).
   */
  initTray(): void

  // ──────────────────────────────────────────────
  // Keep-Alive
  // ──────────────────────────────────────────────

  /**
   * Check whether any keep-alive reasons are currently registered.
   * If true, the Electron process should NOT quit when all windows close.
   */
  shouldKeepAlive(): boolean

  /**
   * Register a reason to keep the process alive.
   * Returns an unsubscribe function that removes the reason.
   *
   * If the caller crashes without calling the disposer, the reason will
   * be auto-pruned after MAX_KEEP_ALIVE_TTL (default: 24 hours).
   *
   * @param reason - A unique identifier for this keep-alive reason (e.g. "app:jd-price-monitor")
   * @returns Unsubscribe function to remove this reason
   */
  registerKeepAliveReason(reason: string): Unsubscribe

  // ──────────────────────────────────────────────
  // Daemon Browser Window
  // ──────────────────────────────────────────────

  /**
   * Acquire the shared daemon BrowserWindow for a given URL.
   * The URL determines the session partition (domain-level isolation).
   *
   * V1: Single shared window with task queuing. Only one caller can use
   * the window at a time. Subsequent calls will wait in a FIFO queue.
   *
   * The returned BrowserWindow has stealth scripts injected and uses
   * `persist:automation-{domain}` as its session partition.
   *
   * Callers MUST call releaseDaemonBrowserWindow() when done.
   *
   * @param url - The target URL (used to derive the partition)
   * @returns The shared hidden BrowserWindow
   */
  getDaemonBrowserWindow(url: string): Promise<BrowserWindow>

  /**
   * Release the daemon BrowserWindow after use.
   * This allows the next queued caller to proceed.
   */
  releaseDaemonBrowserWindow(): void

  // ──────────────────────────────────────────────
  // Online / Offline Status
  // ──────────────────────────────────────────────

  /**
   * Get the current operational status.
   */
  getStatus(): BackgroundStatus

  /**
   * Set the status to online (automation tasks may run).
   */
  goOnline(): void

  /**
   * Set the status to offline (automation tasks should pause).
   */
  goOffline(): void

  /**
   * Subscribe to status change events.
   * @returns Unsubscribe function
   */
  onStatusChange(handler: StatusChangeHandler): Unsubscribe
}
