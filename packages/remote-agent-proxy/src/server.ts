import { WebSocketServer, WebSocket } from 'ws'
import type { ServerMessage, ClientMessage, RemoteServerConfig, ToolCallData, TerminalOutputData } from './types.js'
import { ClaudeManager, type ChatMessage, type ChatOptions, type ToolCall, type TerminalOutput } from './claude-manager.js'

export class RemoteAgentServer {
  private config: RemoteServerConfig
  private server: WebSocketServer
  private clients: Map<WebSocket, { authenticated: boolean; sessionId?: string }> = new Map()
  private claudeManager: ClaudeManager

  constructor(config: RemoteServerConfig) {
    this.config = config
    // Explicitly listen on IPv4 to ensure compatibility
    this.server = new WebSocketServer({ port: config.port, host: '0.0.0.0' })

    if (!config.claudeApiKey) {
      console.warn('Warning: No Claude API key provided. Chat features will be unavailable.')
    }
    this.claudeManager = new ClaudeManager(
      config.claudeApiKey,
      config.claudeBaseUrl,
      undefined,  // V2 Session will auto-locate Claude Code
      config.workDir,
      config.model
    )

    this.setupServer()
  }

  private setupServer(): void {
    this.server.on('connection', (ws: WebSocket, req) => {
      // Check for Authorization header authentication
      // HTTP headers are case-insensitive, check both 'authorization' and 'Authorization'
      const authHeader = req.headers['authorization'] || req.headers['Authorization']

      if (this.config.authToken && typeof authHeader === 'string') {
        const token = authHeader.split(' ')[1]
        if (token === this.config.authToken) {
          console.log('Client authenticated via Authorization header')
          this.clients.set(ws, { authenticated: true })
        } else {
          console.log('Authentication failed via Authorization header')
          console.log(`Expected token: ${this.config.authToken}, got: ${token}`)
          ws.close(1008, 'Unauthorized')
          return
        }
      } else if (!this.config.authToken) {
        // No auth required, auto-authenticate
        console.log('No auth required, auto-authenticating')
        this.clients.set(ws, { authenticated: true })
      } else {
        this.clients.set(ws, { authenticated: false })
      }
      console.log('New client connected')

      ws.on('message', (data: Buffer) => {
        try {
          const message: ClientMessage = JSON.parse(data.toString())
          this.handleMessage(ws, message)
        } catch (error) {
          this.sendError(ws, 'Invalid message format')
        }
      })

      ws.on('close', () => {
        const client = this.clients.get(ws)
        if (client?.sessionId) {
          this.claudeManager.closeSession(client.sessionId)
        }
        this.clients.delete(ws)
        console.log('Client disconnected')
      })

      ws.on('error', (error) => {
        console.error('WebSocket error:', error)
      })
    })

    this.server.on('listening', () => {
      console.log(`Remote Agent Proxy server listening on port ${this.config.port}`)
      if (this.config.workDir) {
        console.log(`Working directory: ${this.config.workDir}`)
      }
      if (this.config.claudeBaseUrl) {
        console.log(`Claude API Base URL: ${this.config.claudeBaseUrl}`)
      }
      if (this.config.model) {
        console.log(`Model: ${this.config.model}`)
      }
      if (this.config.maxThinkingTokens) {
        console.log(`Max thinking tokens: ${this.config.maxThinkingTokens}`)
      }
    })

    this.server.on('error', (error) => {
      console.error('Server error:', error)
    })
  }

  private async handleMessage(ws: WebSocket, message: ClientMessage): Promise<void> {
    const client = this.clients.get(ws)
    if (!client) return

    // Check authentication for non-auth messages
    if (message.type !== 'auth' && !client.authenticated) {
      this.sendMessage(ws, {
        type: 'auth:failed',
        data: { message: 'Not authenticated' }
      })
      return
    }

    // Update session ID if provided
    if (message.sessionId) {
      client.sessionId = message.sessionId
    }

    const sessionId = message.sessionId || client.sessionId

    if (message.type === 'auth') {
      const token = message.payload?.token
      if (token !== undefined) {
        this.handleAuth(ws, token)
      }
    } else if (message.type === 'claude:chat') {
      if (!this.config.claudeApiKey) {
        this.sendMessage(ws, {
          type: 'claude:error',
          sessionId,
          data: { error: 'Claude API key not configured' }
        })
        return
      }
      const sid = sessionId || client.sessionId
      if (!sid) {
        this.sendMessage(ws, {
          type: 'claude:error',
          sessionId,
          data: { error: 'Session ID required' }
        })
        return
      }
      await this.handleClaudeChat(ws, sid, message.payload)
    } else if (['fs:list', 'fs:read', 'fs:write', 'fs:delete', 'fs:upload', 'fs:download'].includes(message.type)) {
      if (!this.config.claudeApiKey) {
        this.sendMessage(ws, {
          type: 'fs:error',
          sessionId,
          data: { error: 'Claude API key not configured' }
        })
        return
      }
      const sid = sessionId || client.sessionId
      if (!sid) {
        this.sendMessage(ws, {
          type: 'fs:error',
          sessionId,
          data: { error: 'Session ID required' }
        })
        return
      }
      await this.handleFileOperation(ws, sid, message.type, message.payload)
    } else if (message.type === 'ping') {
      this.sendMessage(ws, { type: 'pong', sessionId })
    } else if (message.type === 'tool:approve' || message.type === 'tool:reject') {
      // Tool approval/rejection - for future implementation
      console.log(`[${message.type}] for tool:`, message.payload?.toolId)
    } else {
      this.sendError(ws, 'Unknown message type', sessionId)
    }
  }

  private handleAuth(ws: WebSocket, token: string): void {
    if (this.config.authToken) {
      if (token === this.config.authToken) {
        const client = this.clients.get(ws)
        if (client) {
          client.authenticated = true
          this.sendMessage(ws, { type: 'auth:success' })
          console.log('Client authenticated')
        }
      } else {
        this.sendMessage(ws, {
          type: 'auth:failed',
          data: { message: 'Invalid authentication token' }
        })
      }
    } else {
      // No auth required
      const client = this.clients.get(ws)
      if (client) {
        client.authenticated = true
        this.sendMessage(ws, { type: 'auth:success' })
        console.log('Client authenticated (no auth required)')
      }
    }
  }

  private async handleClaudeChat(ws: WebSocket, sessionId: string, payload: any): Promise<void> {
    try {
      const { messages, options, stream = true } = payload

      if (!messages || !Array.isArray(messages)) {
        this.sendMessage(ws, {
          type: 'claude:error',
          sessionId,
          data: { error: 'Invalid messages format' }
        })
        return
      }

      console.log(`[RemoteAgentServer] Received claude:chat request for session ${sessionId} with ${messages.length} messages`)

      // Normalize messages to ChatMessage format
      // Support both string content and complex content (text + images)
      const chatMessages: ChatMessage[] = messages.map((msg: any) => {
        const role: 'user' | 'assistant' = msg.role || 'user'
        // Handle both string content and structured content (array of text/images)
        let content: string
        if (typeof msg.content === 'string') {
          content = msg.content
        } else if (Array.isArray(msg.content)) {
          // For multi-modal content, serialize the array
          // The Claude SDK will parse this as content blocks
          content = JSON.stringify(msg.content)
        } else {
          content = JSON.stringify(msg.content)
        }
        return { role, content }
      })

      console.log(`[RemoteAgentServer] Processing chat with ${chatMessages.length} messages for session ${sessionId}`)

      if (stream) {
        // Callbacks for tool and terminal events
        const onToolCall = (tool: ToolCall) => {
          console.log(`[RemoteAgentServer] Tool ${tool.status}: ${tool.name || 'unknown'}`)
          this.sendMessage(ws, {
            type: tool.status === 'error' ? 'tool:error' : 'tool:call',
            sessionId,
            data: tool
          })
        }

        const onTerminalOutput = (output: TerminalOutput) => {
          this.sendMessage(ws, {
            type: 'terminal:output',
            sessionId,
            data: output
          })
        }

        console.log(`[RemoteAgentServer] Starting stream for session ${sessionId}`)
        try {
          for await (const chunk of this.claudeManager.streamChat(
            sessionId,
            chatMessages,
            options,
            onToolCall,
            onTerminalOutput
          )) {
            if (chunk.type === 'text') {
              // Send text delta in format expected by client
              this.sendMessage(ws, {
                type: 'claude:stream',
                sessionId,
                data: { text: chunk.data?.text || '' }
              })
            }
            // Other event types (tool_call, tool_result, terminal) are sent via callbacks
          }
          console.log(`[RemoteAgentServer] Stream completed for session ${sessionId}`)
        } catch (streamError) {
          console.error(`[RemoteAgentServer] Stream error for session ${sessionId}:`, streamError)
          throw streamError // Re-throw to be caught by outer try/catch
        }

        console.log(`[RemoteAgentServer] Chat completed for session ${sessionId}`)
        this.sendMessage(ws, {
          type: 'claude:complete',
          sessionId
        })
      } else {
        // Non-streaming mode
        const response = await this.claudeManager.chat(sessionId, chatMessages, options)
        this.sendMessage(ws, {
          type: 'claude:complete',
          sessionId,
          data: { content: response }
        })
      }
    } catch (error) {
      console.error(`[RemoteAgentServer] Chat error for session ${sessionId}:`, error)
      console.error(`[RemoteAgentServer] Error details:`, error instanceof Error ? {
        message: error.message,
        stack: error.stack
      } : String(error))
      this.sendMessage(ws, {
        type: 'claude:error',
        sessionId,
        data: { error: error instanceof Error ? error.message : String(error) }
      })
    }
  }

  /**
   * Handle file operations using V2 Session
   */
  private async handleFileOperation(ws: WebSocket, sessionId: string, operation: string, payload: any): Promise<void> {
    try {
      const path = payload?.path || '/'
      let result

      switch (operation) {
        case 'fs:list':
          result = await this.claudeManager.listFiles(sessionId, path)
          break
        case 'fs:read':
          result = await this.claudeManager.readFile(sessionId, path)
          break
        case 'fs:write':
          result = await this.claudeManager.writeFile(sessionId, path, payload?.content || '')
          break
        case 'fs:delete':
          result = await this.claudeManager.deleteFile(sessionId, path)
          break
        default:
          throw new Error(`Unknown file operation: ${operation}`)
      }

      this.sendMessage(ws, {
        type: 'fs:result',
        sessionId,
        data: result
      })
    } catch (error) {
      this.sendMessage(ws, {
        type: 'fs:error',
        sessionId,
        data: { error: error instanceof Error ? error.message : String(error) }
      })
    }
  }

  private sendMessage(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message))
    } catch (error) {
      console.error('Failed to send message:', error)
    }
  }

  private sendError(ws: WebSocket, message: string, sessionId?: string): void {
    this.sendMessage(ws, {
      type: 'claude:error',
      sessionId,
      data: { error: message }
    })
  }

  close(): void {
    this.clients.forEach((client, ws) => {
      if (client.sessionId) {
        this.claudeManager.closeSession(client.sessionId)
      }
      ws.close()
    })
    this.clients.clear()
    this.server.close()
    this.claudeManager.closeAllSessions()
    console.log('Server closed')
  }
}
