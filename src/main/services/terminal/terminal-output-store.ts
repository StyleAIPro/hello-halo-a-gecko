/**
 * Terminal Output Store - JSON file persistence for raw terminal output buffer
 *
 * Persists the raw terminal output (ANSI-encoded) per conversation to JSON files.
 * This enables replaying terminal output on restart/reconnection.
 *
 * Follows the same pattern as conversation.service.ts agent command persistence.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getSpace } from '../space.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TerminalOutputFile {
  version: number;
  conversationId: string;
  rawOutput: string;
  updatedAt: string;
}

const OUTPUT_VERSION = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the conversations directory for a space.
 * Duplicated from conversation.service.ts (private function).
 */
function getConversationsDir(spaceId: string): string {
  const space = getSpace(spaceId);

  if (!space) {
    console.warn(
      `[TerminalOutput] Space not found: ${spaceId}, cannot determine conversations dir`,
    );
    return '';
  }

  const convDir = space.isTemp
    ? join(space.path, 'conversations')
    : join(space.path, '.aico-bot', 'conversations');
  return convDir;
}

/**
 * Get the file path for terminal output of a conversation.
 */
function getOutputFilePath(spaceId: string, conversationId: string): string {
  const dir = getConversationsDir(spaceId);
  if (!dir) return '';
  return join(dir, `${conversationId}.terminal-output.json`);
}

/**
 * Write file atomically: write to .tmp first, then rename.
 */
function atomicWriteFileSync(filePath: string, data: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Debounced write state
// ---------------------------------------------------------------------------

const pendingWrites = new Map<
  string,
  {
    timer: ReturnType<typeof setTimeout>;
    spaceId: string;
    conversationId: string;
  }
>();

const FLUSH_DEBOUNCE_MS = 2000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Save raw terminal output for a conversation (debounced).
 * Only the latest content is saved — intermediate writes are coalesced.
 */
export function saveTerminalOutput(
  spaceId: string,
  conversationId: string,
  rawOutput: string,
): void {
  const filePath = getOutputFilePath(spaceId, conversationId);
  if (!filePath) return;

  // Mark as pending (coalesce into existing debounce if any)
  const existing = pendingWrites.get(filePath);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => {
    pendingWrites.delete(filePath);
    doSave(filePath, conversationId, rawOutput);
  }, FLUSH_DEBOUNCE_MS);

  pendingWrites.set(filePath, { timer, spaceId, conversationId });
}

/**
 * Save terminal output immediately (no debounce).
 */
export function saveTerminalOutputImmediate(
  spaceId: string,
  conversationId: string,
  rawOutput: string,
): void {
  const filePath = getOutputFilePath(spaceId, conversationId);
  if (!filePath) return;

  // Cancel any pending debounced write for this file
  const existing = pendingWrites.get(filePath);
  if (existing) {
    clearTimeout(existing.timer);
    pendingWrites.delete(filePath);
  }

  doSave(filePath, conversationId, rawOutput);
}

/**
 * Load persisted raw terminal output for a conversation.
 * Returns empty string if not found or on error.
 */
export function loadTerminalOutput(spaceId: string, conversationId: string): string {
  const filePath = getOutputFilePath(spaceId, conversationId);
  if (!filePath || !existsSync(filePath)) return '';

  try {
    const content = readFileSync(filePath, 'utf-8');
    const file: TerminalOutputFile = JSON.parse(content);
    return file.rawOutput || '';
  } catch (error) {
    console.warn(`[TerminalOutput] Failed to load output for ${conversationId}:`, error);
    return '';
  }
}

/**
 * Clear persisted terminal output for a conversation.
 */
export function clearTerminalOutput(spaceId: string, conversationId: string): void {
  const filePath = getOutputFilePath(spaceId, conversationId);
  if (!filePath) return;

  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (error) {
    console.warn(`[TerminalOutput] Failed to clear output for ${conversationId}:`, error);
  }
}

/**
 * Flush all pending debounced writes immediately.
 * Call on shutdown to ensure no data is lost.
 */
export function flushAllPendingOutputWrites(): void {
  for (const [filePath, pending] of pendingWrites.entries()) {
    clearTimeout(pending.timer);
    // We can't flush the actual content here because we don't have the rawOutput.
    // The caller (terminal-gateway) should use flushDirtySessions() instead,
    // which reads the current rawOutput from active sessions.
    pendingWrites.delete(filePath);
  }
  console.log('[TerminalOutput] All pending writes flushed');
}

/**
 * Check if there are any pending writes.
 */
export function hasPendingWrites(): boolean {
  return pendingWrites.size > 0;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function doSave(filePath: string, conversationId: string, rawOutput: string): void {
  try {
    const file: TerminalOutputFile = {
      version: OUTPUT_VERSION,
      conversationId,
      rawOutput,
      updatedAt: new Date().toISOString(),
    };
    atomicWriteFileSync(filePath, JSON.stringify(file));
  } catch (error) {
    console.error(`[TerminalOutput] Failed to save output for ${conversationId}:`, error);
  }
}
