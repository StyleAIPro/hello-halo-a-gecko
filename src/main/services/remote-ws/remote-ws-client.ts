/**
 * WebSocket Client for Remote Agent Communication
 * Handles bi-directional communication with remote agent proxy servers
 */

import WebSocket from 'ws'
import { EventEmitter } from 'events'

export interface RemoteWsClientConfig {
  serverId: string
  host: string
  port: number
  authToken: string
  useSshTunnel?: boolean  // Use SSH port forwarding (localhost:8080) instead of direct connection
}

export interface ClientMessage {
  type: 'auth' | 'claude:chat' | 'fs:list' | 'fs:read' | 'fs:write' | 'fs:upload' | 'fs:download' | 'fs:delete' | 'ping' | 'tool:approve' | 'tool:reject'
  sessionId?: string
  payload?: any
}

export interface ServerMessage {
  type: 'auth:success' | 'auth:failed' |
         'claude:stream' | 'claude:complete' | 'claude:error' | 'claude:session' |
         'fs:result' | 'fs:error' | 'pong' |
         'tool:call' | 'tool:delta' | 'tool:result' | 'tool:error' |
         'terminal:output' |
         'thought' | 'thought:delta' |  // Streaming thought events
         'mcp:status' |  // MCP server status
         'compact:boundary' |  // Context compression notification
         'text:block-start'  // Text block start signal
  sessionId?: string
  data?: any
}

export interface ToolCallData {
  id: string
  name: string
  input: any
  status: 'started' | 'delta' | 'result' | 'error'
  output?: any
  error?: string
}

export interface TerminalOutputData {
  content: string
  type: 'stdout' | 'stderr'
}

export class RemoteWsClient extends EventEmitter {
  private ws: WebSocket | null = null
  private config: RemoteWsClientConfig
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 3000
  private reconnectTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private authenticated = false
  // Track the sessionId this client was created for
  public readonly sessionId: string | null = null
  // Track if interrupt has been called - stops forwarding events to prevent UI updates after stop
  private isInterrupted = false
  // Track if disconnect was intentional (should not reconnect)
  private shouldReconnect = true
  // Track active streaming sessions for interrupt support
  // Key: sessionId used in sendChatWithStream, Value: { resolve, reject }
  private activeStreamSessions = new Map<string, { resolve: (value: string) => void; reject: (reason: Error) => void }>()

  constructor(config: RemoteWsClientConfig, sessionId?: string) {
    super()
    this.config = config
    this.sessionId = sessionId
  }

  /**
   * Connect to the remote agent server
   */
  async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      console.log(`[RemoteWsClient:${this.config.serverId}] Already connecting or connected`)
      return
    }

    // Reset reconnect flag for new connections
    this.shouldReconnect = true

    return new Promise<void>((resolve, reject) => {
      // Use localhost and the tunnel port when SSH tunnel is enabled
      const host = this.config.useSshTunnel ? 'localhost' : this.config.host
      const port = this.config.port  // Already set to localTunnelPort by caller when useSshTunnel=true
      const wsUrl = `ws://${host}:${port}/agent`
      const connectionMode = this.config.useSshTunnel ? `SSH tunnel (localhost:${port})` : `direct (${host}:${port})`
      const connectionStartTime = Date.now()  // Define at outer scope

      console.log(`[RemoteWsClient:${this.config.serverId}] Connecting to ${wsUrl} via ${connectionMode}`)
      console.log(`[RemoteWsClient:${this.config.serverId}] Auth token: ${this.config.authToken ? this.config.authToken.substring(0, 10) + '...' : 'none'}`)

      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Authorization': `Bearer ${this.config.authToken}`
        }
      })

      // Enhanced debug logging
      this.ws.on('upgrade', (req) => {
        console.log(`[RemoteWsClient:${this.config.serverId}] WebSocket upgrade: ${req.url}`)
      })

      this.ws.on('open', () => {
        const duration = Date.now() - connectionStartTime
        console.log(`[RemoteWsClient:${this.config.serverId}] Connected after ${duration}ms`)
        this.reconnectAttempts = 0
        this.emit('connected')
        resolve()
      })

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data)
      })

      this.ws.on('error', (err) => {
        console.error(`[RemoteWsClient:${this.config.serverId}] WebSocket error:`, err)
        console.error(`[RemoteWsClient:${this.config.serverId}] Error code: ${err?.code}, message: ${err?.message}`)
        console.error(`[RemoteWsClient:${this.config.serverId}] Error stack: ${err?.stack}`)
        this.emit('error', err)
        if (this.ws) {
          reject(err)
        } else {
          resolve() // Don't reject if already closed
        }
      })

      this.ws.on('close', (event) => {
        const duration = Date.now() - connectionStartTime
        const wasClean = event.code === 1000
        const reason = event.reason || 'unknown'
        console.log(`[RemoteWsClient:${this.config.serverId}] Disconnected - code: ${event.code}, reason: ${reason}, wasClean: ${wasClean}`)
        console.log(`[RemoteWsClient:${this.config.serverId}] Disconnect duration: ${duration}ms`)
        this.authenticated = false
        this.stopPing()
        this.emit('disconnected', { code: event.code, reason })
        this.scheduleReconnect()
      })

      // Set timeout for connection
      const timeout = setTimeout(() => {
        console.log(`[RemoteWsClient:${this.config.serverId}] Connection timeout after 30000ms`)
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          console.warn(`[RemoteWsClient:${this.config.serverId}] Closing due to timeout`)
          this.ws.close(1000, 'Connection timeout')
          reject(new Error('Connection timeout'))
        }
      }, 30000)

      this.ws.once('open', () => {
        clearTimeout(timeout)
        this.startPing()
      })
    })
  }

  /**
   * Handle incoming message from server
   */
  private handleMessage(data: Buffer): void {
    try {
      const message: ServerMessage = JSON.parse(data.toString())

      // CRITICAL: After interrupt, stop forwarding streaming events to prevent UI updates after stop
      // But still allow claude:complete, claude:error, and claude:session for proper promise resolution
      if (this.isInterrupted) {
        const blockedTypes = [
          'claude:stream',
          'thought',
          'thought:delta',
          'tool:call',
          'tool:delta',
          'tool:result',
          'tool:error',
          'terminal:output',
          'mcp:status',
          'compact:boundary',
          'text:block-start'
        ]
        if (blockedTypes.includes(message.type as string)) {
          console.log(`[RemoteWsClient:${this.config.serverId}] Blocking event after interrupt: ${message.type}`)
          return
        }
      }

      switch (message.type) {
        case 'auth:success':
          this.authenticated = true
          console.log(`[RemoteWsClient:${this.config.serverId}] Authenticated`)
          this.emit('authenticated')
          break

        case 'auth:failed':
          this.authenticated = false
          console.error(`[RemoteWsClient:${this.config.serverId}] Authentication failed:`, message.data)
          this.emit('authFailed', message.data)
          this.disconnect()
          break

        case 'claude:stream':
          this.emit('claude:stream', { sessionId: message.sessionId, data: message.data })
          break

        case 'claude:complete':
          this.emit('claude:complete', { sessionId: message.sessionId, data: message.data })
          break

        case 'claude:error':
          console.error(`[RemoteWsClient:${this.config.serverId}] Claude error:`, message.data)
          this.emit('claude:error', { sessionId: message.sessionId, data: message.data })
          break

        case 'claude:session':
          // SDK session_id for session resumption
          console.log(`[RemoteWsClient:${this.config.serverId}] Received SDK session_id:`, message.data?.sdkSessionId)
          this.emit('claude:session', { sessionId: message.sessionId, data: message.data })
          break

        case 'tool:call':
          this.emit('tool:call', { sessionId: message.sessionId, data: message.data })
          break

        case 'tool:delta':
          this.emit('tool:delta', { sessionId: message.sessionId, data: message.data })
          break

        case 'tool:result':
          this.emit('tool:result', { sessionId: message.sessionId, data: message.data })
          break

        case 'tool:error':
          console.error(`[RemoteWsClient:${this.config.serverId}] Tool error:`, message.data)
          this.emit('tool:error', { sessionId: message.sessionId, data: message.data })
          break

        case 'terminal:output':
          this.emit('terminal:output', { sessionId: message.sessionId, data: message.data })
          break

        case 'thought':
          this.emit('thought', { sessionId: message.sessionId, data: message.data })
          break

        case 'thought:delta':
          this.emit('thought:delta', { sessionId: message.sessionId, data: message.data })
          break

        case 'mcp:status':
          this.emit('mcp:status', { sessionId: message.sessionId, data: message.data })
          break

        case 'compact:boundary':
          this.emit('compact:boundary', { sessionId: message.sessionId, data: message.data })
          break

        case 'text:block-start':
          this.emit('text:block-start', { sessionId: message.sessionId, data: message.data })
          break

        case 'fs:result':
          this.emit('fs:result', { sessionId: message.sessionId, data: message.data })
          break

        case 'fs:error':
          console.error(`[RemoteWsClient:${this.config.serverId}] FS error:`, message.data)
          this.emit('fs:error', { sessionId: message.sessionId, data: message.data })
          break

        case 'pong':
          // Ping received
          break

        default:
          console.warn(`[RemoteWsClient:${this.config.serverId}] Unknown message type:`, message.type)
      }
    } catch (error) {
      console.error(`[RemoteWsClient:${this.config.serverId}] Failed to parse message:`, error)
    }
  }

  /**
   * Send a message to the server
   */
  private send(message: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn(`[RemoteWsClient:${this.config.serverId}] Cannot send message - not connected`)
      return false
    }

    try {
      this.ws.send(JSON.stringify(message))
      console.log(`[RemoteWsClient:${this.config.serverId}] Message sent: ${message.type}`)
      return true
    } catch (error) {
      console.error(`[RemoteWsClient:${this.config.serverId}] Failed to send message:`, error)
      return false
    }
  }

  /**
   * Send a chat message to remote Claude agent
   */
  sendClaudeMessage(sessionId: string, message: string): boolean {
    return this.send({
      type: 'claude:chat',
      sessionId,
      payload: {
        messages: [{ role: 'user', content: message }],
        stream: true
      }
    })
  }

  /**
   * Send a chat message with streaming response
   * Returns a Promise that resolves with the full response
   */
  sendChatWithStream(sessionId: string, messages: any[], options: any = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      let fullContent = ''
      let isComplete = false

      // Timeout configuration - extended for long-running tasks
      // Base timeout: 30 minutes, extended by activity (terminal output, thoughts, etc.)
      const BASE_TIMEOUT_MS = 30 * 60 * 1000  // 30 minutes
      const ACTIVITY_EXTENSION_MS = 15 * 60 * 1000  // Extend by 15 minutes per activity

      let timeoutTimer: NodeJS.Timeout | null = null
      let lastActivityTime = Date.now()

      // Reset timeout timer when activity is detected
      const resetTimeout = () => {
        lastActivityTime = Date.now()
        if (timeoutTimer) {
          clearTimeout(timeoutTimer)
        }
        // Check if we should extend the timeout
        const checkTimeout = () => {
          const elapsed = Date.now() - lastActivityTime
          if (elapsed >= BASE_TIMEOUT_MS && !isComplete) {
            // Timeout reached
            if (timeoutTimer) {
              clearTimeout(timeoutTimer)
              timeoutTimer = null
            }
            this.off('claude:stream', streamHandler)
            this.off('claude:complete', completeHandler)
            this.off('claude:error', errorHandler)
            this.off('thought', activityHandler)
            this.off('thought:delta', activityHandler)
            this.off('terminal:output', activityHandler)
            reject(new Error('Chat timeout - no activity for 30 minutes'))
          } else if (!isComplete) {
            // Schedule next check
            timeoutTimer = setTimeout(checkTimeout, Math.min(BASE_TIMEOUT_MS / 10, 60000))
          }
        }
        timeoutTimer = setTimeout(checkTimeout, BASE_TIMEOUT_MS)
      }

      // Handle streaming responses
      const streamHandler = (data: any) => {
        if (data.sessionId === sessionId) {
          resetTimeout()  // Reset timeout on any stream activity
          // Support both 'text' and 'content' fields for compatibility
          const text = data.data?.text || data.data?.content || ''
          fullContent += text
          // Emit stream event for UI updates
          this.emit('stream', { sessionId, content: fullContent, delta: text })
        }
      }

      const completeHandler = (data: any) => {
        if (data.sessionId === sessionId) {
          isComplete = true
          if (timeoutTimer) {
            clearTimeout(timeoutTimer)
            timeoutTimer = null
          }
          this.off('claude:stream', streamHandler)
          this.off('claude:complete', completeHandler)
          this.off('claude:error', errorHandler)
          this.off('thought', activityHandler)
          this.off('thought:delta', activityHandler)
          this.off('terminal:output', activityHandler)
          // Unregister active session
          this.activeStreamSessions.delete(sessionId)
          // Note: thought and thought:delta events are already emitted by handleMessage()
          // No need to unsubscribe them here as they are not registered in this method
          // Return any content from complete message if stream was empty
          const finalContent = fullContent || data.data?.content || ''
          resolve(finalContent)
        }
      }

      const errorHandler = (data: any) => {
        if (data.sessionId === sessionId) {
          isComplete = true
          if (timeoutTimer) {
            clearTimeout(timeoutTimer)
            timeoutTimer = null
          }
          this.off('claude:stream', streamHandler)
          this.off('claude:complete', completeHandler)
          this.off('claude:error', errorHandler)
          this.off('thought', activityHandler)
          this.off('thought:delta', activityHandler)
          this.off('terminal:output', activityHandler)
          // Unregister active session
          this.activeStreamSessions.delete(sessionId)
          reject(new Error(data.data?.error || 'Chat failed'))
        }
      }

      // Activity handler for long-running task support
      // These events indicate the task is still progressing, extend timeout
      const activityHandler = (data: any) => {
        if (data.sessionId === sessionId) {
          resetTimeout()  // Extend timeout on any activity
        }
      }

      // Register handlers
      // Note: thought and thought:delta events are already emitted by handleMessage()
      // They will be received directly by executeRemoteMessage() in send-message.ts
      this.on('claude:stream', streamHandler)
      this.on('claude:complete', completeHandler)
      this.on('claude:error', errorHandler)
      // Register activity handlers for long-running task support
      this.on('thought', activityHandler)
      this.on('thought:delta', activityHandler)
      this.on('terminal:output', activityHandler)

      // Register this session for interrupt support (before sending request)
      // This allows interrupt() to directly reject the Promise
      this.activeStreamSessions.set(sessionId, { resolve, reject })

      // Send the chat request
      const sent = this.send({
        type: 'claude:chat',
        sessionId,
        payload: {
          messages,
          options: { ...options, stream: true }
        }
      })

      if (!sent) {
        // Unregister session if send failed
        this.activeStreamSessions.delete(sessionId)
        reject(new Error('Failed to send chat request'))
        return
      }

      // Initialize timeout with activity tracking
      resetTimeout()
    })
  }

  /**
   * List files on remote server
   */
  listFs(path?: string): boolean {
    return this.send({
      type: 'fs:list',
      payload: { path }
    })
  }

  /**
   * Read file from remote server
   */
  readFile(path: string): boolean {
    return this.send({
      type: 'fs:read',
      payload: { path }
    })
  }

  /**
   * Write file to remote server
   */
  writeFile(path: string, content: string): boolean {
    return this.send({
      type: 'fs:write',
      payload: { path, content }
    })
  }

  /**
   * Delete file on remote server
   */
  deleteFile(path: string): boolean {
    return this.send({
      type: 'fs:delete',
      payload: { path }
    })
  }

  /**
   * Upload file to remote server
   */
  uploadFile(path: string, content: Buffer): boolean {
    return this.send({
      type: 'fs:upload',
      payload: { path, content: content.toString('base64') }
    })
  }

  /**
   * Download file from remote server
   */
  downloadFile(path: string): boolean {
    return this.send({
      type: 'fs:download',
      payload: { path }
    })
  }

  /**
   * Approve a tool call execution
   */
  approveToolCall(sessionId: string, toolId: string): boolean {
    return this.send({
      type: 'tool:approve',
      sessionId,
      payload: { toolId }
    })
  }

  /**
   * Reject a tool call execution
   */
  rejectToolCall(sessionId: string, toolId: string, reason?: string): boolean {
    return this.send({
      type: 'tool:reject',
      sessionId,
      payload: { toolId, reason }
    })
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    // Don't reconnect if intentional disconnect (e.g., after stop button)
    if (!this.shouldReconnect) {
      console.log(`[RemoteWsClient:${this.config.serverId}] Skipping reconnect - intentional disconnect`)
      return
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log(`[RemoteWsClient:${this.config.serverId}] Max reconnection attempts reached`)
      this.emit('reconnectFailed')
      return
    }

    if (this.reconnectTimer) {
      return // Already scheduled
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts)
    console.log(`[RemoteWsClient:${this.config.serverId}] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts + 1})`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++
      this.connect().catch(err => {
        console.error(`[RemoteWsClient:${this.config.serverId}] Reconnect failed:`, err)
      })
    }, delay)
  }

  /**
   * Start periodic ping to keep connection alive
   */
  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' })
    }, 30000) // Ping every 30 seconds
  }

  /**
   * Stop periodic ping
   */
  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  /**
   * Cancel pending reconnection
   */
  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.authenticated
  }

  /**
   * Disconnect from server
   */
  disconnect(): void {
    this.shouldReconnect = false  // Prevent auto-reconnect
    this.cancelReconnect()
    this.stopPing()

    if (this.ws) {
      console.log(`[RemoteWsClient:${this.config.serverId}] Disconnecting`)
      this.ws.close()
      this.ws = null
    }

    // Emit close event for cleanup registration
    // Note: We don't call removeAllListeners() here to allow pending promises (like sendChatWithStream)
    // to be properly rejected. Listeners will be cleaned up naturally when the object is garbage collected.
    this.emit('close')
  }

  /**
   * Interrupt an active conversation on the remote server
   * Sends an interrupt signal to stop the current stream and requests session cleanup
   *
   * IMPORTANT: This method now delays setting isInterrupted to allow already-queued
   * events to be processed first, preserving already-generated content.
   */
  async interrupt(sessionId: string): Promise<boolean> {
    console.log(`[RemoteWsClient:${this.config.serverId}] Interrupt requested for session: ${sessionId}`)

    // Send interrupt and close:session messages to remote server FIRST
    const sendMessages = async () => {
      if (this.isConnected()) {
        try {
          // Send interrupt message
          const interruptMessage = {
            type: 'claude:interrupt',
            sessionId
          }
          this.ws!.send(JSON.stringify(interruptMessage))
          console.log(`[RemoteWsClient:${this.config.serverId}] Interrupt message sent to remote server`)

          // Send close:session message to clean up SDK session
          const closeMessage = {
            type: 'close:session',
            sessionId
          }
          this.ws!.send(JSON.stringify(closeMessage))
          console.log(`[RemoteWsClient:${this.config.serverId}] close:session message sent to remote server`)
          return true
        } catch (error) {
          console.error(`[RemoteWsClient:${this.config.serverId}] Failed to send messages:`, error)
        }
      }
      return false
    }

    // Try to send messages immediately if connected
    const sent = await sendMessages()

    if (!sent) {
      // CRITICAL: Even if disconnected, try to reconnect briefly to send interrupt
      // This ensures the far end knows to stop and clean up the session
      console.log(`[RemoteWsClient:${this.config.serverId}] Not connected, attempting quick reconnect to send interrupt...`)
      this.shouldReconnect = true
      this.connect()
      // Wait briefly for connection
      await new Promise(resolve => setTimeout(resolve, 500))
      if (await sendMessages()) {
        console.log(`[RemoteWsClient:${this.config.serverId}] Messages sent after reconnect`)
      } else {
        console.warn(`[RemoteWsClient:${this.config.serverId}] Reconnect failed, could not send interrupt to remote server`)
      }
      // Reset reconnect flag - we only wanted to reconnect for interrupt
      this.shouldReconnect = false
    }

    // CRITICAL: Wait briefly before setting isInterrupted
    // This allows already-queued WebSocket messages (with content) to be processed
    // Events in the queue will be forwarded to the frontend before we block them
    console.log(`[RemoteWsClient:${this.config.serverId}] Waiting 300ms for queued events to process...`)
    await new Promise(resolve => setTimeout(resolve, 300))

    // NOW set isInterrupted to stop forwarding new events
    this.isInterrupted = true
    console.log(`[RemoteWsClient:${this.config.serverId}] isInterrupted flag set`)

    // CRITICAL: Directly reject all pending sendChatWithStream promises
    // This is more reliable than emitting events that may not match sessionId
    for (const [activeSessionId, { reject }] of this.activeStreamSessions) {
      console.log(`[RemoteWsClient:${this.config.serverId}] Rejecting active stream session: ${activeSessionId}`)
      reject(new Error('Interrupted by user'))
    }
    // Clear all active sessions
    this.activeStreamSessions.clear()

    // CRITICAL: Disconnect after delay to prevent any further events
    // This is now handled here instead of in control.ts
    console.log(`[RemoteWsClient:${this.config.serverId}] Disconnecting after interrupt...`)
    this.disconnect()

    return true
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.disconnect()
    this.removeAllListeners()
  }
}

// ============================================
// Client Manager - Track active RemoteWsClient instances
// ============================================

/**
 * Map of sessionId -> RemoteWsClient instance
 * This allows stopGeneration to find and interrupt active remote connections
 */
const activeClients = new Map<string, RemoteWsClient>()

/**
 * Register an active RemoteWsClient instance
 */
export function registerActiveClient(sessionId: string, client: RemoteWsClient): void {
  activeClients.set(sessionId, client)
  console.log(`[RemoteWsClient] Registered active client for session: ${sessionId}`)

  // Clean up registration when client disconnects
  client.once('close', () => {
    activeClients.delete(sessionId)
    console.log(`[RemoteWsClient] Unregistered client for session: ${sessionId}`)
  })
}

/**
 * Get an active RemoteWsClient by sessionId
 */
export function getRemoteWsClient(sessionId: string): RemoteWsClient | undefined {
  return activeClients.get(sessionId)
}

/**
 * Disconnect and clean up all active clients
 */
export function disconnectAllClients(): void {
  for (const [sessionId, client] of Array.from(activeClients.entries())) {
    client.disconnect()
    activeClients.delete(sessionId)
  }
  console.log('[RemoteWsClient] All active clients disconnected')
}
