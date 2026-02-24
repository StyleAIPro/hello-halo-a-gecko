/**
 * apps/runtime -- App Chat
 *
 * Interactive chat entry point for automation Apps.
 * Allows users to chat with an App's AI agent in real-time,
 * reusing the main Agent's full streaming capabilities via stream-processor.
 *
 * This is separate from execute.ts (scheduled runs):
 * - execute.ts:  Automated runs triggered by schedule/events, batch processing
 * - app-chat.ts: Interactive chat triggered by user, real-time streaming
 *
 * The V2 session is keyed by "app-chat:{appId}" for reuse across messages.
 * Messages are persisted to JSONL ({spacePath}/apps/{appId}/runs/chat.jsonl)
 * for reload recovery.
 *
 * Design:
 * - Uses stream-processor.ts for all streaming logic (shared with main agent)
 * - Uses session-manager.ts for V2 session lifecycle (same reuse/invalidation)
 * - Sends renderer events via the virtual conversationId "app-chat:{appId}"
 * - Frontend subscribes to agent:* events filtered by this conversationId
 */

import { getAppManager } from '../manager'
import { resolvePermission } from '../../../shared/apps/app-types'
import type { MemoryCallerScope } from '../../platform/memory'
import { getConfig } from '../../services/config.service'
import {
  getApiCredentials,
  getApiCredentialsForSource,
  getWorkingDir,
  getHeadlessElectronPath,
  sendToRenderer,
  setMainWindow
} from '../../services/agent/helpers'
import { resolveCredentialsForSdk, buildBaseSdkOptions } from '../../services/agent/sdk-config'
import { createAIBrowserMcpServer, createScopedBrowserContext } from '../../services/ai-browser'
import type { BrowserContext } from '../../services/ai-browser/context'
import { processStream } from '../../services/agent/stream-processor'
import {
  getOrCreateV2Session,
  closeV2Session,
  createSessionState,
  registerActiveSession,
  unregisterActiveSession,
  activeSessions
} from '../../services/agent/session-manager'
import { stopGeneration } from '../../services/agent/control'
import { buildAppChatSystemPrompt } from './prompt-chat'
import { getSpace } from '../../services/space.service'
import { openSessionWriter, readSessionMessages } from './session-store'
import { getAppMemoryService } from './index'
import { createMemoryStatusMcpServer } from '../../platform/memory/snapshot'
import type { BrowserWindow } from 'electron'

// ============================================
// Types
// ============================================

/** Request parameters for sending a chat message to an App */
export interface AppChatRequest {
  /** App ID */
  appId: string
  /** Space ID (where the App is installed) */
  spaceId: string
  /** User's message text */
  message: string
  /** Enable extended thinking mode */
  thinkingEnabled?: boolean
}

// ============================================
// Constants
// ============================================

/** Fixed runId used for chat session JSONL storage */
const CHAT_RUN_ID = 'chat'

/**
 * Build the virtual conversationId for app chat.
 * Used for V2 session keying, active session tracking, and renderer event routing.
 */
export function getAppChatConversationId(appId: string): string {
  return `app-chat:${appId}`
}

/**
 * Scoped browser contexts for app chat sessions.
 * Each app chat gets its own context so activeViewId is isolated
 * from the user's browser and other concurrent sessions.
 * Cleaned up when the V2 session is closed (on error) or explicitly.
 */
const scopedContexts = new Map<string, BrowserContext>()

// ============================================
// Core
// ============================================

/**
 * Send a chat message to an automation App's AI agent.
 *
 * This provides real-time streaming with the same capabilities as the main
 * conversation agent: thinking, tool use, token tracking, interruption.
 *
 * The V2 session is reused across messages (keyed by "app-chat:{appId}"),
 * providing in-memory conversation continuity without session restart.
 *
 * @param mainWindow - Electron main window (for IPC event delivery)
 * @param request - Chat request parameters
 */
export async function sendAppChatMessage(
  mainWindow: BrowserWindow | null,
  request: AppChatRequest
): Promise<void> {
  const { appId, spaceId, message, thinkingEnabled } = request
  const conversationId = getAppChatConversationId(appId)

  // Set main window for sendToRenderer
  setMainWindow(mainWindow)

  console.log(`[AppChat][${appId}] sendMessage: "${message.substring(0, 100)}"`)

  // ── 1. Resolve app + credentials ─────────────────────
  const manager = getAppManager()
  if (!manager) throw new Error('App services not initialized')

  const app = manager.getApp(appId)
  if (!app) throw new Error(`App not found: ${appId}`)

  const memory = getAppMemoryService()
  if (!memory) throw new Error('Memory service not initialized')

  const config = getConfig()
  const credentials = app.userOverrides?.modelSourceId
    ? await getApiCredentialsForSource(config, app.userOverrides.modelSourceId, app.userOverrides.modelId)
    : await getApiCredentials(config)
  const resolvedCreds = await resolveCredentialsForSdk(credentials)
  const electronPath = getHeadlessElectronPath()
  const workDir = getWorkingDir(spaceId)

  // ── 2. Build memory scope ────────────────────────────
  const memoryScope: MemoryCallerScope = {
    type: 'app',
    spaceId: app.spaceId,
    spacePath: getSpace(app.spaceId)?.path ?? '',
    appId: app.id,
  }

  // ── 3. Build system prompt for interactive chat ──────
  const memoryInstructions = memory.getPromptInstructions()
  const usesAIBrowser = resolvePermission(app, 'ai-browser')

  const systemPrompt = buildAppChatSystemPrompt({
    appSpec: app.spec,
    memoryInstructions,
    userConfig: app.userConfig,
    usesAIBrowser,
    workDir,
    modelInfo: resolvedCreds.displayModel,
  })

  // ── 4. Build MCP servers ─────────────────────────────
  const memoryMcpServer = createMemoryStatusMcpServer(memoryScope)

  // Get or create scoped browser context for this chat session
  let scopedBrowserCtx: BrowserContext | undefined
  if (usesAIBrowser) {
    scopedBrowserCtx = scopedContexts.get(conversationId)
    if (!scopedBrowserCtx) {
      scopedBrowserCtx = createScopedBrowserContext(null)
      scopedContexts.set(conversationId, scopedBrowserCtx)
      console.log(`[AppChat][${appId}] Created scoped browser context`)
    }
  }

  const mcpServers: Record<string, any> = {
    'halo-memory': memoryMcpServer,
    ...(usesAIBrowser ? { 'ai-browser': createAIBrowserMcpServer(scopedBrowserCtx) } : {}),
  }
  console.log(`[AppChat][${appId}] MCP servers: [${Object.keys(mcpServers).join(', ')}], aiBrowser=${usesAIBrowser}`)

  // ── 5. Build SDK options ─────────────────────────────
  const abortController = new AbortController()
  const sessionState = createSessionState(spaceId, conversationId, abortController)

  const sdkOptions = buildBaseSdkOptions({
    credentials: resolvedCreds,
    workDir,
    electronPath,
    spaceId,
    conversationId,
    abortController,
    stderrHandler: (data: string) => {
      console.error(`[AppChat][${appId}] CLI stderr:`, data)
    },
    mcpServers,
  })

  // Override for app chat context
  sdkOptions.systemPrompt = systemPrompt

  try {
    const t0 = Date.now()

    // ── 6. Get or create V2 session (reused across messages) ──
    const v2Session = await getOrCreateV2Session(
      spaceId,
      conversationId,
      sdkOptions,
      undefined, // no sessionId for resumption
      { aiBrowserEnabled: usesAIBrowser },
      workDir
    )

    registerActiveSession(conversationId, sessionState)

    // Set thinking tokens dynamically
    if (typeof v2Session.setMaxThinkingTokens === 'function') {
      try {
        await v2Session.setMaxThinkingTokens(thinkingEnabled ? 10240 : null)
      } catch (e) {
        console.error(`[AppChat][${appId}] Failed to set thinking tokens:`, e)
      }
    }

    console.log(`[AppChat][${appId}] V2 session ready: ${Date.now() - t0}ms`)

    // ── 7. Open session writer for JSONL persistence ──
    const spacePath = getSpace(spaceId)?.path ?? ''
    const sessionWriter = spacePath
      ? openSessionWriter(spacePath, appId, CHAT_RUN_ID)
      : undefined

    // Write user message to JSONL for reload recovery
    if (sessionWriter) {
      sessionWriter.writeTrigger(message)
    }

    // ── 8. Process stream ──────────────────────────────
    await processStream({
      v2Session,
      sessionState,
      spaceId,
      conversationId,
      messageContent: message,
      displayModel: resolvedCreds.displayModel,
      abortController,
      t0,
      callbacks: {
        onComplete: (streamResult) => {
          // App chat doesn't use conversation.service for storage.
          // Messages are persisted to JSONL via onRawMessage for reload.
          console.log(
            `[AppChat][${appId}] Stream complete: ` +
            `content=${streamResult.finalContent.length} chars, ` +
            `thoughts=${streamResult.thoughts.length}, ` +
            `tokens=${streamResult.tokenUsage ? 'yes' : 'no'}`
          )
        },
        onRawMessage: (sdkMessage) => {
          // Persist SDK messages to JSONL for "View process" / reload recovery
          // stream_events are too granular for JSONL (hundreds per response)
          if (sessionWriter && sdkMessage.type !== 'stream_event') {
            sessionWriter.writeEvent(sdkMessage)
          }
        }
      }
    })

    console.log(`[AppChat][${appId}] Chat message processed successfully`)
  } catch (error: unknown) {
    const err = error as Error

    // Abort is expected (user stopped generation)
    if (err.name === 'AbortError' || abortController.signal.aborted) {
      console.log(`[AppChat][${appId}] Aborted by user`)
      return
    }

    console.error(`[AppChat][${appId}] Error:`, error)
    sendToRenderer('agent:error', spaceId, conversationId, {
      type: 'error',
      error: err.message || 'Unknown error during app chat'
    })

    // Close session on error to force fresh session next time
    closeV2Session(conversationId)

    // Destroy scoped browser context on error (will be recreated on next message)
    const ctx = scopedContexts.get(conversationId)
    if (ctx) {
      ctx.destroy()
      scopedContexts.delete(conversationId)
      console.log(`[AppChat][${appId}] Scoped browser context destroyed (error)`)
    }
  } finally {
    // Clean up active session (but keep V2 session for reuse)
    unregisterActiveSession(conversationId)
    console.log(`[AppChat][${appId}] Active session cleaned up`)
  }
}

/**
 * Stop an active app chat generation.
 *
 * Uses the same stop mechanism as the main agent (V2 session interrupt + drain).
 *
 * @param appId - App ID to stop chat for
 */
export async function stopAppChat(appId: string): Promise<void> {
  const conversationId = getAppChatConversationId(appId)
  await stopGeneration(conversationId)
  console.log(`[AppChat][${appId}] Generation stopped`)
}

/**
 * Check if an app chat session is currently generating.
 *
 * @param appId - App ID to check
 */
export function isAppChatGenerating(appId: string): boolean {
  const conversationId = getAppChatConversationId(appId)
  return activeSessions.has(conversationId)
}

/**
 * Load persisted chat messages for an app.
 *
 * Reads the JSONL file and converts to renderer-compatible Message[] format.
 * Returns empty array if no chat session exists.
 *
 * @param spacePath - Space directory path
 * @param appId - App ID
 */
export function loadAppChatMessages(spacePath: string, appId: string): any[] {
  return readSessionMessages(spacePath, appId, CHAT_RUN_ID)
}

/**
 * Get session state for recovery after page refresh.
 *
 * @param appId - App ID
 */
export function getAppChatSessionState(appId: string): {
  isActive: boolean
  thoughts: any[]
  spaceId?: string
} {
  const conversationId = getAppChatConversationId(appId)
  const session = activeSessions.get(conversationId)
  if (!session) {
    return { isActive: false, thoughts: [] }
  }
  return {
    isActive: true,
    thoughts: [...session.thoughts],
    spaceId: session.spaceId
  }
}

/**
 * Clean up scoped browser context for an app chat session.
 * Call when deleting an app, resetting chat, or shutting down.
 *
 * @param appId - App ID
 */
export function cleanupAppChatBrowserContext(appId: string): void {
  const conversationId = getAppChatConversationId(appId)
  const ctx = scopedContexts.get(conversationId)
  if (ctx) {
    ctx.destroy()
    scopedContexts.delete(conversationId)
    console.log(`[AppChat][${appId}] Scoped browser context cleaned up`)
  }
}
