/**
 * Agent Module - Send Message (Aggregation Layer)
 *
 * This file re-exports the two main message sending functions:
 * - sendMessage:      Local + Hyper Space message execution (from send-message-local.ts)
 * - executeRemoteMessage: Remote WebSocket message execution (from send-message-remote.ts)
 *
 * External consumers should continue to import from './send-message'.
 */

export { sendMessage } from './send-message-local';
export { executeRemoteMessage } from './send-message-remote';
