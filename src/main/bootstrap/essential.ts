/**
 * Essential Services - First Screen Dependencies
 *
 * These services are REQUIRED for the initial screen render.
 * They are loaded synchronously before the window becomes interactive.
 *
 * GUIDELINES:
 *   - Each service here directly impacts startup time
 *   - Total initialization should be < 500ms
 *   - New additions require architecture review
 *
 * CURRENT SERVICES:
 *   - Config: Application configuration (API keys, settings)
 *   - Space: Workspace management (list displayed on first screen)
 *   - Conversation: Chat history (core feature)
 *   - Agent: Message handling (core feature)
 *   - Artifact: File management (sidebar display)
 *   - System: Window controls (basic functionality)
 *   - Updater: Auto-update checks (lightweight, needs early start)
 */

import { registerConfigHandlers } from '../ipc/config';
import { registerSpaceHandlers } from '../ipc/space';
import { registerConversationHandlers } from '../ipc/conversation';
import { registerAgentHandlers } from '../ipc/agent';
import { registerArtifactHandlers } from '../ipc/artifact';
import { registerSystemHandlers } from '../ipc/system';
import { registerUpdaterHandlers, initAutoUpdater } from '../services/updater.service';
import { registerAuthHandlers } from '../ipc/auth';
import { registerBootstrapStatusHandler } from './state';
import { execFileSync } from 'child_process';
import path from 'path';
import { app } from 'electron';

/**
 * Initialize essential services required for first screen render
 *
 * Window reference is managed by window.service.ts, no need to pass here.
 *
 * IMPORTANT: These handlers are loaded synchronously.
 * Only add services that are absolutely required for the initial UI.
 */
export function initializeEssentialServices(): void {
  const start = performance.now();

  // === SDK PATCH ===
  // Must run before any SDK module is imported. Patches sdk.mjs to forward options
  // (cwd, systemPrompt, etc.) and enable turn-level message injection.
  // In packaged builds, SDK is inside the read-only app.asar, so the patch must
  // have been applied during the build step (electron-vite build → out/).
  try {
    if (app.isPackaged) {
      console.log(
        '[Bootstrap] Packaged build — skipping runtime SDK patch (must be pre-patched in build output)',
      );
    } else {
      const projectRoot = path.join(__dirname, '..', '..');
      const patchScript = path.join(projectRoot, 'scripts', 'patch-sdk.mjs');
      console.log(`[Bootstrap] SDK patch script: ${patchScript}`);
      execFileSync('node', [patchScript], { stdio: 'pipe' });
      console.log('[Bootstrap] SDK patch applied');
    }
  } catch (e) {
    console.error('[Bootstrap] SDK patch failed:', e);
  }

  // === BOOTSTRAP STATUS ===
  // Register early so renderer can query status even before extended services are ready.
  // This enables Pull+Push pattern for reliable initialization.
  registerBootstrapStatusHandler();

  // === ESSENTIAL SERVICES ===
  // Each service below is required for the first screen render.
  // Do NOT add new services without architecture review.

  // Config: Must be first - other services may depend on configuration
  registerConfigHandlers();

  // Auth: OAuth login handlers for multi-platform login (generic + backward compat)
  registerAuthHandlers();

  // Space: Workspace list is displayed immediately on the left sidebar
  registerSpaceHandlers();

  // Conversation: Chat history is displayed in the main content area
  registerConversationHandlers();

  // Agent: Message sending is the core feature, must be ready immediately
  registerAgentHandlers();

  // Artifact: File list is displayed in the right sidebar
  registerArtifactHandlers();

  // System: Window controls (maximize/minimize/close) are basic functionality
  registerSystemHandlers();

  // Updater: Lightweight, starts checking for updates in background
  registerUpdaterHandlers();
  initAutoUpdater();

  const duration = performance.now() - start;
  console.log(`[Bootstrap] Essential services initialized in ${duration.toFixed(1)}ms`);
}
