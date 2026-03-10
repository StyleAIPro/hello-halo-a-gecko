/**
 * Agent Module - Generation Control
 *
 * Functions for controlling agent generation including:
 * - Stop/abort generation
 * - Check if generating
 * - Get active sessions
 * - Get session state for recovery
 */

import { activeSessions, v2Sessions, unregisterActiveSession } from './session-manager'
import { getRemoteWsClient } from '../remote-ws/remote-ws-client'
import type { Thought } from './types'

// ============================================
// Stop Generation
// ============================================

/**
 * Stop generation for a specific conversation or all conversations
 *
 * @param conversationId - Optional conversation ID. If not provided, stops all.
 */
export async function stopGeneration(conversationId?: string): Promise<void> {
  console.log(`[Agent][control.ts] stopGeneration called with conversationId=${conversationId || 'undefined'}`)

  if (conversationId) {
    // Stop specific session
    const session = activeSessions.get(conversationId)
    console.log(`[Agent][control.ts] Session found: ${!!session}`)

    if (session) {
      console.log(`[Agent][control.ts] Session isRemote=${(session as any).isRemote}`)

      try {
        console.log(`[Agent][control.ts] Calling abortController.abort()...`)
        session.abortController.abort()
        console.log(`[Agent][control.ts] abortController.abort() completed`)
      } catch (e) {
        console.error(`[Agent][control.ts] abortController.abort() error:`, e)
      }

      // Note: Don't delete from activeSessions here - let send-message.ts handle cleanup
      // after it persists content. The abort will trigger an AbortError in send-message.ts,
      // which will then call unregisterActiveSession() after saving content.

      // Interrupt V2 Session and drain stale messages
      // SKIP for remote sessions - they don't have a local V2 session
      if (!(session as any).isRemote) {
        console.log(`[Agent][control.ts] Checking v2Sessions...`)
        const v2Session = v2Sessions.get(conversationId)
        console.log(`[Agent][control.ts] v2Session found: ${!!v2Session}`)
        if (v2Session) {
          try {
            await (v2Session.session as any).interrupt()
            console.log(`[Agent] V2 session interrupted, draining stale messages...`)

            // Drain stale messages until we hit the result
            for await (const msg of v2Session.session.stream()) {
              console.log(`[Agent] Drained: ${msg.type}`)
              if (msg.type === 'result') break
            }
            console.log(`[Agent] Drain complete for: ${conversationId}`)
          } catch (e) {
            console.error(`[Agent] Failed to interrupt/drain V2 session:`, e)
          }
        }
      } else {
        console.log(`[Agent][control.ts] Skipping v2Session handling for remote session`)
      }

      // Interrupt remote session if this is a remote space
      // Note: Client is registered with conversationId in send-message.ts
      // The: interrupt() now handles the delay and disconnect internally
      console.log(`[Agent][control.ts] Checking for remote client...`)
      try {
        const remoteClient = getRemoteWsClient(conversationId)
        console.log(`[Agent][control.ts] Remote client found: ${!!remoteClient}`)
        console.log(`[Agent][control.ts] Remote client isConnected: ${remoteClient?.isConnected()}`)
        console.log(`[Agent][control.ts] Remote client isRemote: ${(session as any).isRemote}`)

        if (remoteClient) {
          // Send interrupt to remote server (handles reconnect if needed)
          // interrupt() now handles:
          // 1. Sending interrupt message to remote server
          // 2. Waiting 300ms for queued events to process
          // 3. Setting isInterrupted flag
          // 4. Disconnecting the          console.log(`[Agent][control.ts] Sending interrupt to remote server...`)
          const interruptResult = await remoteClient.interrupt(conversationId)
          console.log(`[Agent] Remote session interrupted for: ${conversationId}, result=${interruptResult}`)
          // Note: disconnect() is now called inside interrupt() after the delay
        } else {
          console.log(`[Agent][control.ts] Remote client not found`)
        }
      } catch (e) {
        console.error(`[Agent] Failed to interrupt remote session:`, e)
      }

      console.log(`[Agent] Stopped generation for conversation: ${conversationId}`)
    } else {
      console.log(`[Agent][control.ts] No active session found for conversationId=${conversationId}`)
    }
  } else {
    // Stop all sessions (backward compatibility)
    for (const [convId, session] of Array.from(activeSessions)) {
      session.abortController.abort()

      // Interrupt V2 Session
      const v2Session = v2Sessions.get(convId)
      if (v2Session) {
        try {
          await (v2Session.session as any).interrupt()
        } catch (e) {
          console.error(`[Agent] Failed to interrupt V2 session ${convId}:`, e)
        }
      }

      // Interrupt remote session
      try {
        const remoteClient = getRemoteWsClient(convId)
        if (remoteClient && remoteClient.isConnected()) {
          await remoteClient.interrupt(convId)
          remoteClient.disconnect()
        }
      } catch (e) {
        console.error(`[Agent] Failed to interrupt remote session ${convId}:`, e)
      }

      console.log(`[Agent] Stopped generation for conversation: ${convId}`)
    }
    activeSessions.clear()
    console.log('[Agent] All generations stopped')
  }
}

// ============================================
// Generation Status
// ============================================

/**
 * Check if a conversation has an active generation
 */
export function isGenerating(conversationId: string): boolean {
  return activeSessions.has(conversationId)
}

/**
 * Get all active session conversation IDs
 */
export function getActiveSessions(): string[] {
  return Array.from(activeSessions.keys())
}

// ============================================
// Session State Recovery
// ============================================

/**
 * Get current session state for a conversation (for recovery after refresh)
 *
 * This is used by frontend to recover the current state when they
 * reconnect or refresh the page during an active generation.
 */
export function getSessionState(conversationId: string): {
  isActive: boolean
  thoughts: Thought[]
  streamingContent?: string
  spaceId?: string
} {
  const session = activeSessions.get(conversationId)
  if (!session) {
    return { isActive: false, thoughts: [] }
  }
  return {
    isActive: true,
    thoughts: [...session.thoughts],
    streamingContent: session.streamingContent,
    spaceId: session.spaceId
  }
}
