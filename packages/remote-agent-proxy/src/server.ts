import { WebSocketServer, WebSocket } from 'ws'
import * as http from 'http'
import * as fs from 'fs'
import type { ServerMessage, ClientMessage, RemoteServerConfig, ToolCallData, TerminalOutputData, ThoughtData, ThoughtDeltaData, HyperSpaceToolsConfig, TokensFile, TokenEntry } from './types.js'
import { ClaudeManager, type ChatMessage, type ChatOptions, type ToolCall, type TerminalOutput, type ThoughtEvent, type ThoughtDeltaEvent } from './claude-manager.js'

export class RemoteAgentServer {
  private config: RemoteServerConfig
  private server: WebSocketServer
  private httpServer?: http.Server
  // Extended client state to track SDK session ID for resumption
  private clients: Map<WebSocket, {
    authenticated: boolean
    sessionId?: string  // Conversation ID
    sdkSessionId?: string  // SDK's real session ID for resumption
  }> = new Map()
  private claudeManager: ClaudeManager

  // Token whitelist: merged from tokens.json and bootstrap env var
  private authTokens: Set<string> = new Set()

  // Pending hyper-space tool approvals: toolId -> { resolve, reject }
  private pendingHyperSpaceTools = new Map<string, {
    resolve: (result: string) => void
    reject: (error: Error) => void
  }>()

  constructor(config: RemoteServerConfig) {
    this.config = config
    // Explicitly listen on IPv4 to ensure compatibility
    this.server = new WebSocketServer({ port: config.port, host: '0.0.0.0' })

    // Build token whitelist: tokens.json entries + bootstrap env var fallback
    if (config.authTokens) {
      for (const t of config.authTokens) {
        this.authTokens.add(t)
      }
    }
    if (config.authToken) {
      this.authTokens.add(config.authToken)
    }
    console.log(`[RemoteAgentServer] Auth whitelist initialized with ${this.authTokens.size} token(s)`)

    if (!config.claudeApiKey) {
      console.warn('Warning: No Claude API key provided. Chat features will be unavailable.')
    }

    // Use pathToClaudeCodeExecutable from config or environment variable
    // If not set, the SDK will use its default behavior (SDK mode)
    const claudeCodePath = config.pathToClaudeCodeExecutable || process.env.PATH_TO_CLAUDE_CODE_EXECUTABLE

    this.claudeManager = new ClaudeManager(
      config.claudeApiKey,
      config.claudeBaseUrl,
      claudeCodePath || undefined,  // Pass undefined if not configured (SDK mode)
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

      if (this.authTokens.size > 0 && typeof authHeader === 'string') {
        const token = authHeader.split(' ')[1]
        if (this.isTokenValid(token)) {
          console.log('Client authenticated via Authorization header')
          this.clients.set(ws, { authenticated: true })
        } else {
          console.log('Authentication failed via Authorization header')
          ws.close(1008, 'Unauthorized')
          return
        }
      } else if (this.authTokens.size === 0) {
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
        // Don't close the SDK session on WebSocket disconnect!
        // The SDK session maintains conversation history and should persist
        // across WebSocket reconnections. Sessions have their own 30-minute
        // idle timeout cleanup in ClaudeManager.
        // This fixes the multi-turn conversation issue where history was lost
        // on every WebSocket reconnection.
        const client = this.clients.get(ws)
        if (client?.sessionId) {
          console.log(`Client disconnected, keeping SDK session ${client.sessionId} alive for future reconnection`)
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

    // Setup HTTP health endpoint on a separate port (WebSocket port + 1)
    this.setupHttpHealthEndpoint()
  }

  /**
   * Setup HTTP health endpoint for deployment status checks
   * Listens on WebSocket port + 1
   */
  private setupHttpHealthEndpoint(): void {
    const healthPort = (this.config.port || 8080) + 1

    this.httpServer = http.createServer((req, res) => {
      if (req.url === '/health' || req.url === '/healthz') {
        const stats = this.claudeManager.getStats()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          status: 'ok',
          activeSessions: stats.activeRequests,
          totalSessions: stats.totalSessions,
          timestamp: new Date().toISOString()
        }))
      } else if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          name: 'remote-agent-proxy',
          version: '1.0.0',
          endpoints: ['/health', '/healthz']
        }))
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not Found')
      }
    })

    this.httpServer.listen(healthPort, '0.0.0.0', () => {
      console.log(`Health endpoint listening on port ${healthPort}`)
    })

    this.httpServer.on('error', (error) => {
      console.error(`Health endpoint error:`, error)
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
    } else if ((message.type as string) === 'claude:interrupt') {
      // Interrupt an active conversation
      const sid = sessionId || client.sessionId
      if (sid) {
        console.log(`[RemoteAgentServer] Interrupt request for session: ${sid}`)
        await this.handleClaudeInterrupt(sid)
      }
    } else if (message.type === 'close:session') {
      // Clean up SDK session - called when client disconnects after stop
      const sid = sessionId || client.sessionId
      if (sid) {
        console.log(`[RemoteAgentServer] Close session request for: ${sid}`)
        this.claudeManager.removeSession(sid)
        console.log(`[RemoteAgentServer] SDK session removed: ${sid}`)
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
      // Tool approval/rejection — used by Hyper Space MCP proxy tools.
      // When remote Claude calls a hyper-space tool (e.g., report_to_leader),
      // the proxy sends tool:call to Halo, Halo executes it, then sends
      // tool:approve back with the result. The pending promise is resolved here.
      const toolId = message.payload?.toolId
      if (!toolId) {
        console.log(`[${message.type}] Missing toolId in payload`)
        return
      }
      const pending = this.pendingHyperSpaceTools.get(toolId)
      if (pending) {
        this.pendingHyperSpaceTools.delete(toolId)
        if (message.type === 'tool:approve') {
          console.log(`[tool:approve] Resolving hyper-space tool ${toolId}`)
          pending.resolve(message.payload?.result || 'OK')
        } else {
          console.log(`[tool:reject] Rejecting hyper-space tool ${toolId}: ${message.payload?.reason}`)
          pending.reject(new Error(message.payload?.reason || 'Tool rejected by client'))
        }
      } else {
        console.log(`[${message.type}] No pending tool found for ID: ${toolId}`)
      }
    } else if (message.type === 'register-token') {
      // Register a new token to the whitelist
      // Client must already be authenticated to register a new token
      if (!client.authenticated) {
        this.sendMessage(ws, {
          type: 'register-token:error',
          data: { message: 'Must be authenticated to register a token' }
        })
        return
      }
      await this.handleRegisterToken(message.payload)
      this.sendMessage(ws, { type: 'register-token:success' })
    } else {
      this.sendError(ws, 'Unknown message type', sessionId)
    }
  }

  private handleAuth(ws: WebSocket, token: string): void {
    if (this.authTokens.size > 0) {
      if (this.isTokenValid(token)) {
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

  /**
   * Check if a token is valid against the whitelist.
   * Returns true if whitelist is empty (no auth required).
   */
  private isTokenValid(token: string | undefined): boolean {
    if (this.authTokens.size === 0) {
      return true
    }
    return token !== undefined && this.authTokens.has(token)
  }

  /**
   * Handle token registration: add a new token to the whitelist and persist to tokens.json.
   * If the token already exists, update lastSeen.
   */
  private handleRegisterToken(payload: any): void {
    const token = payload?.token
    const clientId = payload?.clientId || 'unknown'
    const hostname = payload?.hostname || 'unknown'

    if (!token) {
      console.log('[RemoteAgentServer] register-token: missing token in payload')
      return
    }

    if (this.authTokens.has(token)) {
      console.log(`[RemoteAgentServer] Token already in whitelist (clientId: ${clientId})`)
      // Update lastSeen in tokens.json
      this.updateLastSeen(token, hostname)
      return
    }

    // Add to in-memory whitelist
    this.authTokens.add(token)
    console.log(`[RemoteAgentServer] New token registered (clientId: ${clientId}, hostname: ${hostname})`)

    // Persist to tokens.json
    this.persistTokenEntry({ token, clientId, hostname, createdAt: new Date().toISOString(), lastSeen: new Date().toISOString() })
  }

  /**
   * Update the lastSeen timestamp for an existing token in tokens.json.
   */
  private updateLastSeen(token: string, hostname: string): void {
    const tokensPath = this.config.tokensFilePath
    if (!tokensPath) return

    try {
      let data: TokensFile
      try {
        data = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'))
      } catch {
        data = { version: 1, tokens: [] }
      }

      const entry = data.tokens.find(t => t.token === token)
      if (entry) {
        entry.lastSeen = new Date().toISOString()
        if (hostname && hostname !== 'unknown') {
          entry.hostname = hostname
        }
        // Atomic write
        fs.writeFileSync(tokensPath + '.tmp', JSON.stringify(data, null, 2))
        fs.renameSync(tokensPath + '.tmp', tokensPath)
      }
    } catch (e) {
      console.error('[RemoteAgentServer] Failed to update lastSeen in tokens.json:', e)
    }
  }

  /**
   * Persist a new token entry to tokens.json (or update existing).
   * Uses atomic write (.tmp + rename) for crash safety.
   */
  private persistTokenEntry(entry: TokenEntry): void {
    const tokensPath = this.config.tokensFilePath
    if (!tokensPath) {
      console.warn('[RemoteAgentServer] No tokensFilePath configured, token not persisted to disk')
      return
    }

    try {
      let data: TokensFile
      try {
        data = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'))
      } catch {
        data = { version: 1, tokens: [] }
      }

      // Ensure version
      data.version = 1

      // Check if already exists
      const existing = data.tokens.find(t => t.token === entry.token)
      if (!existing) {
        data.tokens.push(entry)
      } else {
        existing.lastSeen = entry.lastSeen
        existing.hostname = entry.hostname
      }

      // Atomic write
      fs.writeFileSync(tokensPath + '.tmp', JSON.stringify(data, null, 2))
      fs.renameSync(tokensPath + '.tmp', tokensPath)
      console.log(`[RemoteAgentServer] tokens.json updated with ${data.tokens.length} token(s)`)
    } catch (e) {
      console.error('[RemoteAgentServer] Failed to persist token to tokens.json:', e)
    }
  }

  /**
   * Handle interrupt request for an active conversation
   */
  private async handleClaudeInterrupt(sessionId: string): Promise<void> {
    try {
      console.log(`[RemoteAgentServer] Handling interrupt for session: ${sessionId}`)

      // Get the active session from ClaudeManager and interrupt it
      const v2Session = this.claudeManager.getSession(sessionId)
      if (v2Session) {
        try {
          // Mark session as interrupted (for streamChat loop to detect)
          this.claudeManager.markAsInterrupted(sessionId)

          // Call SDK's interrupt method
          await (v2Session as any).interrupt()
          console.log(`[RemoteAgentServer] V2 session interrupted for: ${sessionId}`)
        } catch (e) {
          console.error(`[RemoteAgentServer] Failed to interrupt V2 session:`, e)
        }
      } else {
        console.log(`[RemoteAgentServer] No active session found for: ${sessionId}`)
      }

      // CRITICAL: Force abort the stream iterator to stop any pending async operations
      // This is necessary because SDK's interrupt() may not stop long-running operations
      const forceAborted = this.claudeManager.forceAbortStreamIterator(sessionId)
      if (forceAborted) {
        console.log(`[RemoteAgentServer] Stream iterator force aborted for: ${sessionId}`)
      }
    } catch (error) {
      console.error(`[RemoteAgentServer] Interrupt error for session ${sessionId}:`, error)
    }
  }

  private async handleClaudeChat(ws: WebSocket, sessionId: string, payload: any): Promise<void> {
    try {
      const { messages, options, stream = true } = payload
      const client = this.clients.get(ws)

      if (!messages || !Array.isArray(messages)) {
        this.sendMessage(ws, {
          type: 'claude:error',
          sessionId,
          data: { error: 'Invalid messages format' }
        })
        return
      }

      // Extract sdkSessionId from options for session resumption
      const sdkSessionIdForResume = options?.sdkSessionId

      console.log(`[RemoteAgentServer] Received claude:chat request for session ${sessionId} with ${messages.length} messages`)
      console.log(`[RemoteAgentServer] options.workDir = ${options?.workDir || 'not provided'}`)
      console.log(`[RemoteAgentServer] options.maxThinkingTokens = ${options?.maxThinkingTokens || 'not provided'}`)
      console.log(`[RemoteAgentServer] options.system = ${options?.system ? options.system.substring(0, 100) + '...' : 'not provided'}`)
      console.log(`[RemoteAgentServer] SDK session resumption: ${sdkSessionIdForResume || 'new session'}`)

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
          // Determine message type based on tool status
          let messageType: 'tool:call' | 'tool:result' | 'tool:error'
          if (tool.status === 'error') {
            messageType = 'tool:error'
          } else if (tool.status === 'result') {
            messageType = 'tool:result'
          } else {
            messageType = 'tool:call'
          }
          this.sendMessage(ws, {
            type: messageType,
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

        // Callback for thought events (thinking, tool_use, etc.)
        const onThought = (thought: ThoughtEvent) => {
          this.sendMessage(ws, {
            type: 'thought',
            sessionId,
            data: thought
          })
        }

        // Callback for thought delta events (streaming updates)
        const onThoughtDelta = (delta: ThoughtDeltaEvent) => {
          this.sendMessage(ws, {
            type: 'thought:delta',
            sessionId,
            data: delta
          })
        }

        // Callback for MCP status events
        const onMcpStatus = (data: { servers: Array<{ name: string; status: string }> }) => {
          this.sendMessage(ws, {
            type: 'mcp:status',
            sessionId,
            data: data
          })
        }

        // Callback for compact boundary events
        const onCompact = (data: { trigger: 'manual' | 'auto'; preTokens: number }) => {
          this.sendMessage(ws, {
            type: 'compact:boundary',
            sessionId,
            data: data
          })
        }

        console.log(`[RemoteAgentServer] Starting stream for session ${sessionId}`)
        let wasInterrupted = false

        // Hyper Space tool execution callback — if hyperSpaceTools config is present,
        // create a callback that proxy tool handlers can use to delegate to Halo
        const hyperSpaceToolExecutor = options.hyperSpaceTools
          ? (toolId: string, toolName: string, toolInput: Record<string, unknown>) =>
              this.executeHyperSpaceTool(ws, sessionId, toolId, toolName, toolInput)
          : undefined

        try {
          // Use sdkSessionId from client request for session resumption
          // This enables multi-turn conversations by resuming the SDK session
          const sdkSessionIdToUse = sdkSessionIdForResume

          for await (const chunk of this.claudeManager.streamChat(
            sessionId,
            chatMessages,
            options,
            sdkSessionIdToUse,  // Pass SDK session ID for resumption
            onToolCall,
            onTerminalOutput,
            onThought,
            onThoughtDelta,
            onMcpStatus,
            onCompact,
            hyperSpaceToolExecutor
          )) {
            if (chunk.type === 'text') {
              // Send text delta in format expected by client
              this.sendMessage(ws, {
                type: 'claude:stream',
                sessionId,
                data: { text: chunk.data?.text || '' }
              })
            } else if (chunk.type === 'text_block_start') {
              // Send text block start signal
              this.sendMessage(ws, {
                type: 'text:block-start',
                sessionId,
                data: {}
              })
            } else if (chunk.type === 'session_id') {
              // Send SDK session_id to client for session resumption
              const newSdkSessionId = chunk.data?.sessionId
              console.log(`[RemoteAgentServer] Forwarding SDK session_id: ${newSdkSessionId}`)
              this.sendMessage(ws, {
                type: 'claude:session',
                sessionId,
                data: { sdkSessionId: newSdkSessionId }
              })
              // Update client's SDK session ID for next request
              if (client && newSdkSessionId) {
                client.sdkSessionId = newSdkSessionId
                console.log(`[RemoteAgentServer] Updated SDK session ID: ${newSdkSessionId}`)
              }
            } else if (chunk.type === 'usage') {
              // Send token usage to client
              this.sendMessage(ws, {
                type: 'claude:usage',
                sessionId,
                data: chunk.data
              })
            } else if (chunk.type === 'worker:started') {
              // Forward subagent worker started event
              this.sendMessage(ws, {
                type: 'worker:started',
                sessionId,
                data: chunk.data
              })
            } else if (chunk.type === 'worker:completed') {
              // Forward subagent worker completed event
              this.sendMessage(ws, {
                type: 'worker:completed',
                sessionId,
                data: chunk.data
              })
            }
            // Other event types (tool_call, tool_result, terminal, thought) are sent via callbacks
          }
          console.log(`[RemoteAgentServer] Stream completed for session ${sessionId}`)
        } catch (streamError) {
          // Check if this is an expected interrupt
          const errorMessage = streamError instanceof Error ? streamError.message : String(streamError)
          if (errorMessage === 'Stream interrupted' || errorMessage === 'Stream aborted') {
            // Expected interrupt - mark and continue normally
            wasInterrupted = true
            console.log(`[RemoteAgentServer] Stream interrupted for session ${sessionId}`)
          } else {
            // Unexpected error - log and re-throw
            console.error(`[RemoteAgentServer] Stream error for session ${sessionId}:`, streamError)
            throw streamError
          }
        }

        // Check if session was interrupted (set by streamChat when interrupt detected)
        if (this.claudeManager.checkAndClearInterrupt(sessionId)) {
          wasInterrupted = true
          console.log(`[RemoteAgentServer] Interrupt detected after streamChat for session ${sessionId}`)
        }

        // Only send claude:complete if not interrupted
        if (!wasInterrupted) {
          console.log(`[RemoteAgentServer] Chat completed for session ${sessionId}`)
          this.sendMessage(ws, {
            type: 'claude:complete',
            sessionId
          })
        } else {
          console.log(`[RemoteAgentServer] Chat interrupted for session ${sessionId}`)
        }
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

  /**
   * Send a hyper-space tool invocation request to the Halo client and wait for the response.
   * Used by the MCP proxy tool handlers in ClaudeManager.
   *
   * Flow:
   * 1. MCP handler calls this with tool name + input
   * 2. This sends a tool:call event to the Halo client via WebSocket
   * 3. Registers a pending promise keyed by toolId
   * 4. Waits for Halo to respond via tool:approve (with result) or tool:reject
   * 5. Returns the result to the MCP handler, which returns it to Claude SDK
   */
  async executeHyperSpaceTool(
    ws: WebSocket,
    sessionId: string,
    toolId: string,
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string> {
    const timeoutMs = 30000 // 30s timeout for client response

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingHyperSpaceTools.delete(toolId)
        reject(new Error(`Hyper-space tool ${toolName} timed out waiting for client response`))
      }, timeoutMs)

      this.pendingHyperSpaceTools.set(toolId, {
        resolve: (result: string) => {
          clearTimeout(timer)
          resolve(result)
        },
        reject: (error: Error) => {
          clearTimeout(timer)
          reject(error)
        }
      })

      // Send tool:call to Halo client — same format as regular tool events
      this.sendMessage(ws, {
        type: 'tool:call',
        sessionId,
        data: {
          id: toolId,
          name: toolName,
          input: toolInput,
          status: 'running',
          isHyperSpace: true  // Flag: this is a hyper-space proxy tool, not a local CLI tool
        }
      })

      console.log(`[HyperSpace] Sent tool invocation to client: ${toolName} (${toolId})`)
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
    if (this.httpServer) {
      this.httpServer.close()
    }
    console.log('Server closed')
  }
}
