/**
 * WebSocket Client for Remote Agent Communication
 * Handles bi-directional communication with remote agent proxy servers
 */

import WebSocket from 'ws'
import { EventEmitter } from 'events'
import { createLogger } from '../../utils/logger'

const log = createLogger('remote-ws')

export interface RemoteWsClientConfig {
  serverId: string
  host: string
  port: number
  authToken: string
  useSshTunnel?: boolean  // Use SSH port forwarding (localhost:8080) instead of direct connection
  // Per-connection API credentials (sent during token registration)
  apiKey?: string
  baseUrl?: string
  model?: string
}

export interface ClientMessage {
  type: 'auth' | 'claude:chat' | 'fs:list' | 'fs:read' | 'fs:write' | 'fs:upload' | 'fs:download' | 'fs:delete' | 'ping' | 'tool:approve' | 'tool:reject'
        | 'mcp:tools:register' | 'mcp:tool:response' | 'mcp:tool:error'  // WebSocket MCP Bridge
        | 'ask:answer'  // AskUserQuestion response from client
  sessionId?: string
  payload?: any
}

export interface ServerMessage {
  type: 'auth:success' | 'auth:failed' |
         'claude:stream' | 'claude:complete' | 'claude:error' | 'claude:session' | 'claude:usage' |
         'fs:result' | 'fs:error' | 'pong' |
         'tool:call' | 'tool:delta' | 'tool:result' | 'tool:error' |
         'terminal:output' |
         'thought' | 'thought:delta' |  // Streaming thought events
         'mcp:status' |  // MCP server status
         'compact:boundary' |  // Context compression notification
         'text:block-start' |  // Text block start signal
         'mcp:tool:call' |  // WebSocket MCP Bridge: proxy asks AICO-Bot to execute a tool
         'mcp:tool:response' |  // WebSocket MCP Bridge: proxy acknowledges tool result
         'task:update' | 'task:list' | 'task:get' | 'task:cancel' | 'task:spawn' |  // Background tasks
         'worker:started' | 'worker:completed' |  // Sub-agent worker lifecycle
         'ask:question'  // AskUserQuestion forwarding
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
  private lastPongTime: number | null = null
  private readonly pongTimeoutMs = 90 * 1000  // 90 seconds — if no pong, consider server dead
  private authenticated = false
  // Track the sessionId this client was created for
  public readonly sessionId: string | null = null
  // Track if interrupt has been called - stops forwarding events to prevent UI updates after stop
  private isInterrupted = false
  // Track if disconnect was intentional (should not reconnect)
  private shouldReconnect = true
  // Track if MCP tools have been registered on this connection lifetime
  // Reset on disconnect so tools are re-registered after reconnect
  private _mcpToolsRegistered = false

  get mcpToolsRegistered(): boolean { return this._mcpToolsRegistered }
  set mcpToolsRegistered(value: boolean) { this._mcpToolsRegistered = value }
  // Track active streaming sessions for interrupt support
  // Key: sessionId used in sendChatWithStream, Value: { resolve, reject }
  private activeStreamSessions = new Map<string, { resolve: (value: string) => void; reject: (reason: Error) => void }>()

  constructor(config: RemoteWsClientConfig, sessionId?: string) {
    super()
    this.config = config
    this.sessionId = sessionId
  }

  /**
   * Connect to the remote agent server and wait for authentication.
   * Resolves only when the WebSocket is open AND authenticated.
   */
  async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      log.debug(`[${this.config.serverId}] Already connecting or connected`)
      // If already connected but not authenticated (e.g. after reconnect), send auth message
      if (this.ws.readyState === WebSocket.OPEN && !this.authenticated) {
        log.debug(`[${this.config.serverId}] Connected but not authenticated, sending auth...`)
        return this.sendAuthAndWait()
      }
      return
    }

    // Reset reconnect flag for new connections
    this.shouldReconnect = true
    this.authenticated = false
    this._mcpToolsRegistered = false

    return new Promise<void>((resolve, reject) => {
      // Use localhost and the tunnel port when SSH tunnel is enabled
      const host = this.config.useSshTunnel ? 'localhost' : this.config.host
      const port = this.config.port  // Already set to localTunnelPort by caller when useSshTunnel=true
      const wsUrl = `ws://${host}:${port}/agent`
      const connectionMode = this.config.useSshTunnel ? `SSH tunnel (localhost:${port})` : `direct (${host}:${port})`
      const connectionStartTime = Date.now()  // Define at outer scope

      log.info(`[${this.config.serverId}] Connecting to ${wsUrl} via ${connectionMode}`)
      log.debug(`[${this.config.serverId}] Auth token: ${this.config.authToken ? this.config.authToken.substring(0, 10) + '...' : 'none'}`)

      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Authorization': `Bearer ${this.config.authToken}`
        },
        perMessageDeflate: {
          threshold: 1024  // Only compress messages larger than 1KB
        }
      })

      let settled = false
      const settle = (result: 'resolve' | 'reject', error?: Error) => {
        if (settled) return
        settled = true
        if (result === 'resolve') {
          resolve()
        } else {
          reject(error!)
        }
      }

      // Enhanced debug logging
      this.ws.on('upgrade', (req) => {
        log.debug(`[${this.config.serverId}] WebSocket upgrade: ${req.url}`)
      })

      this.ws.on('open', () => {
        const duration = Date.now() - connectionStartTime
        log.info(`[${this.config.serverId}] WebSocket open after ${duration}ms`)
        this.reconnectAttempts = 0
        this.emit('connected')

        // If header auth already succeeded (proxy sent auth:success before we
        // attached this handler), this.authenticated is true and we resolve now.
        if (this.authenticated) {
          log.info(`[${this.config.serverId}] Already authenticated via header`)
          settle('resolve')
          return
        }

        // Send explicit auth message
        log.debug(`[${this.config.serverId}] Sending auth message...`)
        this.send({ type: 'auth', payload: { token: this.config.authToken } })

        // Wait for the auth response
        log.debug(`[${this.config.serverId}] Waiting for auth confirmation...`)
        const authTimeout = setTimeout(() => {
          if (!this.authenticated) {
            const err = new Error(
              `Authentication timed out — the remote proxy may not be running or the auth token is invalid. ` +
              `Ensure the agent is started and the token is registered on the remote server.`
            )
            log.error(`[${this.config.serverId}] ${err.message}`)
            settle('reject', err)
          }
        }, 10000)

        this.once('authenticated', () => {
          clearTimeout(authTimeout)
          log.info(`[${this.config.serverId}] Authenticated`)
          settle('resolve')
        })
        this.once('authFailed', (data: any) => {
          clearTimeout(authTimeout)
          const err = new Error(`Authentication failed: ${data?.message || 'Invalid token'}`)
          log.error(`[${this.config.serverId}] ${err.message}`)
          settle('reject', err)
        })
      })

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data)
      })

      this.ws.on('error', (err) => {
        log.error(`[${this.config.serverId}] WebSocket error:`, err)
        log.error(`[${this.config.serverId}] Error code: ${err?.code}, message: ${err?.message}`)
        this.emit('error', err)
        settle('reject', err instanceof Error ? err : new Error(String(err)))
      })

      this.ws.on('close', (event) => {
        const duration = Date.now() - connectionStartTime
        const wasClean = event.code === 1000
        const reason = event.reason || 'unknown'
        log.info(`[${this.config.serverId}] Disconnected - code: ${event.code}, reason: ${reason}, wasClean: ${wasClean}`)
        log.debug(`[${this.config.serverId}] Disconnect duration: ${duration}ms`)
        this.authenticated = false
        this.stopPing()

        // If connect() hasn't resolved yet, reject it with a descriptive error
        if (!settled) {
          let errorMessage: string
          if (event.code === 1008) {
            errorMessage = `Authentication rejected by remote proxy (invalid token). Ensure the token is registered on the remote server.`
          } else if (event.code === 1006) {
            errorMessage = `Remote proxy connection lost abruptly. The agent process may have crashed or is not running on port ${port}.`
          } else {
            errorMessage = `WebSocket disconnected (code: ${event.code}, reason: ${reason}). The remote process may still be running.`
          }
          log.error(`[${this.config.serverId}] ${errorMessage}`)
          settle('reject', new Error(errorMessage))
        }

        // CRITICAL: Reject all active stream sessions so callers don't hang forever.
        // After reconnection, the caller should re-initiate the request.
        if (this.activeStreamSessions.size > 0) {
          log.warn(
            `[${this.config.serverId}] WebSocket closed with ${this.activeStreamSessions.size} ` +
            `active stream(s). Rejecting all pending promises.`
          )
          for (const [sessionId, pending] of this.activeStreamSessions) {
            pending.reject(new Error(
              `WebSocket disconnected (code: ${event.code}) while stream ${sessionId} was active. ` +
              `The remote process may still be running.`
            ))
          }
          this.activeStreamSessions.clear()
        }

        this.emit('disconnected', { code: event.code, reason })
        this.scheduleReconnect()
      })

      // Set timeout for connection
      const timeout = setTimeout(() => {
        log.debug(`[${this.config.serverId}] Connection timeout after 30000ms`)
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          log.warn(`[${this.config.serverId}] Closing due to timeout`)
          this.ws.close(1000, 'Connection timeout')
          settle('reject', new Error('Connection timeout after 30s — check that the remote agent is running and the SSH tunnel is working.'))
        }
      }, 30000)

      this.ws.once('open', () => {
        clearTimeout(timeout)
        this.startPing()
      })

      // Also clear timeout if auth succeeds
      this.once('authenticated', () => {
        clearTimeout(timeout)
      })
    })
  }

  /**
   * Send an auth message and wait for auth confirmation.
   * Used when reconnecting or when header auth was not used.
   */
  private async sendAuthAndWait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const authTimeout = setTimeout(() => {
        reject(new Error('Authentication timed out'))
      }, 5000)

      this.once('authenticated', () => {
        clearTimeout(authTimeout)
        resolve()
      })
      this.once('authFailed', (data: any) => {
        clearTimeout(authTimeout)
        reject(new Error(`Authentication failed: ${data?.message || 'Invalid token'}`))
      })

      this.send({ type: 'auth', payload: { token: this.config.authToken } })
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
          'claude:usage',
          'thought',
          'thought:delta',
          'tool:call',
          'tool:delta',
          'tool:result',
          'tool:error',
          'terminal:output',
          'mcp:status',
          'mcp:tool:call',  // WebSocket MCP Bridge
          'text:block-start'
        ]
        if (blockedTypes.includes(message.type as string)) {
          log.debug(`[${this.config.serverId}] Blocking event after interrupt: ${message.type}`)
          return
        }
      }

      switch (message.type) {
        case 'auth:success':
          this.authenticated = true
          log.info(`[${this.config.serverId}] Authenticated`)
          this.emit('authenticated')
          break

        case 'auth:failed':
          this.authenticated = false
          log.error(`[${this.config.serverId}] Authentication failed:`, message.data)
          this.emit('authFailed', message.data)
          this.disconnect()
          break

        case 'claude:stream':
          this.emit('claude:stream', { sessionId: message.sessionId, data: message.data })
          break

        case 'claude:usage':
          this.emit('claude:usage', { sessionId: message.sessionId, data: message.data })
          break

        case 'claude:complete':
          this.emit('claude:complete', { sessionId: message.sessionId, data: message.data })
          break

        case 'claude:error':
          log.error(`[${this.config.serverId}] Claude error:`, message.data)
          this.emit('claude:error', { sessionId: message.sessionId, data: message.data })
          break

        case 'claude:session':
          // SDK session_id for session resumption
          log.debug(`[${this.config.serverId}] Received SDK session_id:`, message.data?.sdkSessionId)
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
          log.error(`[${this.config.serverId}] Tool error:`, message.data)
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

        case 'mcp:tool:call':
          // WebSocket MCP Bridge: remote proxy asks AICO-Bot to execute a tool
          this.emit('mcp:tool:call', { sessionId: message.sessionId, data: message.data })
          break

        case 'mcp:tool:response':
          // WebSocket MCP Bridge: proxy acknowledges tool result (forward compatibility)
          log.debug(`[${this.config.serverId}] Received mcp:tool:response (acknowledged)`)
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
          log.error(`[${this.config.serverId}] FS error:`, message.data)
          this.emit('fs:error', { sessionId: message.sessionId, data: message.data })
          break

        case 'pong':
          this.lastPongTime = Date.now()
          break

        case 'task:update':
          this.emit('task:update', message.data)
          break

        case 'task:list':
          this.emit('task:list', message.data)
          break

        case 'task:get':
          this.emit('task:get', message.data)
          break

        case 'task:cancel':
          this.emit('task:cancel', message.data)
          break

        case 'task:spawn':
          this.emit('task:spawn', message.data)
          break

        case 'worker:started':
          this.emit('worker:started', { sessionId: message.sessionId, data: message.data })
          break

        case 'worker:completed':
          this.emit('worker:completed', { sessionId: message.sessionId, data: message.data })
          break

        case 'ask:question':
          this.emit('ask:question', { sessionId: message.sessionId, data: message.data })
          break

        default:
          log.warn(`[${this.config.serverId}] Unknown message type:`, message.type)
      }
    } catch (error) {
      log.error(`[${this.config.serverId}] Failed to parse message:`, error)
    }
  }

  /**
   * Send a message to the server
   */
  private send(message: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn(`[${this.config.serverId}] Cannot send message - not connected`)
      return false
    }

    try {
      this.ws.send(JSON.stringify(message))
      log.debug(`[${this.config.serverId}] Message sent: ${message.type}`)
      return true
    } catch (error) {
      log.error(`[${this.config.serverId}] Failed to send message:`, error)
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
  sendChatWithStream(sessionId: string, messages: any[], options: any = {}): Promise<{ content: string; tokenUsage?: any }> {
    return new Promise((resolve, reject) => {
      const chunks: string[] = []
      let fullContent = ''
      let tokenUsage: any = null
      let isComplete = false

      // Timeout configuration - extended for long-running tasks (NPU training, etc.)
      // Each activity (stream, thought, terminal output) resets the idle timer.
      // After IDLE_TIMEOUT_MS of no activity, the session times out.
      // options.timeoutMs allows callers to override (e.g., 2h for training tasks).
      const IDLE_TIMEOUT_MS = options.timeoutMs || 30 * 60 * 1000  // 30 minutes default
      const CHECK_INTERVAL_MS = 60 * 1000  // Check every minute

      let timeoutTimer: NodeJS.Timeout | null = null
      let lastActivityTime = Date.now()

      // Reset timeout timer when activity is detected (heartbeat extension)
      const resetTimeout = () => {
        lastActivityTime = Date.now()
        if (timeoutTimer) {
          clearTimeout(timeoutTimer)
        }
        const checkTimeout = () => {
          const elapsed = Date.now() - lastActivityTime
          if (elapsed >= IDLE_TIMEOUT_MS && !isComplete) {
            if (timeoutTimer) {
              clearTimeout(timeoutTimer)
              timeoutTimer = null
            }
            this.off('claude:stream', streamHandler)
            this.off('claude:usage', usageHandler)
            this.off('claude:complete', completeHandler)
            this.off('claude:error', errorHandler)
            this.off('thought', activityHandler)
            this.off('thought:delta', activityHandler)
            this.off('terminal:output', activityHandler)
            this.activeStreamSessions.delete(sessionId)
            reject(new Error(`Chat timeout - no activity for ${Math.round(IDLE_TIMEOUT_MS / 60000)} minutes`))
          } else if (!isComplete) {
            timeoutTimer = setTimeout(checkTimeout, CHECK_INTERVAL_MS)
          }
        }
        timeoutTimer = setTimeout(checkTimeout, CHECK_INTERVAL_MS)
      }

      // Handle streaming responses
      const streamHandler = (data: any) => {
        if (data.sessionId === sessionId) {
          resetTimeout()  // Reset timeout on any stream activity
          // Support both 'text' and 'content' fields for compatibility
          const text = data.data?.text || data.data?.content || ''
          chunks.push(text)
          fullContent = chunks.join('')
          // Emit stream event for UI updates
          this.emit('stream', { sessionId, content: fullContent, delta: text })
        }
      }

      // Handle token usage
      const usageHandler = (data: any) => {
        if (data.sessionId === sessionId) {
          resetTimeout()
          tokenUsage = data.data
          log.debug(`[${this.config.serverId}] Received token usage:`, tokenUsage)
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
          this.off('claude:usage', usageHandler)
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
          resolve({ content: finalContent, tokenUsage })
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
          this.off('claude:usage', usageHandler)
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
      this.on('claude:usage', usageHandler)
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
   * @param result - Optional tool result string (for hyper-space proxy tools)
   */
  approveToolCall(sessionId: string, toolId: string, result?: string): boolean {
    const payload: any = { toolId }
    if (result !== undefined) {
      payload.result = result
    }
    return this.send({
      type: 'tool:approve',
      sessionId,
      payload
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

  // ============================================
  // WebSocket MCP Bridge Methods
  // ============================================

  /**
   * Register MCP tools available on this AICO-Bot instance.
   * Called after authentication succeeds to advertise local tool capabilities.
   * Only marks as registered if the message was actually sent successfully.
   */
  registerMcpTools(tools: Array<{ name: string; description: string; inputSchema: Record<string, any>; serverName: string }>, capabilities: { aiBrowser: boolean; ghSearch: boolean; version?: number }): boolean {
    const sent = this.send({
      type: 'mcp:tools:register',
      payload: { tools, capabilities }
    })
    if (sent) {
      this._mcpToolsRegistered = true
    }
    return sent
  }

  /**
   * Send MCP tool result back to remote proxy.
   */
  sendMcpToolResult(sessionId: string, callId: string, result: any): boolean {
    return this.send({
      type: 'mcp:tool:response',
      sessionId,
      payload: { callId, toolResult: result }
    })
  }

  /**
   * Send MCP tool error back to remote proxy.
   */
  sendMcpToolError(sessionId: string, callId: string, error: string): boolean {
    return this.send({
      type: 'mcp:tool:error',
      sessionId,
      payload: { callId, toolError: error }
    })
  }

  // ============================================
  // Background Task Methods
  // ============================================

  /** Request list of all background tasks */
  listTasks(): boolean {
    return this.send({ type: 'task:list', payload: {} })
  }

  /** Cancel a background task */
  cancelTask(taskId: string): boolean {
    return this.send({ type: 'task:cancel', payload: { id: taskId } })
  }

  /** Spawn a background task */
  spawnTask(command: string, cwd?: string): boolean {
    return this.send({ type: 'task:spawn', payload: { command, cwd } })
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    // Don't reconnect if intentional disconnect (e.g., after stop button)
    if (!this.shouldReconnect) {
      log.debug(`[${this.config.serverId}] Skipping reconnect - intentional disconnect`)
      return
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.warn(`[${this.config.serverId}] Max reconnection attempts reached`)
      this.emit('reconnectFailed')
      return
    }

    if (this.reconnectTimer) {
      return // Already scheduled
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts)
    log.debug(`[${this.config.serverId}] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts + 1})`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++
      this.connect().catch(err => {
        log.error(`[${this.config.serverId}] Reconnect failed:`, err)
      })
    }, delay)
  }

  /**
   * Start periodic ping to keep connection alive and detect silent server hangs.
   * If a pong is not received within PONG_TIMEOUT_MS, the connection is considered dead.
   */
  private startPing(): void {
    this.stopPing()
    this.lastPongTime = Date.now()
    this.pingTimer = setInterval(() => {
      if (this.lastPongTime && Date.now() - this.lastPongTime > this.pongTimeoutMs) {
        log.warn(
          `[${this.config.serverId}] Pong timeout (${this.pongTimeoutMs / 1000}s) — ` +
          `server is not responding. Closing connection.`
        )
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.close(4001, 'Pong timeout — server unresponsive')
        }
        return
      }
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
      log.debug(`[${this.config.serverId}] Disconnecting`)
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
    log.info(`[${this.config.serverId}] Interrupt requested for session: ${sessionId}`)

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
          log.debug(`[${this.config.serverId}] Interrupt message sent to remote server`)

          // Send close:session message to clean up SDK session
          const closeMessage = {
            type: 'close:session',
            sessionId
          }
          this.ws!.send(JSON.stringify(closeMessage))
          log.debug(`[${this.config.serverId}] close:session message sent to remote server`)
          return true
        } catch (error) {
          log.error(`[${this.config.serverId}] Failed to send messages:`, error)
        }
      }
      return false
    }

    // Try to send messages immediately if connected
    const sent = await sendMessages()

    if (!sent) {
      // CRITICAL: Even if disconnected, try to reconnect briefly to send interrupt
      // This ensures the far end knows to stop and clean up the session
      log.debug(`[${this.config.serverId}] Not connected, attempting quick reconnect to send interrupt...`)
      this.shouldReconnect = true
      this.connect()
      // Wait briefly for connection
      await new Promise(resolve => setTimeout(resolve, 500))
      if (await sendMessages()) {
        log.debug(`[${this.config.serverId}] Messages sent after reconnect`)
      } else {
        log.warn(`[${this.config.serverId}] Reconnect failed, could not send interrupt to remote server`)
      }
      // Reset reconnect flag - we only wanted to reconnect for interrupt
      this.shouldReconnect = false
    }

    // CRITICAL: Wait briefly before setting isInterrupted
    // This allows already-queued WebSocket messages (with content) to be processed
    // Events in the queue will be forwarded to the frontend before we block them
    log.debug(`[${this.config.serverId}] Waiting 300ms for queued events to process...`)
    await new Promise(resolve => setTimeout(resolve, 300))

    // NOW set isInterrupted to stop forwarding new events
    this.isInterrupted = true
    log.debug(`[${this.config.serverId}] isInterrupted flag set`)

    // CRITICAL: Directly reject all pending sendChatWithStream promises
    // This is more reliable than emitting events that may not match sessionId
    for (const [activeSessionId, { reject }] of this.activeStreamSessions) {
      log.debug(`[${this.config.serverId}] Rejecting active stream session: ${activeSessionId}`)
      reject(new Error('Interrupted by user'))
    }
    // Clear all active sessions
    this.activeStreamSessions.clear()

    // CRITICAL: Disconnect after delay to prevent any further events
    // This is now handled here instead of in control.ts
    log.debug(`[${this.config.serverId}] Disconnecting after interrupt...`)
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
  log.info(`Registered active client for session: ${sessionId}`)

  // Clean up registration when client disconnects
  client.once('close', () => {
    activeClients.delete(sessionId)
    log.info(`Unregistered client for session: ${sessionId}`)
  })
}

/**
 * Get an active RemoteWsClient by sessionId
 */
export function getRemoteWsClient(sessionId: string): RemoteWsClient | undefined {
  return activeClients.get(sessionId)
}

/**
 * Unregister an active RemoteWsClient by sessionId without disconnecting.
 * Used for cleanup when the client is managed externally (e.g., orchestrator finally block).
 */
export function unregisterActiveClient(sessionId: string): void {
  activeClients.delete(sessionId)
  log.info(`Unregistered client for session: ${sessionId}`)
}

/**
 * Disconnect and clean up all active clients
 */
export function disconnectAllClients(): void {
  for (const [sessionId, client] of Array.from(activeClients.entries())) {
    client.disconnect()
    activeClients.delete(sessionId)
  }
  // Also disconnect all pooled connections
  for (const [serverId, entry] of Array.from(connectionPool)) {
    entry.client.destroy()
    connectionPool.delete(serverId)
  }
  log.info('All active clients and pooled connections disconnected')
}

// ============================================
// Connection Pool - Reuse WebSocket connections per server
// ============================================

interface PooledConnection {
  client: RemoteWsClient
  refs: Set<string>        // Reference counting: each caller holds a ref
  createdAt: number        // For stale connection detection
  config: RemoteWsClientConfig
}

const connectionPool = new Map<string, PooledConnection>()
const POOL_MAX_AGE_MS = 30 * 60 * 1000  // 30 minutes - recycle stale connections

/**
 * Acquire a pooled WebSocket connection for a server.
 * Returns an existing alive connection or creates a new one.
 * The caller must call releaseConnection() when done.
 */
export async function acquireConnection(
  serverId: string,
  config: RemoteWsClientConfig,
  callerId: string
): Promise<RemoteWsClient> {
  // Check for existing pool entry
  const existing = connectionPool.get(serverId)

  if (existing) {
    if (existing.client.isConnected()) {
      // Check for stale connection
      if (Date.now() - existing.createdAt > POOL_MAX_AGE_MS) {
        log.info(`[${serverId}] Pooled connection is stale (${POOL_MAX_AGE_MS / 60000}min), recycling`)
        existing.client.destroy()
        connectionPool.delete(serverId)
      } else {
        // Reuse existing connection
        existing.refs.add(callerId)
        log.debug(`[${serverId}] Reusing pooled connection (refs: ${existing.refs.size}, callerId: ${callerId})`)
        return existing.client
      }
    } else {
      // Connection is dead, cleanup
      log.info(`[${serverId}] Pooled connection is dead, removing`)
      existing.client.destroy()
      connectionPool.delete(serverId)
    }
  }

  // Create new connection
  const client = new RemoteWsClient(config)
  connectionPool.set(serverId, {
    client,
    refs: new Set([callerId]),
    createdAt: Date.now(),
    config
  })

  log.info(`[${serverId}] Created new pooled connection for callerId: ${callerId}`)

  // Set up auto-cleanup when connection closes unexpectedly
  client.once('close', () => {
    const entry = connectionPool.get(serverId)
    if (entry && entry.client === client) {
      connectionPool.delete(serverId)
      log.info(`[${serverId}] Pooled connection closed, removed from pool`)
    }
  })

  await client.connect()
  return client
}

/**
 * Release a pooled connection reference.
 * The connection stays alive for reuse - only disconnected when stale or by server close.
 */
export function releaseConnection(serverId: string, callerId: string): void {
  const entry = connectionPool.get(serverId)
  if (!entry) {
    return
  }

  entry.refs.delete(callerId)
  log.debug(`[${serverId}] Released connection ref (remaining refs: ${entry.refs.size}, callerId: ${callerId})`)
}

/**
 * Force-disconnect a pooled connection (e.g., when server is removed).
 */
export function removePooledConnection(serverId: string): void {
  const entry = connectionPool.get(serverId)
  if (entry) {
    entry.client.destroy()
    connectionPool.delete(serverId)
    log.info(`[${serverId}] Force-removed pooled connection`)
  }
}

/**
 * Get pool statistics for diagnostics
 */
export function getPoolStats(): Array<{ serverId: string; refs: number; age: number; isConnected: boolean }> {
  const stats: Array<{ serverId: string; refs: number; age: number; isConnected: boolean }> = []
  for (const [serverId, entry] of Array.from(connectionPool)) {
    stats.push({
      serverId,
      refs: entry.refs.size,
      age: Date.now() - entry.createdAt,
      isConnected: entry.client.isConnected()
    })
  }
  return stats
}
