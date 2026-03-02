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
         'claude:stream' | 'claude:complete' | 'claude:error' |
         'fs:result' | 'fs:error' | 'pong' |
         'tool:call' | 'tool:delta' | 'tool:result' | 'tool:error' |
         'terminal:output'
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

  constructor(config: RemoteWsClientConfig) {
    super()
    this.config = config
  }

  /**
   * Connect to the remote agent server
   */
  async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      console.log(`[RemoteWsClient:${this.config.serverId}] Already connecting or connected`)
      return
    }

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

      // Handle streaming responses
      const streamHandler = (data: any) => {
        if (data.sessionId === sessionId) {
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
          this.off('claude:stream', streamHandler)
          this.off('claude:complete', completeHandler)
          this.off('claude:error', errorHandler)
          this.off('thought', thoughtHandler)
          this.off('thought:delta', thoughtDeltaHandler)
          // Return any content from complete message if stream was empty
          const finalContent = fullContent || data.data?.content || ''
          resolve(finalContent)
        }
      }

      const errorHandler = (data: any) => {
        if (data.sessionId === sessionId) {
          this.off('claude:stream', streamHandler)
          this.off('claude:complete', completeHandler)
          this.off('claude:error', errorHandler)
          this.off('thought', thoughtHandler)
          this.off('thought:delta', thoughtDeltaHandler)
          reject(new Error(data.data?.error || 'Chat failed'))
        }
      }

      // Handle thought events
      const thoughtHandler = (data: any) => {
        if (data.sessionId === sessionId) {
          this.emit('thought', data)
        }
      }

      // Handle thought delta events
      const thoughtDeltaHandler = (data: any) => {
        if (data.sessionId === sessionId) {
          this.emit('thought:delta', data)
        }
      }

      // Register handlers
      this.on('claude:stream', streamHandler)
      this.on('claude:complete', completeHandler)
      this.on('claude:error', errorHandler)
      this.on('thought', thoughtHandler)
      this.on('thought:delta', thoughtDeltaHandler)

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
        reject(new Error('Failed to send chat request'))
      }

      // Timeout after 2 minutes
      setTimeout(() => {
        if (!isComplete) {
          this.off('claude:stream', streamHandler)
          this.off('claude:complete', completeHandler)
          this.off('claude:error', errorHandler)
          this.off('thought', thoughtHandler)
          this.off('thought:delta', thoughtDeltaHandler)
          reject(new Error('Chat timeout'))
        }
      }, 120000)
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
    this.cancelReconnect()
    this.stopPing()

    if (this.ws) {
      console.log(`[RemoteWsClient:${this.config.serverId}] Disconnecting`)
      this.ws.close()
      this.ws = null
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.disconnect()
    this.removeAllListeners()
  }
}
