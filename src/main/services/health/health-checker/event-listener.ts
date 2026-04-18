/**
 * Event Listener - Event-driven health monitoring
 *
 * Listens for critical events and triggers appropriate responses.
 * This is the primary monitoring mechanism - polling is just a fallback.
 */

import type { HealthEvent, HealthEventType, HealthEventCategory } from '../types';

// Callback type for health events
type HealthEventHandler = (event: HealthEvent) => void;

// Registered event handlers
const eventHandlers: HealthEventHandler[] = [];

// Recent events buffer (for diagnostics)
const MAX_RECENT_EVENTS = 50;
const recentEvents: HealthEvent[] = [];

// Error counters for escalation
const errorCounters = new Map<string, { count: number; lastTime: number }>();

// Counter reset interval (1 minute)
const COUNTER_RESET_MS = 60_000;

/**
 * Register a health event handler
 *
 * @param handler - Function to call when health events occur
 * @returns Unsubscribe function
 */
export function onHealthEvent(handler: HealthEventHandler): () => void {
  eventHandlers.push(handler);

  return () => {
    const index = eventHandlers.indexOf(handler);
    if (index > -1) {
      eventHandlers.splice(index, 1);
    }
  };
}

export interface EmitHealthEventOptions {
  type: HealthEventType;
  category: HealthEventCategory;
  source: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Emit a health event
 */
export function emitHealthEvent(options: EmitHealthEventOptions): void {
  const event: HealthEvent = {
    type: options.type,
    category: options.category,
    timestamp: Date.now(),
    source: options.source,
    message: options.message,
    data: options.data,
  };

  // Add to recent events buffer
  recentEvents.unshift(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.pop();
  }

  // Log the event
  const icon =
    options.category === 'critical' ? '🔴' : options.category === 'warning' ? '🟡' : '🔵';
  console.log(
    `[Health][Event] ${icon} ${options.type}: ${options.message} (source: ${options.source})`,
  );

  // Notify all handlers
  for (const handler of eventHandlers) {
    try {
      handler(event);
    } catch (error) {
      console.error('[Health][Event] Handler error:', error);
    }
  }
}

/**
 * Track error occurrence for escalation
 *
 * @param source - Error source identifier
 * @returns Current consecutive error count
 */
export function trackError(source: string): number {
  const now = Date.now();
  const counter = errorCounters.get(source);

  if (counter) {
    // Reset counter if too much time has passed
    if (now - counter.lastTime > COUNTER_RESET_MS) {
      counter.count = 1;
      counter.lastTime = now;
    } else {
      counter.count++;
      counter.lastTime = now;
    }
    return counter.count;
  } else {
    errorCounters.set(source, { count: 1, lastTime: now });
    return 1;
  }
}

/**
 * Reset error counter for a source
 */
export function resetErrorCounter(source: string): void {
  errorCounters.delete(source);
}

/**
 * Get error count for a source
 */
export function getErrorCount(source: string): number {
  const counter = errorCounters.get(source);
  return counter?.count ?? 0;
}

/**
 * Get total error count across all sources
 * Used by passive polling to check overall health
 */
export function getTotalErrorCount(): number {
  let total = 0;
  for (const counter of errorCounters.values()) {
    total += counter.count;
  }
  return total;
}

/**
 * Get recent health events
 */
export function getRecentEvents(): HealthEvent[] {
  return [...recentEvents];
}

/**
 * Clear recent events
 */
export function clearRecentEvents(): void {
  recentEvents.length = 0;
}

// ============================================
// Event Emission Helpers
// ============================================

/**
 * Emit agent error event
 *
 * Note: source includes 'agent' prefix for S2 recovery strategy matching
 * (selectRecoveryStrategy checks source.includes('agent'))
 */
export function emitAgentError(
  conversationId: string,
  error: string,
  data?: Record<string, unknown>,
): void {
  const count = trackError(`agent:${conversationId}`);
  emitHealthEvent({
    type: 'agent_error',
    category: count >= 3 ? 'critical' : 'warning',
    source: `agent:${conversationId}`, // Include 'agent' prefix for S2 strategy matching
    message: error,
    data: { ...data, consecutiveErrors: count, conversationId },
  });
}

/**
 * Emit process exit event
 */
export function emitProcessExit(
  processId: string,
  exitCode: number | null,
  signal: string | null,
): void {
  emitHealthEvent({
    type: 'process_exit',
    category: 'critical',
    source: processId,
    message: `Process exited with code ${exitCode}, signal ${signal}`,
    data: { exitCode, signal },
  });
}

/**
 * Emit renderer crash event
 */
export function emitRendererCrash(reason: string): void {
  emitHealthEvent({
    type: 'renderer_crash',
    category: 'critical',
    source: 'renderer',
    message: `Renderer crashed: ${reason}`,
    data: { reason },
  });
}

/**
 * Emit renderer unresponsive event
 */
export function emitRendererUnresponsive(): void {
  emitHealthEvent({
    type: 'renderer_unresponsive',
    category: 'warning',
    source: 'renderer',
    message: 'Renderer became unresponsive',
  });
}

/**
 * Emit network error event
 */
export function emitNetworkError(source: string, status: number, message: string): void {
  const count = trackError(`network:${source}`);
  const isCritical = status >= 500 || message.includes('ECONNREFUSED');

  emitHealthEvent({
    type: 'network_error',
    category: isCritical ? 'critical' : 'warning',
    source: source,
    message: `Network error: ${status} - ${message}`,
    data: { status, consecutiveErrors: count },
  });
}

/**
 * Emit config change event
 */
export function emitConfigChange(changedFields: string[]): void {
  emitHealthEvent({
    type: 'config_change',
    category: 'info',
    source: 'config',
    message: `Config changed: ${changedFields.join(', ')}`,
    data: { changedFields },
  });
}

/**
 * Emit recovery success event
 */
export function emitRecoverySuccess(strategyId: string, message: string): void {
  emitHealthEvent({
    type: 'recovery_success',
    category: 'info',
    source: strategyId,
    message: message,
  });

  // Reset error counters on successful recovery
  errorCounters.clear();
}

/**
 * Emit startup check event
 */
export function emitStartupCheck(status: string, duration: number): void {
  emitHealthEvent({
    type: 'startup_check',
    category: status === 'healthy' ? 'info' : 'warning',
    source: 'startup',
    message: `Startup checks completed: ${status} (${duration}ms)`,
    data: { duration },
  });
}
