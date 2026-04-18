/**
 * SDK Patch for Turn-Level Message Injection
 *
 * This script patches the Anthropic Agent SDK at runtime to support
 * turn-level message injection, similar to native Claude CLI behavior.
 *
 * Usage: Import this module before using the SDK
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let patched = false;

export function patchSdkForTurnInjection() {
  if (patched) return;

  console.log('[SDK Patch] Applying turn-level message injection patch...');

  try {
    const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk');
    const fs = require('fs');
    let content = fs.readFileSync(sdkPath, 'utf8');

    // Track changes
    let changes = 0;

    // 0. MIGRATION: Fix already-patched send() that uses firstResultReceived
    // The old patch used firstResultReceived as the guard, which persists across
    // stream cycles. After the first conversation completes, firstResultReceived
    // stays true forever, causing all subsequent send() calls to silently queue
    // messages instead of actually sending them to the SDK input stream.
    // Fix: replace with _continueAfterResult which is properly reset between cycles.
    const oldSendGuard = 'this.query?.firstResultReceived&&!this.closed';
    if (content.includes(oldSendGuard)) {
      content = content.replace(
        oldSendGuard,
        'this.query?._continueAfterResult&&!this.closed',
      );
      changes++;
      console.log('[SDK Patch] Migrated send() guard: firstResultReceived → _continueAfterResult');
    }

    // 1. Add injection tracking properties to Query class
    const queryPropsInsertionPoint = 'pendingMcpResponses = new Map;';
    if (content.includes(queryPropsInsertionPoint) && !content.includes('_continueAfterResult')) {
      content = content.replace(
        queryPropsInsertionPoint,
        `pendingMcpResponses = new Map;
  // [PATCHED] Turn-level message injection
  _continueAfterResult = false;
  _pendingUserMessages = [];`,
      );
      changes++;
      console.log('[SDK Patch] Added injection tracking properties to Query class');
    }

    // 2. Modify readMessages to inject pending messages after result
    const enqueuePattern = 'this.inputStream.enqueue(message);';
    if (content.includes(enqueuePattern) && !content.includes('Injecting pending user message')) {
      content = content.replace(
        enqueuePattern,
        `this.inputStream.enqueue(message);
        // [PATCHED] Inject pending user messages after result
        if (message.type === "result" && this._continueAfterResult && this._pendingUserMessages.length > 0) {
          const nextMsg = this._pendingUserMessages.shift();
          console.log('[SDK] Injecting pending user message after result');
          this.inputStream.enqueue(nextMsg);
          this._continueAfterResult = this._pendingUserMessages.length > 0;
        }`,
      );
      changes++;
      console.log('[SDK Patch] Added message injection logic to readMessages');
    }

    // 3. Modify send() to queue messages for injection
    const sendPattern = 'async send(message) {\n    if (this.closed) {';
    if (content.includes(sendPattern) && !content.includes('Turn-level message injection')) {
      const newSend = `async send(message) {
    // [PATCHED] Turn-level message injection
    // Only queue when _continueAfterResult is explicitly true (active injection flow).
    // Using firstResultReceived is wrong because it persists across stream cycles:
    // after the first conversation completes, firstResultReceived stays true forever,
    // causing all subsequent send() calls to silently queue instead of actually sending.
    if (this.query?._continueAfterResult && !this.closed) {
      if (this.query._pendingUserMessages) {
        this.query._pendingUserMessages.push(message);
        console.log('[SDK] Queued message for turn-level injection');
        return;
      }
    }
    if (this.closed) {`;
      content = content.replace(sendPattern, newSend);
      changes++;
      console.log('[SDK Patch] Modified send() for message queuing');
    }

    // 4. Modify stream() to continue after result if injection enabled
    const streamPattern = 'if (value.type === "result") {\n        return;';
    if (content.includes(streamPattern) && !content.includes('continue iteration')) {
      const newStream = `if (value.type === "result") {
        // [PATCHED] Continue if turn-level injection is active
        if (this.query?._continueAfterResult || this.query?._pendingUserMessages?.length > 0) {
          continue;
        }
        return;`;
      content = content.replace(streamPattern, newStream);
      changes++;
      console.log('[SDK Patch] Modified stream() to support continuation');
    }

    // 5. Add helper methods before close()
    const closePattern = '\n  close() {\n    if (this.closed) {';
    if (content.includes(closePattern) && !content.includes('enableContinueConversation')) {
      const newMethods = `
  // [PATCHED] Turn-level message injection helpers
  enableContinueConversation() {
    if (this.query) {
      this.query._continueAfterResult = true;
      console.log('[SDK] Enabled continue conversation');
    }
  }
  hasPendingMessages() {
    return this.query?._pendingUserMessages?.length > 0 || false;
  }
  getPendingMessageCount() {
    return this.query?._pendingUserMessages?.length || 0;
  }

  close() {
    if (this.closed) {`;
      content = content.replace(closePattern, newMethods);
      changes++;
      console.log('[SDK Patch] Added helper methods');
    }

    // Write patched content
    if (changes > 0) {
      fs.writeFileSync(sdkPath, content, 'utf8');
      console.log(`[SDK Patch] Successfully applied ${changes} changes to SDK`);
      patched = true;
    } else {
      console.log('[SDK Patch] SDK already patched or patch patterns not found');
    }
  } catch (error) {
    console.error('[SDK Patch] Failed to patch SDK:', error);
    throw error;
  }
}

// Auto-patch if this module is imported
patchSdkForTurnInjection();
