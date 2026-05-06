/**
 * Agent Module - Stream Processor (Re-export Layer)
 *
 * This file serves as the public entry point for the stream processor.
 * The actual implementation has been split into:
 * - stream-injection.ts  - Turn-level message injection queue management
 * - subagent-tracker.ts  - SDK subagent (Agent tool) tracking
 * - process-stream.ts    - Core processStream function
 *
 * All external consumers should continue importing from './stream-processor'.
 */

// Re-export core stream processing
export { processStream } from './process-stream';
export type { ProcessStreamParams, StreamCallbacks, StreamResult } from './process-stream';

// Re-export injection queue management
export {
  queueInjection,
  getAndClearInjection,
  hasPendingInjection,
  clearInjectionsForConversation,
  clearAllInjections,
} from './stream-injection';
export type { PendingInjection, QueueInjectionOptions } from './stream-injection';
