import { WebSocketServer, WebSocket } from 'ws'
import * as http from 'http'
import * as https from 'https'
import * as fs from 'fs'
import type { ServerMessage, ClientMessage, RemoteServerConfig, ToolCallData, TerminalOutputData, ThoughtData, ThoughtDeltaData, HyperSpaceToolsConfig, AicoBotMcpToolDef } from './types.js'
import { ClaudeManager, type ChatMessage, type ChatOptions, type ToolCall, type TerminalOutput, type ThoughtEvent, type ThoughtDeltaEvent } from './claude-manager.js'
import { BackgroundTaskManager } from './background-tasks.js'

/** Mask API key for safe logging (show first 8 chars only) */
function maskKey(key?: string): string {
  if (!key) return '(none)'
  return key.length > 10 ? key.substring(0, 8) + '...' : '***'
}

export class RemoteAgentServer {
  private config: RemoteServerConfig
  private server: WebSocketServer
  private httpServer?: http.Server
  // Extended client state to track SDK session ID for resumption
  private clients: Map<WebSocket, {
    authenticated: boolean
    sessionId?: string  // Conversation ID
    sdkSessionId?: string  // SDK's real session ID for resumption
    authToken?: string  // The token used to authenticate this connection (for credential lookup)
    // WebSocket MCP Bridge: tools registered by the AICO-Bot client
    aicoBotMcpTools?: Array<{ name: string; description: string; inputSchema: Record<string, any>; serverName: string }>
    aicoBotMcpCapabilities?: { aiBrowser: boolean; ghSearch: boolean; version?: number }
    lastClientActivityAt: number  // Timestamp of last received message from client (for heartbeat detection)
  }> = new Map()
  private claudeManager: ClaudeManager
  // BackgroundTaskManager for HTTP/WS API tasks (separate from MCP server's own manager)
  private bgTaskManager: BackgroundTaskManager

  // Auth tokens for multi-instance support (dev + packaged on same PC)
  private authTokens: Set<string> = new Set()
  private tokensJsonPath?: string

  // Pending hyper-space tool approvals: toolId -> { resolve, reject }
  private pendingHyperSpaceTools = new Map<string, {
    resolve: (result: string) => void
    reject: (error: Error) => void
  }>()

  // Pending AskUserQuestion answers: questionId -> { resolve, reject }
  private pendingAskQuestions = new Map<string, {
    resolve: (answers: Record<string, string>) => void
    reject: (error: Error) => void
  }>()

  // Pending tool permission requests: permissionId -> { resolve, reject }
  private pendingPermissions = new Map<string, {
    resolve: (approved: boolean) => void
    reject: (error: Error) => void
  }>()

  // Pending MCP tool calls: callId -> { resolve, reject }
  private pendingMcpToolCalls = new Map<string, {
    resolve: (result: any) => void
    reject: (error: Error) => void
  }>()

  // Per-session processing lock: prevents concurrent handleClaudeChat calls
  // for the same session. The Promise resolves when the current streamChat finishes.
  private sessionProcessingLocks = new Map<string, Promise<void>>()

  // Idle timeout: auto-stop after 7 days with no connected clients
  private lastClientActivity: Date = new Date()
  private idleCheckInterval?: NodeJS.Timeout
  private static readonly IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

  // Bidirectional heartbeat: detect dead clients
  private heartbeatCheckInterval?: NodeJS.Timeout
  private static readonly HEARTBEAT_INTERVAL_MS = 30 * 1000   // 30s — send ping if no client activity
  private static readonly HEARTBEAT_TIMEOUT_MS = 90 * 1000    // 90s — close if no client activity

  constructor(config: RemoteServerConfig) {
    this.config = config
    // Explicitly listen on IPv4 to ensure compatibility
    this.server = new WebSocketServer({ port: config.port, host: '0.0.0.0' })

    // Auth tokens for multi-instance support (dev + packaged on same PC)
    if (config.authToken) {
      this.authTokens.add(config.authToken)
    }
    if (config.authTokens) {
      for (const token of config.authTokens) {
        this.authTokens.add(token)
      }
    }
    this.tokensJsonPath = config.tokensJsonPath
    if (this.tokensJsonPath) {
      this.loadTokensFromFile(this.tokensJsonPath)
    }
    console.log(`[RemoteAgentServer] Auth configured: ${this.authTokens.size > 0 ? `yes (${this.authTokens.size} tokens)` : 'no (open access)'}`)

    // Use pathToClaudeCodeExecutable from config or environment variable
    // If not set, the SDK will use its default behavior (SDK mode)
    const claudeCodePath = config.pathToClaudeCodeExecutable || process.env.PATH_TO_CLAUDE_CODE_EXECUTABLE

    this.claudeManager = new ClaudeManager(
      undefined,  // API credentials are always provided per-request by AICO-Bot client
      undefined,
      claudeCodePath || undefined,  // Pass undefined if not configured (SDK mode)
      config.workDir,
      undefined  // Model is always provided per-request
    )

    // Initialize background task manager for HTTP/WS API tasks
    this.bgTaskManager = new BackgroundTaskManager()
    this.bgTaskManager.on('update', (event) => {
      this.broadcastToAllClients({
        type: 'task:update',
        data: event,
      })
    })

    this.setupServer()

    // Start idle timeout check (hourly)
    this.idleCheckInterval = setInterval(() => this.checkIdleTimeout(), 60 * 60 * 1000)

    // Start bidirectional heartbeat check (every 15s)
    this.startHeartbeatCheck()
  }

  private checkIdleTimeout(): void {
    // If there are connected clients, reset the timer
    let hasConnectedClients = false
    for (const [ws, state] of this.clients) {
      if (ws.readyState === WebSocket.OPEN && state.authenticated) {
        hasConnectedClients = true
        break
      }
    }

    if (hasConnectedClients) {
      this.lastClientActivity = new Date()
      return
    }

    const idleMs = Date.now() - this.lastClientActivity.getTime()
    if (idleMs >= RemoteAgentServer.IDLE_TIMEOUT_MS) {
      console.log(`[RemoteAgentServer] No clients connected for 7 days, shutting down`)
      this.close()
      process.exit(0)
    }
  }

  private setupServer(): void {
    this.server.on('connection', (ws: WebSocket, req) => {
      // Check for Authorization header authentication
      const authHeader = req.headers['authorization'] || req.headers['Authorization']

      if (this.authTokens.size > 0) {
        if (typeof authHeader === 'string') {
          const token = authHeader.split(' ')[1]
          if (token && this.authTokens.has(token)) {
            console.log('Client authenticated via Authorization header')
            this.clients.set(ws, { authenticated: true, authToken: token, lastClientActivityAt: Date.now() })
            this.lastClientActivity = new Date()
            ws.send(JSON.stringify({ type: 'auth:success' }))
          } else {
            console.log('Authentication failed via Authorization header, closing connection')
            ws.close(1008, 'Unauthorized')
            return
          }
        } else {
          this.clients.set(ws, { authenticated: false, lastClientActivityAt: Date.now() })
        }
      } else {
        // No auth configured, auto-authenticate
        console.log('No auth required, auto-authenticating')
        this.clients.set(ws, { authenticated: true, lastClientActivityAt: Date.now() })
        this.lastClientActivity = new Date()
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
        this.handleClientDisconnect(ws)
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

  private loadTokensFromFile(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8')
        const tokens = JSON.parse(content)
        if (Array.isArray(tokens)) {
          for (const token of tokens) {
            if (typeof token === 'string' && token.trim()) {
              this.authTokens.add(token.trim())
            }
          }
          console.log(`[RemoteAgentServer] Loaded ${tokens.length} tokens from ${filePath}`)
        }
      }
    } catch (error) {
      console.error(`[RemoteAgentServer] Failed to load tokens file:`, error)
    }
  }

  private saveTokensToFile(): void {
    if (!this.tokensJsonPath) return
    try {
      fs.writeFileSync(this.tokensJsonPath, JSON.stringify([...this.authTokens], null, 2))
    } catch (error) {
      console.error(`[RemoteAgentServer] Failed to save tokens file:`, error)
    }
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
      } else if (req.url === '/tasks') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(this.bgTaskManager.list()))
      } else if (req.url?.startsWith('/tasks/') && req.method === 'DELETE') {
        const taskId = req.url.split('/tasks/')[1]
        const ok = this.bgTaskManager.cancel(taskId)
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: ok }))
      } else if (req.url === '/health/api' && req.method === 'POST') {
        // API reachability check: validates that the proxy can call the configured API
        this.handleHealthApiCheck(req, res)
      } else if (req.url === '/tokens' && req.method === 'POST') {
        // Dynamic token registration for multi-instance support
        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk.toString() })
        req.on('end', () => {
          try {
            const { token } = JSON.parse(body)
            if (!token || typeof token !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Missing or invalid "token" field' }))
              return
            }
            const added = !this.authTokens.has(token)
            this.authTokens.add(token)
            this.saveTokensToFile()
            console.log(`[RemoteAgentServer] Token registered via HTTP (new: ${added}, total: ${this.authTokens.size})`)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, added, totalTokens: this.authTokens.size }))
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid JSON body' }))
          }
        })
      } else if (req.url === '/tokens' && req.method === 'GET') {
        const maskedTokens = [...this.authTokens].map(t => t.substring(0, 8) + '...')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ tokens: maskedTokens, count: this.authTokens.size }))
      } else if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          name: 'remote-agent-proxy',
          version: '1.0.0',
          endpoints: ['/health', '/healthz', '/health/api', '/tasks', '/tokens']
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

  /**
   * Handle POST /health/api — validate API connectivity by making a minimal
   * API call with the provided credentials. Returns quickly with success/failure.
   */
  private handleHealthApiCheck(req: http.IncomingMessage, res: http.ServerResponse): void {
    const timeout = setTimeout(() => {
      res.writeHead(504, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'error', error: 'API check timed out' }))
    }, 15000)

    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', async () => {
      clearTimeout(timeout)
      try {
        const { apiKey, baseUrl, model } = JSON.parse(body)
        if (!apiKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'error', error: 'Missing apiKey' }))
          return
        }

        const start = Date.now()
        const url = new URL(baseUrl
          ? `${baseUrl.replace(/\/+$/, '')}/v1/messages`
          : 'https://api.anthropic.com/v1/messages')

        const reqOpts: http.RequestOptions | https.RequestOptions = {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          timeout: 10000,
        }

        const transport = url.protocol === 'https:' ? https : http
        const apiReq = transport.request(reqOpts, (apiRes) => {
          let data = ''
          apiRes.on('data', (chunk: Buffer) => { data += chunk.toString() })
          apiRes.on('end', () => {
            const latency = Date.now() - start
            if (apiRes.statusCode && apiRes.statusCode >= 200 && apiRes.statusCode < 300) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ status: 'ok', model, latency }))
            } else {
              let errorMsg = `HTTP ${apiRes.statusCode}`
              try {
                const parsed = JSON.parse(data)
                errorMsg = parsed.error?.message || parsed.message || errorMsg
              } catch { /* use default */ }
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ status: 'error', error: errorMsg, latency }))
            }
          })
        })

        apiReq.on('timeout', () => {
          apiReq.destroy()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'error', error: 'API request timed out', latency: Date.now() - start }))
        })
        apiReq.on('error', (err) => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'error', error: err.message, latency: Date.now() - start }))
        })

        // Send a minimal messages request (max_tokens:1 to minimize token usage)
        apiReq.write(JSON.stringify({
          model: model || 'claude-sonnet-4-20250514',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }))
        apiReq.end()
      } catch (err: any) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'error', error: err.message || 'Invalid request' }))
      }
    })
    req.on('error', () => {
      clearTimeout(timeout)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'error', error: 'Request body read error' }))
    })
  }

  private async handleMessage(ws: WebSocket, message: ClientMessage): Promise<void> {
    const client = this.clients.get(ws)
    if (!client) return

    // Update client activity timestamp for bidirectional heartbeat detection
    client.lastClientActivityAt = Date.now()

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
      // API credentials are always provided per-request by the AICO-Bot client
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
    } else if (message.type === 'fs:stat') {
      // Session-less path stat — check if path exists and is a directory
      const path = message.payload?.path
      if (!path) {
        this.sendMessage(ws, { type: 'fs:result', data: { exists: false, isDirectory: false, error: 'Path is required' } })
        return
      }
      try {
        const stat = fs.statSync(path)
        this.sendMessage(ws, { type: 'fs:result', data: { exists: true, isDirectory: stat.isDirectory() } })
      } catch (err: any) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
          this.sendMessage(ws, { type: 'fs:result', data: { exists: false, isDirectory: false } })
        } else {
          this.sendMessage(ws, { type: 'fs:result', data: { exists: false, isDirectory: false, error: err.message } })
        }
      }
    } else if (message.type === 'fs:mkdir') {
      // Session-less mkdir — recursively create directory
      const path = message.payload?.path
      if (!path) {
        this.sendMessage(ws, { type: 'fs:result', data: { success: false, error: 'Path is required' } })
        return
      }
      try {
        fs.mkdirSync(path, { recursive: true })
        this.sendMessage(ws, { type: 'fs:result', data: { success: true } })
      } catch (err: any) {
        this.sendMessage(ws, { type: 'fs:result', data: { success: false, error: err.message } })
      }
    } else if (['fs:list', 'fs:read', 'fs:write', 'fs:delete', 'fs:upload', 'fs:download'].includes(message.type)) {
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
    } else if (message.type === 'pong') {
      // Client responded to server's heartbeat ping — lastClientActivityAt already updated above
    } else if (message.type === 'tool:approve' || message.type === 'tool:reject') {
      // Tool approval/rejection — used by Hyper Space MCP proxy tools.
      // When remote Claude calls a hyper-space tool (e.g., report_to_leader),
      // the proxy sends tool:call to AICO-Bot, AICO-Bot executes it, then sends
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
        // Check if this is a tool permission request response
        const permissionPending = this.pendingPermissions.get(toolId)
        if (permissionPending) {
          this.pendingPermissions.delete(toolId)
          const approved = (message.payload as any)?.approved !== false
          // [DIAG-1.6] Log tool:approve for permission
          console.log(`[DIAG][PermissionHandler] Received tool:approve for permission ${toolId}, approved=${approved}`)
          permissionPending.resolve(approved)
        } else {
          console.log(`[${message.type}] No pending tool or permission found for ID: ${toolId}`)
        }
      }
    } else if (message.type === 'ask:answer') {
      // User answered an AskUserQuestion from the remote Claude
      const questionId = message.payload?.id
      const answers = message.payload?.answers
      if (!questionId) {
        console.log('[ask:answer] Missing id in payload')
        return
      }
      const pending = this.pendingAskQuestions.get(questionId)
      if (pending) {
        this.pendingAskQuestions.delete(questionId)
        console.log(`[ask:answer] Resolving question ${questionId}`, answers)
        pending.resolve(answers || {})
      } else {
        console.log(`[ask:answer] No pending question found for id: ${questionId}`)
      }
    } else if (message.type === 'mcp:tools:register') {
      // WebSocket MCP Bridge: AICO-Bot client registers its available MCP tools
      const client = this.clients.get(ws)
      if (client) {
        client.aicoBotMcpTools = message.payload?.tools
        client.aicoBotMcpCapabilities = message.payload?.aicoBotMcpCapabilities
        console.log(`[MCP Bridge] AICO-Bot client registered ${client.aicoBotMcpTools?.length || 0} MCP tools, capabilities: ${JSON.stringify(client.aicoBotMcpCapabilities)}`)
      }
    } else if (message.type === 'mcp:tool:response') {
      // WebSocket MCP Bridge: AICO-Bot client returns tool execution result
      const callId = message.payload?.callId
      if (callId) {
        const pending = this.pendingMcpToolCalls.get(callId)
        if (pending) {
          this.pendingMcpToolCalls.delete(callId)
          pending.resolve(message.payload?.toolResult)
        } else {
          console.warn(`[MCP Bridge] No pending tool call found for callId: ${callId}`)
        }
      }
    } else if (message.type === 'mcp:tool:error') {
      // WebSocket MCP Bridge: AICO-Bot client returns tool execution error
      const callId = message.payload?.callId
      if (callId) {
        const pending = this.pendingMcpToolCalls.get(callId)
        if (pending) {
          this.pendingMcpToolCalls.delete(callId)
          pending.reject(new Error(message.payload?.toolError || 'MCP tool error'))
        } else {
          console.warn(`[MCP Bridge] No pending tool call found for callId: ${callId} (error)`)
        }
      }
    } else if (message.type === 'task:list') {
      this.sendMessage(ws, { type: 'task:list', data: this.bgTaskManager.list() })
    } else if (message.type === 'task:get') {
      const task = this.bgTaskManager.get(message.payload?.id || '')
      this.sendMessage(ws, { type: 'task:get', data: task || null })
    } else if (message.type === 'task:cancel') {
      const ok = this.bgTaskManager.cancel(message.payload?.id || '')
      this.sendMessage(ws, { type: 'task:cancel', data: { success: ok } })
    } else if (message.type === 'task:spawn') {
      const task = this.bgTaskManager.spawn(message.payload?.command || '', message.payload?.cwd)
      this.sendMessage(ws, { type: 'task:spawn', data: task })
    } else {
      this.sendError(ws, 'Unknown message type', sessionId)
    }
  }

  private handleAuth(ws: WebSocket, token: string): void {
    if (this.authTokens.size > 0) {
      if (this.authTokens.has(token)) {
        const client = this.clients.get(ws)
        if (client) {
          client.authenticated = true
          client.authToken = token
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
   * Handle interrupt request for an active conversation
   */
  private async handleClaudeInterrupt(sessionId: string): Promise<void> {
    try {
      console.log(`[RemoteAgentServer] Handling interrupt for session: ${sessionId}`)

      // Mark session as interrupted (for streamChat loop to detect via poll)
      this.claudeManager.markAsInterrupted(sessionId)

      // Force abort the stream iterator to release the session lock.
      // This is sufficient to stop the server-side stream processing.
      // We intentionally do NOT call v2Session.interrupt() here because:
      // 1. It sends SIGINT to the SDK subprocess, which exits and triggers
      //    process-exit cleanup that removes the session from memory
      // 2. Without the session, the next message creates a fresh session, losing all context
      // 3. forceAbortStreamIterator + markAsInterrupted already stops the stream and releases the lock
      // 4. The SDK subprocess will continue running (idle), ready for session reuse
      const forceAborted = this.claudeManager.forceAbortStreamIterator(sessionId)
      if (forceAborted) {
        console.log(`[RemoteAgentServer] Stream iterator force aborted for: ${sessionId}`)
      }
    } catch (error) {
      console.error(`[RemoteAgentServer] Interrupt error for session ${sessionId}:`, error)
    }
  }

  private async handleClaudeChat(ws: WebSocket, sessionId: string, payload: any): Promise<void> {
    // Per-session lock variables — declared here so finally block can access them
    let resolveLock: (() => void) | undefined
    let globalTimer: ReturnType<typeof setTimeout> | undefined
    let aliveTimer: ReturnType<typeof setInterval> | undefined
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

      // Credentials are always provided per-request by the AICO-Bot client.
      // No token-bound or instance-level credential resolution needed.
      const resolvedOptions = options

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

      // Per-session lock: prevent concurrent streamChat calls for the same session.
      // Without this, the gap between isActive() check and registerActiveSession()
      // inside streamChat() allows two claude:chat messages to bypass the guard.
      const existingLock = this.sessionProcessingLocks.get(sessionId)
      if (existingLock) {
        const lastMessage = chatMessages[chatMessages.length - 1]
        if (lastMessage?.role === 'user') {
          this.claudeManager.queueMessage(sessionId, lastMessage.content, resolvedOptions)
          console.log(`[RemoteAgentServer] Session ${sessionId} already processing, queued message`)
        }
        return
      }
      resolveLock = undefined
      const lockPromise = new Promise<void>(resolve => { resolveLock = resolve })
      this.sessionProcessingLocks.set(sessionId, lockPromise)

      if (stream) {
        // Track current tool for stream:alive heartbeat
        let currentToolName: string | undefined
        let currentToolStartTime: number | undefined
        const streamStartTime = Date.now()

        // Register process exit callback — notify client immediately when SDK dies
        this.claudeManager.registerSessionExitCallback(sessionId, (reason: string) => {
          console.error(`[RemoteAgentServer] SDK process died for session ${sessionId}: ${reason}`)
          this.sendMessage(ws, {
            type: 'claude:error',
            sessionId,
            data: { error: `SDK process crashed: ${reason}`, isProcessDeath: true }
          })
        })

        // Callbacks for tool and terminal events
        const onToolCall = (tool: ToolCall) => {
          console.log(`[RemoteAgentServer] Tool ${tool.status}: ${tool.name || 'unknown'}`)
          // Update tool tracking for stream:alive
          if (tool.status === 'running' || tool.status === 'started') {
            currentToolName = tool.name
            currentToolStartTime = Date.now()
          } else if (tool.status === 'result' || tool.status === 'error') {
            currentToolName = undefined
            currentToolStartTime = undefined
          }
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

        // Hyper Space tool execution — legacy bridge mode for old AICO-Bot clients
        const hyperSpaceToolExecutor = options.hyperSpaceTools
          ? (toolId: string, toolName: string, toolInput: Record<string, unknown>) =>
              this.executeHyperSpaceTool(ws, sessionId, toolId, toolName, toolInput)
          : undefined

        // WebSocket MCP Bridge tool execution callback
        const clientState = this.clients.get(ws)
        const aicoBotMcpToolDefs = clientState?.aicoBotMcpTools
        const aicoBotMcpToolExecutor = aicoBotMcpToolDefs && aicoBotMcpToolDefs.length > 0
          ? (callId: string, toolName: string, args: Record<string, unknown>) =>
              this.executeAicoBotMcpTool(ws, sessionId, callId, toolName, args)
          : undefined

        // AskUserQuestion handler — forward question to AICO-Bot client, wait for answer
        const onAskUserQuestion = (id: string, questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>) => {
          return new Promise<Record<string, string>>((resolve, reject) => {
            this.pendingAskQuestions.set(id, { resolve, reject })
            // Send question to AICO-Bot client
            this.sendMessage(ws, {
              type: 'ask:question',
              sessionId,
              data: { id, questions }
            })
            // 10 minute timeout for user response
            setTimeout(() => {
              if (this.pendingAskQuestions.has(id)) {
                this.pendingAskQuestions.delete(id)
                reject(new Error('AskUserQuestion timeout'))
              }
            }, 10 * 60 * 1000)
          })
        }

        // Permission request handler — forward to AICO-Bot client, wait for user approval/deny
        const onPermissionRequest = (id: string, toolName: string, toolInput: Record<string, unknown>) => {
          return new Promise<boolean>((resolve, reject) => {
            this.pendingPermissions.set(id, { resolve, reject })
            // [DIAG-1.6] Log permission:request send
            console.log(`[DIAG][PermissionHandler] Sending permission:request to client: id=${id}, tool=${toolName}, sessionId=${sessionId}`)
            // Send permission request to AICO-Bot client
            this.sendMessage(ws, {
              type: 'permission:request',
              sessionId,
              data: { id, toolName, toolInput }
            })
            // 10 minute timeout for user response
            setTimeout(() => {
              if (this.pendingPermissions.has(id)) {
                this.pendingPermissions.delete(id)
                reject(new Error('Permission request timeout'))
              }
            }, 10 * 60 * 1000)
          })
        }

        let needsClosedSessionRetry = false

        try {
          const sdkSessionIdToUse = sdkSessionIdForResume;

          // Auth retry loop — rebuild session with fresh credentials on 401
          const MAX_AUTH_RETRIES = 1
          let authRetries = 0
          let needsAuthRetry = false

          // Outer loop: process current message, then any pending messages queued during streaming
          let currentChatMessages = chatMessages
          let currentOptions = resolvedOptions
          let isFirstIteration = true

          while (true) {
          do {
            needsAuthRetry = false

          // Skip resume session ID on auth retry or closed session retry
          const shouldSkipResume = authRetries > 0 || needsClosedSessionRetry

          // Check if session has an active stream — if so, queue message and return.
          // Only check on the first iteration (subsequent iterations are for pending messages
          // and the previous streamChat has already completed).
          if (isFirstIteration) {
          const lastMessage = currentChatMessages[currentChatMessages.length - 1]
          if (this.claudeManager.isActive(sessionId) && lastMessage?.role === 'user') {
            this.claudeManager.queueMessage(sessionId, lastMessage.content, currentOptions)
            return
          }
          isFirstIteration = false
          }

          // Global stream timeout — absolute upper bound for a single stream iteration
          const STREAM_GLOBAL_TIMEOUT_MS = currentOptions?.globalTimeoutMs ?? 2 * 60 * 60 * 1000; // default 2 hours
          if (STREAM_GLOBAL_TIMEOUT_MS > 0) {
            globalTimer = setTimeout(() => {
              console.error(`[RemoteAgentServer] Stream global timeout (${STREAM_GLOBAL_TIMEOUT_MS / 60000}min) for session ${sessionId}`)
              this.sendMessage(ws, {
                type: 'claude:error',
                sessionId,
                data: { error: `Stream global timeout (${Math.round(STREAM_GLOBAL_TIMEOUT_MS / 60000)} minutes)`, isGlobalTimeout: true }
              })
              this.claudeManager.forceAbortStreamIterator(sessionId)
            }, STREAM_GLOBAL_TIMEOUT_MS)
          }

          // Stream alive heartbeat — every 5 minutes, proves Agent is still working
          const ALIVE_INTERVAL_MS = 5 * 60 * 1000
          aliveTimer = setInterval(() => {
            const elapsed = Date.now() - streamStartTime
            this.sendMessage(ws, {
              type: 'stream:alive',
              sessionId,
              data: {
                elapsedMs: elapsed,
                currentToolName,
                currentToolElapsedMs: currentToolStartTime ? Date.now() - currentToolStartTime : undefined,
              } satisfies import('./types').StreamAliveData
            })
            console.log(`[RemoteAgentServer] stream:alive for ${sessionId} — ${Math.round(elapsed / 60000)}min, tool=${currentToolName || 'none'}`)
          }, ALIVE_INTERVAL_MS)

          for await (const chunk of this.claudeManager.streamChat(
            sessionId,
            currentChatMessages,
            currentOptions,
            shouldSkipResume ? undefined : sdkSessionIdToUse,  // Don't resume on retry
            onToolCall,
            onTerminalOutput,
            onThought,
            onThoughtDelta,
            onMcpStatus,
            onCompact,
            hyperSpaceToolExecutor,
            aicoBotMcpToolExecutor,
            aicoBotMcpToolDefs,
            onAskUserQuestion,
            onPermissionRequest
          )) {
            // Auth retry detected — signal for session rebuild after stream ends
            if (chunk.type === 'auth_retry_required') {
              needsAuthRetry = true
              continue  // Don't forward to client
            }
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
            } else if (chunk.type === 'context-usage') {
              // Send real-time context usage to client
              this.sendMessage(ws, {
                type: 'claude:context-usage',
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

          if (globalTimer) clearTimeout(globalTimer)
          if (aliveTimer) clearInterval(aliveTimer)

          // Check if auth retry is needed (after stream completes)
          if (needsAuthRetry && authRetries < MAX_AUTH_RETRIES) {
            authRetries++
            console.warn(`[RemoteAgentServer] Auth retry #${authRetries} for session ${sessionId}: rebuilding session`)

            // Notify client about auth recovery
            this.sendMessage(ws, {
              type: 'auth_retry',
              sessionId,
              data: { attempt: authRetries, maxRetries: MAX_AUTH_RETRIES }
            })

            // Force session rebuild — next streamChat call creates fresh session
            this.claudeManager.forceSessionRebuild(sessionId)
          }
          } while (needsAuthRetry && authRetries < MAX_AUTH_RETRIES)
          console.log(`[RemoteAgentServer] Stream completed for session ${sessionId}`)

          // Check for pending messages queued during streaming
          const pending = this.claudeManager.consumePendingMessages(sessionId)
          if (pending.length === 0) break

          // If our WebSocket is dead (e.g. client disconnected after interrupt),
          // don't process pending messages — a new connection will handle them.
          // Without this check, the old handler consumes new client's messages
          // and sends responses to the dead ws, causing the new client to hang forever.
          if (ws.readyState !== WebSocket.OPEN) {
            console.log(`[RemoteAgentServer] WebSocket dead with ${pending.length} pending message(s), putting back for new connection`)
            for (const msg of pending) {
              this.claudeManager.queueMessage(sessionId, msg.content, msg.options)
            }
            break
          }

          // Process first pending message, put the rest back
          const nextMsg = pending[0]
          for (const extra of pending.slice(1)) {
            this.claudeManager.queueMessage(sessionId, extra.content, extra.options)
          }
          currentChatMessages = [{ role: 'user' as const, content: nextMsg.content }]
          currentOptions = nextMsg.options || resolvedOptions
          console.log(`[RemoteAgentServer] Processing ${pending.length} pending message(s) for session ${sessionId}`)
          } // end while (pending messages loop)
        } catch (streamError) {
          if (globalTimer) clearTimeout(globalTimer)
          if (aliveTimer) clearInterval(aliveTimer)
          // Check if this is an expected interrupt
          const errorMessage = streamError instanceof Error ? streamError.message : String(streamError)
          if (errorMessage === 'Stream interrupted' || errorMessage === 'Stream aborted') {
            // Expected interrupt - mark and continue normally
            wasInterrupted = true
            console.log(`[RemoteAgentServer] Stream interrupted for session ${sessionId}`)
          } else if (errorMessage.includes('SESSION_CORRUPTED') && !needsClosedSessionRetry) {
            // First-event timeout: session was corrupted after interrupt reuse.
            // Force rebuild (skip resume) and retry once.
            console.warn(`[RemoteAgentServer] Session corrupted (first-event timeout) for session ${sessionId}, rebuilding and retrying...`)
            this.claudeManager.forceSessionRebuild(sessionId)
            needsClosedSessionRetry = true
          } else if (errorMessage.includes('Cannot send to closed session') && !wasInterrupted && !needsClosedSessionRetry) {
            // Race condition: close:session arrived concurrently and closed the SDK session
            // before/during session.send(). Rebuild session and retry once.
            console.warn(`[RemoteAgentServer] Closed session race detected for session ${sessionId}, rebuilding and retrying...`)
            this.claudeManager.forceSessionRebuild(sessionId)
            needsClosedSessionRetry = true
            // Don't re-throw — let execution continue to interrupt check + complete below
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

        // Reject any pending AskUserQuestion when stream ends
        for (const [id, pending] of this.pendingAskQuestions) {
          pending.reject(new Error('Stream ended'))
          this.pendingAskQuestions.delete(id)
        }

        // Reject any pending permission requests when stream ends
        for (const [id, pending] of this.pendingPermissions) {
          pending.reject(new Error('Stream ended'))
          this.pendingPermissions.delete(id)
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
      // Clear pending messages on error to prevent stale queue
      this.claudeManager.clearPendingMessages(sessionId)
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
    } finally {
      if (globalTimer) clearTimeout(globalTimer)
      if (aliveTimer) clearInterval(aliveTimer)
      this.claudeManager.unregisterSessionExitCallback(sessionId)
      // Release per-session lock to allow next message to be processed
      if (resolveLock) {
        this.sessionProcessingLocks.delete(sessionId)
        resolveLock()
      }
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
   * Send a hyper-space tool invocation request to the AICO-Bot client and wait for the response.
   * Used by the MCP proxy tool handlers in ClaudeManager.
   *
   * Flow:
   * 1. MCP handler calls this with tool name + input
   * 2. This sends a tool:call event to the AICO-Bot client via WebSocket
   * 3. Registers a pending promise keyed by toolId
   * 4. Waits for AICO-Bot to respond via tool:approve (with result) or tool:reject
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

      // Send tool:call to AICO-Bot client — same format as regular tool events
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

  /**
   * Execute an MCP tool call on the AICO-Bot client via WebSocket.
   * Follows the same promise pattern as executeHyperSpaceTool but for
   * general MCP tool routing through the WebSocket MCP Bridge.
   *
   * @param ws - WebSocket connection to the AICO-Bot client
   * @param sessionId - Session ID for routing
   * @param callId - Unique call ID for matching response
   * @param toolName - Tool name (e.g. 'browser_click')
   * @param args - Tool input arguments
   * @returns Promise resolving to CallToolResult
   */
  async executeAicoBotMcpTool(
    ws: WebSocket,
    sessionId: string,
    callId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<any> {
    const timeoutMs = 120000 // 2min timeout for browser operations

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMcpToolCalls.delete(callId)
        reject(new Error(`AICO-Bot MCP tool ${toolName} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pendingMcpToolCalls.set(callId, {
        resolve: (result: any) => {
          clearTimeout(timer)
          resolve(result)
        },
        reject: (error: Error) => {
          clearTimeout(timer)
          reject(error)
        }
      })

      this.sendMessage(ws, {
        type: 'mcp:tool:call',
        sessionId,
        data: {
          callId,
          toolName,
          arguments: args
        }
      })

      console.log(`[MCP Bridge] Sent tool call to AICO-Bot: ${toolName} (callId=${callId})`)
    })
  }

  /**
   * Start bidirectional heartbeat check.
   * Every 15s, checks all clients for liveness.
   * If a client hasn't sent any message in 30s, sends a ping to nudge it.
   * If a client hasn't responded in 90s, closes the connection.
   */
  private startHeartbeatCheck(): void {
    this.stopHeartbeatCheck()
    this.heartbeatCheckInterval = setInterval(() => {
      const now = Date.now()
      for (const [ws, client] of this.clients) {
        if (!client.authenticated || ws.readyState !== WebSocket.OPEN) continue
        const elapsed = now - client.lastClientActivityAt
        if (elapsed > RemoteAgentServer.HEARTBEAT_TIMEOUT_MS) {
          console.log(`[Heartbeat] Client timeout (${Math.round(elapsed / 1000)}s) — closing connection`)
          ws.close(4002, 'Heartbeat timeout — client unresponsive')
          continue
        }
        // Nudge inactive clients with a server ping
        if (elapsed > RemoteAgentServer.HEARTBEAT_INTERVAL_MS) {
          try {
            ws.send(JSON.stringify({ type: 'ping' }))
          } catch {
            // Send failed — socket likely dead, will be caught on next check
          }
        }
      }
    }, 15_000)
  }

  private stopHeartbeatCheck(): void {
    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval)
      this.heartbeatCheckInterval = undefined
    }
  }

  /**
   * Handle client disconnection — centralized cleanup for ws.on('close') and
   * heartbeat-triggered closes. Rejects all pending promises and releases
   * the session lock (if any). SDK sessions are kept alive for reconnection.
   */
  private handleClientDisconnect(ws: WebSocket): void {
    const client = this.clients.get(ws)
    if (client?.sessionId) {
      const sid = client.sessionId
      if (this.sessionProcessingLocks.has(sid)) {
        console.log(`[Disconnect] Client disconnected with active stream for ${sid}, aborting`)
        this.claudeManager.markAsInterrupted(sid)
        this.claudeManager.forceAbortStreamIterator(sid)
      }
      // Keep SDK session alive for reconnection (2h idle timeout in ClaudeManager)
      console.log(`[Disconnect] Keeping SDK session ${sid} alive for future reconnection`)
    }
    this.clients.delete(ws)

    // Reject all pending promises that were waiting on this WebSocket
    const disconnectError = new Error('WebSocket disconnected')
    for (const [callId, pending] of this.pendingMcpToolCalls) {
      pending.reject(disconnectError)
      this.pendingMcpToolCalls.delete(callId)
    }
    for (const [toolId, pending] of this.pendingHyperSpaceTools) {
      pending.reject(disconnectError)
      this.pendingHyperSpaceTools.delete(toolId)
    }
    for (const [questionId, pending] of this.pendingAskQuestions) {
      pending.reject(disconnectError)
      this.pendingAskQuestions.delete(questionId)
    }
  }

  close(): void {
    this.stopHeartbeatCheck()
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval)
    }
    this.clients.forEach((client, ws) => {
      if (client.sessionId) {
        this.claudeManager.closeSession(client.sessionId)
      }
      ws.close()
    })
    this.clients.clear()
    this.server.close()
    this.claudeManager.closeAllSessions()
    this.bgTaskManager.dispose()
    if (this.httpServer) {
      this.httpServer.close()
    }
    console.log('Server closed')
  }

  /**
   * Broadcast a message to all connected, authenticated clients.
   */
  private broadcastToAllClients(message: ServerMessage): void {
    for (const [ws, client] of this.clients) {
      if (client.authenticated && ws.readyState === WebSocket.OPEN) {
        this.sendMessage(ws, message)
      }
    }
  }
}
