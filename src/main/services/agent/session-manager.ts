/**
 * Agent Module - Session Manager (Aggregation Layer)
 *
 * This file re-exports all public symbols from the split sub-files:
 * - session-health.ts  — Health check system, activity tracking, cleanup timer
 * - session-lifecycle.ts — Session creation, reuse, migration, warm/close/invalidate
 *
 * External consumers should continue to import from './session-manager'.
 * Do NOT import directly from session-health or session-lifecycle.
 */

// ============================================
// From session-health.ts
// ============================================

export {
  markSessionRequestStart,
  markSessionRequestComplete,
  markSessionActivity,
  isSessionTransportReady,
  cleanupSession,
  startSessionCleanup,
  stopSessionCleanup,
} from './session-health';

// ============================================
// From session-lifecycle.ts
// ============================================

// Session maps
export { activeSessions, v2Sessions } from './session-lifecycle';

// Session config
export { needsSessionRebuild } from './session-lifecycle';

// Session creation / reuse
export { getOrCreateV2Session, type GetOrCreateSessionOptions } from './session-lifecycle';

// Session warm-up
export { ensureSessionWarm } from './session-lifecycle';

// Session lifecycle (close / invalidate)
export {
  closeV2Session,
  closeAllV2Sessions,
  closeSessionsBySpaceId,
  invalidateSession,
  invalidateAllSessions,
} from './session-lifecycle';

// Active session state helpers
export {
  createSessionState,
  registerActiveSession,
  unregisterActiveSession,
  getActiveSession,
} from './session-lifecycle';

// Context compression
export { compactContext } from './session-lifecycle';
