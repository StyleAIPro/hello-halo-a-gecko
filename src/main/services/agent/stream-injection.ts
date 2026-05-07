/**
 * Agent Module - Turn-Level Message Injection
 *
 * Manages the message injection queue for turn-level continuation.
 * When user sends a message during generation, it's stored here
 * and will be sent after the current stream completes.
 */

// ============================================
// Types
// ============================================

/**
 * Pending injection message for turn-level continuation.
 * When user sends a message during generation, it's stored here
 * and will be sent after the current stream completes.
 */
export interface PendingInjection {
  content: string;
  images?: Array<{ type: string; data: string; mediaType: string }>;
  thinkingEnabled?: boolean;
  aiBrowserEnabled?: boolean;
}

export interface QueueInjectionOptions {
  content: string;
  images?: Array<{ type: string; data: string; mediaType: string }>;
  thinkingEnabled?: boolean;
  aiBrowserEnabled?: boolean;
}

// ============================================
// Injection Queue State
// ============================================

// Map: conversationId -> PendingInjection[] (queue to prevent message loss from concurrent workers)
const pendingInjectionQueues = new Map<string, PendingInjection[]>();

// ============================================
// Injection Queue Functions
// ============================================

/**
 * Queue a message for turn-level injection.
 * Supports multiple pending injections per conversation (e.g., from concurrent workers).
 */
export function queueInjection(conversationId: string, options: QueueInjectionOptions): void {
  const queue = pendingInjectionQueues.get(conversationId) || [];
  queue.push({
    content: options.content,
    images: options.images,
    thinkingEnabled: options.thinkingEnabled,
    aiBrowserEnabled: options.aiBrowserEnabled,
  });
  pendingInjectionQueues.set(conversationId, queue);
  console.log(
    `[Agent][${conversationId}] Queued injection message (queue size: ${queue.length}): ${options.content.slice(0, 50)}...`,
  );
}

/**
 * Dequeue the next pending injection for a conversation.
 * Returns the first item in the queue, or undefined if empty.
 */
export function getAndClearInjection(conversationId: string): PendingInjection | undefined {
  const queue = pendingInjectionQueues.get(conversationId);
  if (!queue || queue.length === 0) return undefined;
  const injection = queue.shift()!;
  if (queue.length === 0) {
    pendingInjectionQueues.delete(conversationId);
  }
  console.log(`[Agent][${conversationId}] Dequeued injection (remaining: ${queue.length})`);
  return injection;
}

/**
 * Check if there's a pending injection for a conversation.
 */
export function hasPendingInjection(conversationId: string): boolean {
  const queue = pendingInjectionQueues.get(conversationId);
  return queue !== undefined && queue.length > 0;
}

/**
 * Clear all pending injections for a conversation (e.g., on team destroy or error).
 */
export function clearInjectionsForConversation(conversationId: string): number {
  const queue = pendingInjectionQueues.get(conversationId);
  if (!queue) return 0;
  const count = queue.length;
  pendingInjectionQueues.delete(conversationId);
  console.log(`[Agent][${conversationId}] Cleared ${count} pending injection(s)`);
  return count;
}

/**
 * Clear all pending injections across all conversations (e.g., on orchestrator destroy).
 */
export function clearAllInjections(): void {
  const total = Array.from(pendingInjectionQueues.values()).reduce((sum, q) => sum + q.length, 0);
  pendingInjectionQueues.clear();
  if (total > 0) {
    console.log(`[Agent] Cleared all injections across all conversations (${total} total)`);
  }
}
