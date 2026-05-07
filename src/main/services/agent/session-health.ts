/**
 * Agent Module - Session Health
 *
 * Manages session health monitoring including:
 * - Health check configuration and periodic polling
 * - Session activity tracking (prevents false-positive stuck detection)
 * - Process exit listener for immediate cleanup
 * - Idle session cleanup timer
 */

import { registerProcess, unregisterProcess, getCurrentInstanceId } from '../health';
import type { V2SDKSession } from './types';
import { activeSessions, v2Sessions } from './session-lifecycle';

// ============================================
// Session Health Check
// ============================================

/**
 * Session health check configuration
 */
const HEALTH_CHECK_CONFIG = {
  // Maximum consecutive health check failures before forcing restart
  maxFailures: 5, // Increased from 3 to allow more transient failures
  // Health check interval in ms
  checkInterval: 60 * 1000, // 60 seconds (increased from 30s to reduce false positives)
  // Request timeout threshold (requests taking longer are considered stuck)
  // Increased to 45 minutes for long-running operations like deployments, large refactors, etc.
  requestTimeout: 45 * 60 * 1000, // 45 minutes (increased from 15 minutes)
  // Warning threshold - notify user before timeout
  warningThreshold: 30 * 60 * 1000, // 30 minutes
} as const;

/**
 * Track session health status
 */
interface SessionHealthStatus {
  consecutiveFailures: number;
  lastHealthCheck: number;
  lastRequestStart?: number;
  lastActivityAt: number; // Track last activity time (streaming data received)
  isHealthy: boolean;
}

const sessionHealthMap = new Map<string, SessionHealthStatus>();

/**
 * Update session health status
 */
function updateSessionHealth(conversationId: string, isHealthy: boolean): void {
  const existing = sessionHealthMap.get(conversationId);
  const now = Date.now();

  if (isHealthy) {
    sessionHealthMap.set(conversationId, {
      consecutiveFailures: 0,
      lastHealthCheck: now,
      lastRequestStart: existing?.lastRequestStart,
      lastActivityAt: existing?.lastActivityAt ?? now, // Preserve activity time
      isHealthy: true,
    });
  } else {
    const failures = (existing?.consecutiveFailures ?? 0) + 1;
    const needsRestart = failures >= HEALTH_CHECK_CONFIG.maxFailures;

    console.log(
      `[Agent][${conversationId}] Health check failed (failures: ${failures}/${HEALTH_CHECK_CONFIG.maxFailures})`,
    );

    sessionHealthMap.set(conversationId, {
      consecutiveFailures: failures,
      lastHealthCheck: now,
      lastRequestStart: existing?.lastRequestStart,
      lastActivityAt: existing?.lastActivityAt ?? now, // Preserve activity time
      isHealthy: !needsRestart,
    });

    if (needsRestart) {
      console.log(`[Agent][${conversationId}] Too many health failures, marking for restart`);
    }
  }
}

/**
 * Mark session request start for timeout tracking
 */
export function markSessionRequestStart(conversationId: string): void {
  const existing = sessionHealthMap.get(conversationId);
  const now = Date.now();
  sessionHealthMap.set(conversationId, {
    consecutiveFailures: 0,
    lastHealthCheck: now,
    lastRequestStart: now,
    lastActivityAt: now, // Initialize activity time
    isHealthy: true,
  });
}

/**
 * Mark session request complete
 */
export function markSessionRequestComplete(conversationId: string): void {
  const existing = sessionHealthMap.get(conversationId);
  if (existing) {
    existing.lastRequestStart = undefined;
    sessionHealthMap.set(conversationId, existing);
  }
}

/**
 * Update session activity timestamp (called when streaming data is received)
 * This prevents false positives where long-running tasks are marked as stuck
 */
export function markSessionActivity(conversationId: string): void {
  const existing = sessionHealthMap.get(conversationId);
  if (existing) {
    existing.lastActivityAt = Date.now();
    sessionHealthMap.set(conversationId, existing);
  }
}

/**
 * Check if a session is stuck (no activity for too long)
 *
 * Only considers idle duration (time since last activity), NOT cumulative request duration.
 * This ensures long-running tasks (large refactors, builds, etc.) are never killed
 * as long as they keep producing activity (streaming data, tool calls, etc.).
 *
 * A session is only considered stuck when it has been running for at least 5 minutes
 * AND has had no activity for the configured idle threshold (45 minutes).
 */
function isSessionStuck(conversationId: string): boolean {
  const health = sessionHealthMap.get(conversationId);
  if (!health?.lastRequestStart) return false;

  const now = Date.now();
  const requestDuration = now - health.lastRequestStart;
  const timeSinceActivity = now - health.lastActivityAt;

  // Session is stuck only if:
  // 1. Request has been running for a while (> 5 minutes) AND
  // 2. No activity received for the idle threshold
  // We intentionally do NOT check cumulative duration — long-running tasks
  // (builds, deployments, large refactors) may legitimately run for hours.
  const hasStarted = requestDuration > 5 * 60 * 1000;
  const isIdle = timeSinceActivity > HEALTH_CHECK_CONFIG.requestTimeout;

  if (hasStarted && isIdle) {
    console.log(
      `[Agent][${conversationId}] Session stuck: request=${Math.round(requestDuration / 60000)}m, ` +
        `idle=${Math.round(timeSinceActivity / 60000)}m`,
    );
    return true;
  }

  return false;
}

/**
 * Check if a V2 session's underlying process is still alive and ready.
 *
 * This checks the SDK's internal transport state, which is the Single Source of Truth
 * for process health. The transport.ready flag is set to false when:
 * - Process exits (normal or abnormal)
 * - Process is killed (OOM, signal, etc.)
 * - Transport is closed
 *
 * Why this is needed:
 * - The CC subprocess may be killed by OS (OOM, etc.) or crash unexpectedly
 * - Our v2Sessions Map doesn't automatically detect this
 * - Without this check, we'd try to reuse a dead session and get "ProcessTransport is not ready" error
 *
 * @param session - The V2 SDK session to check
 * @param conversationId - Conversation ID for health tracking
 * @returns true if the session is ready for use, false if process is dead
 */
export function isSessionTransportReady(
  session: V2SDKSession,
  conversationId?: string,
): boolean {
  try {
    // Access SDK internal state: session.query.transport
    // This is the authoritative source for process health
    const query = (session as any).query;
    const transport = query?.transport;

    if (!transport) {
      // No transport means session is definitely not ready
      if (conversationId) updateSessionHealth(conversationId, false);
      return false;
    }

    // Check using isReady() method if available (preferred)
    if (typeof transport.isReady === 'function') {
      const ready = transport.isReady();
      if (conversationId) updateSessionHealth(conversationId, ready);
      return ready;
    }

    // Fallback to ready property
    if (typeof transport.ready === 'boolean') {
      const ready = transport.ready;
      if (conversationId) updateSessionHealth(conversationId, ready);
      return ready;
    }

    // If we can't determine state, assume it's ready (conservative approach)
    // This prevents unnecessary session recreation if SDK structure changes
    if (conversationId) updateSessionHealth(conversationId, true);
    return true;
  } catch (e) {
    // If any error occurs during check, log and assume session is invalid
    // Better to recreate than to fail with cryptic error
    console.error(`[Agent] Error checking session transport state:`, e);
    if (conversationId) updateSessionHealth(conversationId, false);
    return false;
  }
}

// ============================================
// Process Exit Listener
// ============================================

/**
 * Register a listener for process exit events.
 *
 * This is event-driven cleanup (better than polling):
 * - When the CC subprocess dies (OOM, crash, signal), we get notified immediately
 * - We then call session.close() to release resources (FDs, memory)
 * - This prevents resource leaks without waiting for the next polling cycle
 *
 * Why this is important:
 * - Each session holds 3 FDs (stdin/stdout/stderr pipes) on the parent process side
 * - If process dies but we don't close(), these FDs leak
 * - Accumulated FD leaks can cause "spawn EBADF" errors
 *
 * @param session - The V2 SDK session
 * @param conversationId - Conversation ID for logging and cleanup
 */
export function registerProcessExitListener(
  session: V2SDKSession,
  conversationId: string,
): void {
  try {
    // Access SDK internal transport to register exit listener
    const transport = (session as any).query?.transport;

    if (!transport) {
      console.warn(`[Agent][${conversationId}] Cannot register exit listener: no transport`);
      return;
    }

    // SDK provides onExit(callback) method for process exit notification
    if (typeof transport.onExit === 'function') {
      const unsubscribe = transport.onExit((error: Error | undefined) => {
        // Guard: only cleanup if this session is still the active one for this conversationId.
        // Race condition: when a session is rebuilt (e.g., config change), the old session's
        // process may exit AFTER the new session is stored in v2Sessions under the same key.
        // Without this check, the old process exit would accidentally close the new session.
        const currentInfo = v2Sessions.get(conversationId);
        if (currentInfo?.session !== session) {
          console.log(
            `[Agent][${conversationId}] Process exited but session was replaced, skipping cleanup`,
          );
          return;
        }
        const errorMsg = error ? `: ${error.message}` : '';
        cleanupSession(conversationId, `process exited${errorMsg}`);
        console.log(`[Agent][${conversationId}] Remaining sessions: ${v2Sessions.size}`);
      });

      console.log(`[Agent][${conversationId}] Process exit listener registered`);

      // Note: unsubscribe is returned but we don't need to call it
      // The listener will be automatically removed when transport.close() is called
    } else {
      console.warn(
        `[Agent][${conversationId}] SDK transport.onExit not available, relying on polling cleanup`,
      );
    }
  } catch (e) {
    console.error(`[Agent][${conversationId}] Failed to register exit listener:`, e);
    // Not fatal - we still have polling cleanup as fallback
  }
}

// ============================================
// Session Cleanup (Polling Fallback)
// ============================================

// Session cleanup interval (clean up sessions not used for 30 minutes)
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
let cleanupIntervalId: NodeJS.Timeout | null = null;

/**
 * Clean up a single V2 session: close, unregister, remove from map.
 *
 * This is the single source of truth for session cleanup logic.
 * All cleanup paths should use this function to ensure consistency.
 *
 * @param conversationId - Conversation ID to clean up
 * @param reason - Reason for cleanup (for logging)
 * @param skipMapCheck - If true, skip checking if session exists in map (for batch operations)
 */
export function cleanupSession(
  conversationId: string,
  reason: string,
  skipMapCheck = false,
): void {
  const info = v2Sessions.get(conversationId);
  if (!info && !skipMapCheck) return;

  console.log(`[Agent][${conversationId}] Cleaning up session: ${reason}`);

  if (info) {
    try {
      info.session.close(); // Release FDs (stdin/stdout/stderr pipes)
    } catch (e: any) {
      // Ignore close errors - session may already be dead
      // Log EPIPE errors specifically (process already exited)
      if (e?.code === 'EPIPE' || e?.message?.includes('EPIPE')) {
        console.log(`[Agent][${conversationId}] Session close: EPIPE (process already exited)`);
      }
    }
  }

  unregisterProcess(conversationId, 'v2-session');
  v2Sessions.delete(conversationId);
}

/**
 * Force restart a stuck or unhealthy session
 */
function forceRestartSession(conversationId: string, reason: string): void {
  console.log(`[Agent][${conversationId}] Force restarting session: ${reason}`);
  cleanupSession(conversationId, reason);
  sessionHealthMap.delete(conversationId);
}

/**
 * Clear health state for a session (used by compactContext fallback)
 */
export function clearSessionHealth(conversationId: string): void {
  sessionHealthMap.delete(conversationId);
}

/**
 * Start the session cleanup interval (polling fallback)
 *
 * This is a fallback mechanism for cases where onExit listener doesn't fire:
 * - SDK structure changes and onExit is not available
 * - Edge cases where exit event is missed
 *
 * Primary cleanup is event-driven via registerProcessExitListener().
 *
 * Enhanced with health monitoring:
 * - Detects stuck sessions (requests taking too long)
 * - Auto-restarts unhealthy sessions after consecutive failures
 */
export function startSessionCleanup(): void {
  if (cleanupIntervalId) return;

  cleanupIntervalId = setInterval(() => {
    const now = Date.now();
    // Avoid TS downlevelIteration requirement (main process tsconfig doesn't force target=es2015)
    for (const [convId, info] of Array.from(v2Sessions.entries())) {
      // Check 1: Clean up sessions with dead processes (killed by OS, crashed, etc.)
      if (!isSessionTransportReady(info.session, convId)) {
        cleanupSession(convId, 'process not ready (polling fallback)');
        continue;
      }

      // Check 2: Detect stuck sessions (request taking too long)
      if (isSessionStuck(convId)) {
        console.log(`[Agent][${convId}] Session stuck (request timeout), forcing restart`);
        forceRestartSession(convId, 'stuck session (request timeout)');
        continue;
      }

      // Check 3: Check health status - restart if too many failures
      const health = sessionHealthMap.get(convId);
      if (health && !health.isHealthy) {
        console.log(`[Agent][${convId}] Session marked unhealthy, forcing restart`);
        forceRestartSession(convId, 'unhealthy session');
        continue;
      }

      // Check 4: Clean up idle sessions (not used for 30 minutes)
      // Skip sessions with an in-flight request — they are not idle.
      // activeSessions is the authoritative source for this, consistent with
      // how invalidateAllSessions() and getOrCreateV2Session() defer cleanup.
      if (activeSessions.has(convId)) {
        info.lastUsedAt = now; // keep the clock fresh so timeout resets after task ends
        continue;
      }
      if (now - info.lastUsedAt > SESSION_IDLE_TIMEOUT_MS) {
        cleanupSession(convId, 'idle timeout (30 min)');
      }
    }
  }, 60 * 1000); // Check every minute
}

/**
 * Stop the session cleanup interval
 */
export function stopSessionCleanup(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
}
