import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKSessionOptions,
  type SDKSession
} from '@anthropic-ai/claude-agent-sdk'
import https from 'https'
import http from 'http'
import * as fs from 'fs'
import path from 'path'

// ============================================
// Types
// ============================================

/**
 * Simple interface for chat messages
 */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  maxTokens?: number
  system?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  maxThinkingTokens?: number
  workDir?: string  // Per-session working directory override
}

/**
 * Tool call from V2 Session
 */
export interface ToolCall {
  id: string
  name: string
  input: any
  status: 'started' | 'running' | 'delta' | 'result' | 'error'
  output?: any
  error?: string
}

/**
 * Terminal output from V2 Session
 */
export interface TerminalOutput {
  content: string
  type: 'stdout' | 'stderr'
}

/**
 * Thought event (for thinking, tool_use, etc.)
 */
export interface ThoughtEvent {
  id: string
  type: 'thinking' | 'tool_use' | 'tool_result' | 'text' | 'error' | 'result'
  content?: string
  timestamp: string
  toolName?: string
  toolInput?: Record<string, unknown>
  isStreaming?: boolean
  isReady?: boolean
  errorCode?: string
}

/**
 * Thought delta event (streaming updates)
 */
export interface ThoughtDeltaEvent {
  thoughtId: string
  delta?: string
  content?: string
  isComplete?: boolean
  toolInput?: Record<string, unknown>
  isReady?: boolean
  isToolInput?: boolean
  toolResult?: {
    output: string
    isError: boolean
    timestamp: string
  }
  isToolResult?: boolean
}

/**
 * MCP server status event
 */
export interface McpStatusEvent {
  servers: Array<{ name: string; status: string }>
}

/**
 * Compact boundary event (context compression)
 */
export interface CompactBoundaryEvent {
  trigger: 'manual' | 'auto'
  preTokens: number
}

/**
 * File operation result
 */
export interface FileOperation {
  type: 'read' | 'write' | 'delete' | 'list'
  path: string
  result?: any
  error?: string
}

/**
 * File info for directory listing
 */
export interface FileInfo {
  name: string
  isDirectory: boolean
  size: number
  modifiedTime: Date
}

/**
 * Session configuration for rebuild detection
 */
export interface SessionConfig {
  model?: string
  workDir?: string
  apiKey?: string
  baseUrl?: string
}

/**
 * V2 Session info with metadata (aligned with local session-manager.ts)
 */
export interface V2SessionInfo {
  session: SDKSession
  conversationId: string  // Use conversationId as key (aligned with local)
  createdAt: number
  lastUsedAt: number
  config: SessionConfig
  configGeneration: number  // For config change detection
}

/**
 * Active session state for in-flight request tracking
 */
export interface ActiveSessionState {
  conversationId: string
  abortController: AbortController
}

// ============================================
// Constants
// ============================================

/**
 * Default allowed tools that don't require user approval.
 */
const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  'Bash',
  'Skill',
  'WebSearch',
  'WebFetch',
  'Task'
]

/**
 * Session idle timeout in milliseconds (30 minutes, same as local)
 */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Cleanup interval in milliseconds (1 minute)
 */
const CLEANUP_INTERVAL_MS = 60 * 1000

// ============================================
// Helper Functions (aligned with local session-manager.ts)
// ============================================

/**
 * Check if a directory is a git repository
 */
function isGitRepo(dir: string): boolean {
  try {
    // Check if .git exists in the directory or any parent
    let currentDir = dir
    while (currentDir !== path.dirname(currentDir)) {
      if (fs.existsSync(path.join(currentDir, '.git'))) {
        return true
      }
      currentDir = path.dirname(currentDir)
    }
    // Check root level
    return fs.existsSync(path.join(currentDir, '.git'))
  } catch {
    return false
  }
}

/**
 * Build system prompt for Claude Code
 * Loads from synced file if available, otherwise uses fallback
 */
function buildSystemPrompt(workDir: string, modelInfo?: string): string {
  const today = new Date().toISOString().split('T')[0]
  const isGit = isGitRepo(workDir)

  // Try to load synced system prompt from file
  const systemPromptPath = path.join('/opt/claude-deployment', 'config', 'system-prompt.txt')

  try {
    if (fs.existsSync(systemPromptPath)) {
      console.log('[ClaudeManager] Loading system prompt from:', systemPromptPath)
      let systemPrompt = fs.readFileSync(systemPromptPath, 'utf-8')

      // Replace dynamic placeholders (uppercase to match system-prompt.ts template)
      // Must match all placeholders in SYSTEM_PROMPT_TEMPLATE from system-prompt.ts
      systemPrompt = systemPrompt
        .replace(/\$\{ALLOWED_TOOLS\}/g, 'Read, Write, Edit, Grep, Glob, Bash, Skill')
        .replace(/\$\{WORK_DIR\}/g, workDir)
        .replace(/\$\{IS_GIT_REPO\}/g, isGit ? 'Yes' : 'No')
        .replace(/\$\{PLATFORM\}/g, process.platform)
        .replace(/\$\{OS_VERSION\}/g, `${require('os').type()} ${require('os').release()}`)
        .replace(/\$\{TODAY\}/g, today)
        .replace(/\$\{MODEL_INFO\}/g, modelInfo ? `You are powered by ${modelInfo}.` : '')

      return systemPrompt
    } else {
      console.log('[ClaudeManager] System prompt file not found, using fallback')
    }
  } catch (error) {
    console.error('[ClaudeManager] Failed to load system prompt:', error)
  }

  // Fallback to simplified prompt (should not happen if sync worked)
  // This matches the structure of SYSTEM_PROMPT_TEMPLATE but is more concise
  const osVersion = `${require('os').type()} ${require('os').release()}`
  return `You are Halo, an AI assistant built with Claude Code. You help users with software engineering tasks.

IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming.

# Tone and style
- Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
- Your responses should be short and concise.
- When referencing specific functions or pieces of code include the pattern file_path:line_number.

# Tools and Permissions
You can use the following tools without requiring user approval: Read, Write, Edit, Grep, Glob, Bash, Skill

# Task Management
- Use TodoWrite tools to track progress on complex tasks
- Mark tasks as completed as soon as you're done

# Doing tasks
- The user will primarily request you to perform software engineering tasks
- ALWAYS use tools to gather information before answering
- Always read files before suggesting modifications
- Don't create files unless absolutely necessary
- Avoid over-engineering solutions
- Be careful not to introduce security vulnerabilities

<env>
Working directory: ${workDir}
Is directory a git repo: ${isGit ? 'Yes' : 'No'}
Platform: ${process.platform}
OS Version: ${osVersion}
Today's date: ${today}
</env>
${modelInfo ? `You are powered by ${modelInfo}.` : ''}
`
}

/**
 * Check if a V2 session's underlying process is still alive and ready.
 * (Aligned with local isSessionTransportReady)
 *
 * This checks the SDK's internal transport state, which is the Single Source of Truth
 * for process health.
 *
 * @param session - The V2 SDK session to check
 * @returns true if the session is ready for use, false if process is dead
 */
function isSessionTransportReady(session: SDKSession): boolean {
  try {
    // Access SDK internal state: session.query.transport
    const query = (session as any).query
    const transport = query?.transport

    if (!transport) {
      return false
    }

    // Check using isReady() method if available (preferred)
    if (typeof transport.isReady === 'function') {
      return transport.isReady()
    }

    // Fallback to ready property
    if (typeof transport.ready === 'boolean') {
      return transport.ready
    }

    return true
  } catch (e) {
    console.error('[ClaudeManager] Error checking session transport state:', e)
    return false
  }
}

/**
 * Register a listener for process exit events. (Aligned with local)
 *
 * This is event-driven cleanup (better than polling):
 * - When the CC subprocess dies, we get notified immediately
 * - We then call session.close() to release resources
 *
 * @param session - The V2 SDK session
 * @param conversationId - Conversation ID for logging and cleanup
 * @param onExit - Callback when process exits
 */
function registerProcessExitListener(
  session: SDKSession,
  conversationId: string,
  onExit: (conversationId: string) => void
): void {
  try {
    const transport = (session as any).query?.transport

    if (!transport) {
      console.warn(`[ClaudeManager][${conversationId}] Cannot register exit listener: no transport`)
      return
    }

    if (typeof transport.onExit === 'function') {
      transport.onExit((error: Error | undefined) => {
        const errorMsg = error ? `: ${error.message}` : ''
        console.log(`[ClaudeManager][${conversationId}] Process exited${errorMsg}`)
        onExit(conversationId)
      })
      console.log(`[ClaudeManager][${conversationId}] Process exit listener registered`)
    } else {
      console.warn(`[ClaudeManager][${conversationId}] SDK transport.onExit not available`)
    }
  } catch (e) {
    console.error(`[ClaudeManager][${conversationId}] Failed to register exit listener:`, e)
  }
}

/**
 * Check if session config requires rebuild
 */
function needsSessionRebuild(existing: V2SessionInfo, newConfig: SessionConfig): boolean {
  return (
    existing.config.model !== newConfig.model ||
    existing.config.workDir !== newConfig.workDir ||
    existing.config.apiKey !== newConfig.apiKey ||
    existing.config.baseUrl !== newConfig.baseUrl
  )
}

// ============================================
// Claude Manager (aligned with local session-manager.ts)
// ============================================

/**
 * Claude Manager using V2 Session for full Claude Code capabilities
 *
 * Features (aligned with local):
 * - Session persistence (conversation history)
 * - Session resumption
 * - Process reuse (fast responses)
 * - Process health check before reuse
 * - Event-driven cleanup (process exit listener)
 * - Idle timeout cleanup (30 minutes)
 * - Config change detection
 * - Active request tracking
 */
export class ClaudeManager {
  // Session maps (aligned with local)
  private sessions: Map<string, V2SessionInfo> = new Map()  // conversationId -> V2SessionInfo
  private activeSessions: Map<string, ActiveSessionState> = new Map()  // In-flight requests

  // Configuration
  private apiKey?: string
  private baseUrl?: string
  private pathToClaudeCodeExecutable?: string
  private workDir?: string
  private model?: string

  // Config generation for change detection
  private configGeneration = 0

  // Cleanup interval
  private cleanupIntervalId: NodeJS.Timeout | null = null

  constructor(
    apiKey?: string,
    baseUrl?: string,
    pathToClaudeCodeExecutable?: string,
    workDir?: string,
    model?: string
  ) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
    this.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable
    this.workDir = workDir || process.cwd()
    this.model = model

    // Start cleanup interval
    this.startCleanupInterval()
  }

  /**
   * Get current config for session creation
   */
  private getCurrentConfig(): SessionConfig {
    return {
      model: this.model,
      workDir: this.workDir,
      apiKey: this.apiKey,
      baseUrl: this.baseUrl
    }
  }

  /**
   * Increment config generation (call when config changes)
   */
  updateConfig(apiKey?: string, baseUrl?: string, workDir?: string, model?: string): void {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
    this.workDir = workDir || process.cwd()
    this.model = model
    this.configGeneration++
    console.log(`[ClaudeManager] Config updated, generation: ${this.configGeneration}`)
  }

  /**
   * Build SDK options for session creation
   * @param workDir - Optional override for working directory (per-session)
   */
  private buildSdkOptions(workDir?: string): any {
    const effectiveWorkDir = workDir || this.workDir || process.cwd()
    const options: any = {
      model: this.model || 'claude-sonnet-4-20250514',
      cwd: effectiveWorkDir,
      systemPrompt: buildSystemPrompt(effectiveWorkDir, this.model),
      permissionMode: 'bypassPermissions',
      extraArgs: {
        'dangerously-skip-permissions': null
      },
      allowedTools: [...DEFAULT_ALLOWED_TOOLS],
      includePartialMessages: true,
      maxTurns: 50,
    }

    if (this.pathToClaudeCodeExecutable) {
      options.pathToClaudeCodeExecutable = this.pathToClaudeCodeExecutable
    }

    // CRITICAL: Inherit process.env (especially PATH)
    // But first, strip AI SDK vars and CLAUDECODE to prevent nested session detection
    // NOTE: Don't delete ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL if already set from .env
    const cleanEnv = { ...process.env }
    delete cleanEnv.CLAUDECODE
    // Only delete ANTHROPIC vars if not already set (allow .env to override)
    if (!cleanEnv.ANTHROPIC_AUTH_TOKEN) {
      delete cleanEnv.ANTHROPIC_AUTH_TOKEN
    }
    if (!cleanEnv.ANTHROPIC_API_KEY) {
      delete cleanEnv.ANTHROPIC_API_KEY
    }
    if (!cleanEnv.ANTHROPIC_BASE_URL) {
      delete cleanEnv.ANTHROPIC_BASE_URL
    }

    options.env = cleanEnv
    if (this.apiKey) {
      options.env.ANTHROPIC_AUTH_TOKEN = this.apiKey
    }
    if (this.baseUrl) {
      options.env.ANTHROPIC_BASE_URL = this.baseUrl
    }
    // Important env vars
    options.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    options.env.DISABLE_AUTOUPDATER = '1'
    options.env.API_TIMEOUT_MS = '3000000'
    options.env.DISABLE_TELEMETRY = '1'
    options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'

    // CRITICAL: IS_SANDBOX=1 is required for bypass-permissions mode when running as root
    // This must be passed to the Claude CLI subprocess, not just the remote-agent-proxy process
    options.env.IS_SANDBOX = '1'

    return options
  }

  /**
   * Clean up a single session (aligned with local cleanupSession)
   */
  private cleanupSession(conversationId: string, reason: string): void {
    const info = this.sessions.get(conversationId)
    if (!info) return

    console.log(`[ClaudeManager][${conversationId}] Cleaning up session: ${reason}`)

    try {
      info.session.close()
    } catch (e) {
      // Ignore close errors
    }

    this.sessions.delete(conversationId)
  }

  /**
   * Start the session cleanup interval (aligned with local)
   */
  private startCleanupInterval(): void {
    if (this.cleanupIntervalId) return

    this.cleanupIntervalId = setInterval(() => {
      const now = Date.now()
      for (const [convId, info] of Array.from(this.sessions.entries())) {
        // Check 1: Clean up sessions with dead processes
        if (!isSessionTransportReady(info.session)) {
          this.cleanupSession(convId, 'process not ready (polling)')
          continue
        }

        // Check 2: Clean up idle sessions (skip if request in flight)
        if (this.activeSessions.has(convId)) {
          info.lastUsedAt = now
          continue
        }

        if (now - info.lastUsedAt > SESSION_IDLE_TIMEOUT_MS) {
          this.cleanupSession(convId, 'idle timeout (30 min)')
        }
      }
    }, CLEANUP_INTERVAL_MS)
  }

  /**
   * Stop the cleanup interval
   */
  private stopCleanupInterval(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId)
      this.cleanupIntervalId = null
    }
  }

  /**
   * Get or create a V2 session (aligned with local getOrCreateV2Session)
   *
   * Key features:
   * - Process health check before reuse
   * - Config change detection
   * - Active request tracking
   * - Per-session workDir support
   * - Session resumption via resume parameter (SDK patch required)
   *
   * @param conversationId - Use conversationId as key (aligned with local)
   * @param workDir - Optional working directory override for this session
   * @param resumeSessionId - Optional session ID to resume from (for conversation history)
   * @param maxThinkingTokens - Optional max thinking tokens for this session
   */
  async getOrCreateSession(
    conversationId: string,
    workDir?: string,
    resumeSessionId?: string,
    maxThinkingTokens?: number
  ): Promise<SDKSession> {
    const effectiveWorkDir = workDir || this.workDir || process.cwd()
    const existing = this.sessions.get(conversationId)

    if (existing) {
      // CRITICAL: Check if workDir changed - if so, need to recreate session
      if (existing.config.workDir !== effectiveWorkDir) {
        console.log(`[ClaudeManager][${conversationId}] WorkDir changed: ${existing.config.workDir} -> ${effectiveWorkDir}, recreating...`)
        this.cleanupSession(conversationId, 'workDir changed')
        // Fall through to create new session
      } else
      // CRITICAL: Check if process is still alive before reusing
      if (!isSessionTransportReady(existing.session)) {
        console.log(`[ClaudeManager][${conversationId}] Session transport not ready, recreating...`)
        this.cleanupSession(conversationId, 'process not ready')
        // Fall through to create new session
      } else {
        // Check if config has changed
        const currentConfig = this.getCurrentConfig()
        const needsRebuild = needsSessionRebuild(existing, currentConfig)
        const configChanged = existing.configGeneration !== this.configGeneration

        // Debug: Log config comparison
        if (needsRebuild || configChanged) {
          console.log(`[ClaudeManager][${conversationId}] Config check - needsRebuild: ${needsRebuild}, configChanged: ${configChanged}`)
          console.log(`[ClaudeManager][${conversationId}] Existing config:`, JSON.stringify(existing.config))
          console.log(`[ClaudeManager][${conversationId}] Current config:`, JSON.stringify(currentConfig))
          console.log(`[ClaudeManager][${conversationId}] Config generations - existing: ${existing.configGeneration}, current: ${this.configGeneration}`)
        }

        if (needsRebuild || configChanged) {
          // If request in flight, defer rebuild
          if (this.activeSessions.has(conversationId)) {
            console.log(`[ClaudeManager][${conversationId}] Config changed but request in flight, deferring rebuild`)
            existing.lastUsedAt = Date.now()
            return existing.session
          }

          console.log(`[ClaudeManager][${conversationId}] Config changed, rebuilding session`)
          this.cleanupSession(conversationId, 'config changed')
          // Fall through to create new session
        } else {
          // Session is healthy and config matches, reuse it
          console.log(`[ClaudeManager][${conversationId}] Reusing existing V2 session`)
          existing.lastUsedAt = Date.now()
          return existing.session
        }
      }
    }

    // Create new session
    console.log(`[ClaudeManager][${conversationId}] Creating new V2 session with workDir=${effectiveWorkDir}...`)
    const options = this.buildSdkOptions(effectiveWorkDir)

    // CRITICAL: Requires SDK patch for resume and maxThinkingTokens support
    // Native SDK V2 Session doesn't support these parameters
    if (resumeSessionId) {
      options.resume = resumeSessionId
      console.log(`[ClaudeManager][${conversationId}] Resuming session: ${resumeSessionId}`)
    }
    if (maxThinkingTokens) {
      options.maxThinkingTokens = maxThinkingTokens
      console.log(`[ClaudeManager][${conversationId}] Max thinking tokens: ${maxThinkingTokens}`)
    }

    const startTime = Date.now()

    console.log(`[ClaudeManager] Creating V2 session with options:`, {
      model: options.model,
      cwd: options.cwd,
      hasAuthToken: !!this.apiKey,
      baseUrl: this.baseUrl,
      permissionMode: options.permissionMode,
      allowedTools: options.allowedTools?.length,
      resume: !!resumeSessionId,
      maxThinkingTokens: maxThinkingTokens
    })

    const session = unstable_v2_createSession(options as any) as unknown as SDKSession
    const pid = (session as any).pid
    console.log(`[ClaudeManager][${conversationId}] V2 session created in ${Date.now() - startTime}ms, PID: ${pid ?? 'unavailable'}`)

    // Register process exit listener for immediate cleanup
    registerProcessExitListener(session, conversationId, (id) => {
      this.cleanupSession(id, 'process exited')
    })

    // Store session with metadata (use effectiveWorkDir in config)
    this.sessions.set(conversationId, {
      session,
      conversationId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      config: { ...this.getCurrentConfig(), workDir: effectiveWorkDir },
      configGeneration: this.configGeneration
    })

    return session
  }

  /**
   * Legacy method for backward compatibility
   * @deprecated Use getOrCreateSession instead
   */
  getSession(sessionId: string): SDKSession {
    // Synchronous wrapper for backward compatibility
    let session = this.sessions.get(sessionId)?.session
    if (!session) {
      // Create synchronously (for legacy compatibility)
      const options = this.buildSdkOptions()
      session = unstable_v2_createSession(options as any) as unknown as SDKSession

      registerProcessExitListener(session, sessionId, (id) => {
        this.cleanupSession(id, 'process exited')
      })

      this.sessions.set(sessionId, {
        session,
        conversationId: sessionId,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        config: this.getCurrentConfig(),
        configGeneration: this.configGeneration
      })
    }
    return session
  }

  /**
   * Register an active session (for in-flight request tracking)
   */
  registerActiveSession(conversationId: string, abortController: AbortController): void {
    this.activeSessions.set(conversationId, {
      conversationId,
      abortController
    })
  }

  /**
   * Unregister an active session
   */
  unregisterActiveSession(conversationId: string): void {
    this.activeSessions.delete(conversationId)
  }

  /**
   * Resume an existing V2 session by session ID
   */
  async resumeSession(sessionId: string): Promise<SDKSession> {
    if (!this.sessions.has(sessionId)) {
      const options = this.buildSdkOptions()
      const session = await unstable_v2_resumeSession(sessionId, options as any)

      registerProcessExitListener(session, sessionId, (id) => {
        this.cleanupSession(id, 'process exited')
      })

      this.sessions.set(sessionId, {
        session,
        conversationId: sessionId,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        config: this.getCurrentConfig(),
        configGeneration: this.configGeneration
      })
      console.log(`[ClaudeManager] Resumed V2 session: ${sessionId}`)
    }
    return this.sessions.get(sessionId)!.session
  }

  /**
   * Stream chat messages using V2 session
   *
   * IMPORTANT: Only sends the LAST user message to the V2 session.
   * The V2 session maintains its own conversation history internally via SDK patch resume.
   *
   * @param sessionId - Session/conversation ID
   * @param messages - Chat messages (only last message is sent)
   * @param options - Chat options including workDir for per-session directory
   * @param resumeSessionId - Optional SDK session ID to resume from (for conversation history)
   * @param onToolCall - Callback for tool call events
   * @param onTerminalOutput - Callback for terminal output events
   * @param onThought - Callback for thought events (thinking, tool_use start)
   * @param onThoughtDelta - Callback for thought delta events (streaming updates)
   * @param onMcpStatus - Callback for MCP server status events
   * @param onCompact - Callback for compact boundary events (context compression)
   */
  async *streamChat(
    sessionId: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
    resumeSessionId?: string,
    onToolCall?: (tool: ToolCall) => void,
    onTerminalOutput?: (output: TerminalOutput) => void,
    onThought?: (thought: ThoughtEvent) => void,
    onThoughtDelta?: (delta: ThoughtDeltaEvent) => void,
    onMcpStatus?: (data: McpStatusEvent) => void,
    onCompact?: (data: CompactBoundaryEvent) => void
  ): AsyncGenerator<{ type: string; data?: any }> {
    // Use async session creation with workDir from options
    console.log(`[ClaudeManager] streamChat called with options.workDir=${options.workDir || 'undefined'}, this.workDir=${this.workDir || 'undefined'}`)
    console.log(`[ClaudeManager] streamChat called with resumeSessionId=${resumeSessionId || 'undefined'}, maxThinkingTokens=${options.maxThinkingTokens || 'undefined'}`)
    const session = await this.getOrCreateSession(sessionId, options.workDir, resumeSessionId, options.maxThinkingTokens)

    // [PATCHED] Set thinking tokens dynamically on reused session
    // This is critical: when session is reused, the maxThinkingTokens from session creation
    // may not reflect the current request's needs. We must update it dynamically.
    // Aligned with local send-message.ts line 246-249
    try {
      if ((session as any).setMaxThinkingTokens) {
        // Always call setMaxThinkingTokens, pass null to disable (aligned with local)
        const thinkingTokens = options.maxThinkingTokens ?? null
        await (session as any).setMaxThinkingTokens(thinkingTokens)
        console.log(`[ClaudeManager][${sessionId}] Thinking mode: ${thinkingTokens ? `ON (${thinkingTokens} tokens)` : 'OFF'}`)
      } else {
        console.warn(`[ClaudeManager][${sessionId}] setMaxThinkingTokens not available - SDK patch may not be applied`)
      }
    } catch (e) {
      console.error(`[ClaudeManager][${sessionId}] Failed to set thinking tokens:`, e)
    }

    // Register as active session for in-flight tracking
    const abortController = new AbortController()
    this.registerActiveSession(sessionId, abortController)

    // Streaming block state - track active blocks by index for delta/stop correlation
    // Key: block index, Value: { type, thoughtId, content/partialJson }
    const streamingBlocks = new Map<number, {
      type: 'thinking' | 'tool_use'
      thoughtId: string
      content: string  // For thinking: accumulated thinking text, for tool_use: accumulated partial JSON
      toolName?: string
      toolId?: string
    }>()

    // Tool ID to Thought ID mapping - for merging tool_result into tool_use
    const toolIdToThoughtId = new Map<string, string>()

    // Counter for generating unique thought IDs
    let counter = 0

    // Capture SDK session_id for session resumption
    let capturedSessionId: string | undefined

    // Track if any stream_event was received (for fallback handling of thinking/tool_use blocks)
    let hasStreamEvent = false

    try {
      // CRITICAL: Only send the LAST user message!
      const lastMessage = messages[messages.length - 1]
      if (!lastMessage || lastMessage.role !== 'user') {
        throw new Error('Last message must be from user')
      }

      console.log(`[ClaudeManager] Sending last user message: ${lastMessage.content.substring(0, 50)}...`)
      await session.send(lastMessage.content)

      console.log(`[ClaudeManager] Starting stream for session ${sessionId}...`)
      let eventCount = 0
      let textCount = 0

      for await (const event of session.stream()) {
        eventCount++
        const evt = event as any

        // Log ALL events for debugging (first 50 events)
        if (eventCount <= 50) {
          console.log(`[ClaudeManager] Event ${eventCount}: type=${evt.type}`, JSON.stringify(evt).substring(0, 500))
        }

        // ========== Handle stream_event for token-level streaming ==========
        if (evt.type === 'stream_event') {
          const streamEvent = evt.event
          if (!streamEvent) continue

          // Mark that we received stream_event (for fallback handling below)
          hasStreamEvent = true

          // ========== Text block start signal ==========
          // Send signal when text block starts (aligned with local stream-processor.ts)
          if (streamEvent.type === 'content_block_start' && streamEvent.content_block?.type === 'text') {
            yield { type: 'text_block_start', data: {} }
          }

          // ========== Thinking block streaming ==========
          // Thinking block started - send empty thought immediately
          if (streamEvent.type === 'content_block_start' && streamEvent.content_block?.type === 'thinking') {
            const blockIndex = streamEvent.index ?? 0
            const thoughtId = `thought-thinking-${sessionId}-${blockIndex}-${counter++}`

            // Track this block for delta correlation
            streamingBlocks.set(blockIndex, {
              type: 'thinking',
              thoughtId,
              content: ''
            })

            // Create and send streaming thought immediately
            const thought: ThoughtEvent = {
              id: thoughtId,
              type: 'thinking',
              content: '',
              timestamp: new Date().toISOString(),
              isStreaming: true
            }

            onThought?.(thought)
            console.log(`[ClaudeManager] Thinking block started: ${thoughtId}`)
            continue
          }

          // Thinking delta - append to thought content
          if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'thinking_delta') {
            const blockIndex = streamEvent.index ?? 0
            const blockState = streamingBlocks.get(blockIndex)

            if (blockState && blockState.type === 'thinking') {
              const delta = streamEvent.delta.thinking || ''
              blockState.content += delta

              // Send delta to renderer for incremental update
              onThoughtDelta?.({
                thoughtId: blockState.thoughtId,
                delta,
                content: blockState.content  // Also send full content for fallback
              })
            }
            continue
          }

          // ========== Tool use block streaming ==========
          // Tool use block started - send thought with tool name immediately
          if (streamEvent.type === 'content_block_start' && streamEvent.content_block?.type === 'tool_use') {
            const blockIndex = streamEvent.index ?? 0
            const toolId = streamEvent.content_block.id || `tool-${Date.now()}`
            const toolName = streamEvent.content_block.name || 'Unknown'
            const thoughtId = `thought-tool-${Date.now()}-${blockIndex}`

            // Track this block for delta correlation
            streamingBlocks.set(blockIndex, {
              type: 'tool_use',
              thoughtId,
              content: '',  // Will accumulate partial JSON
              toolName,
              toolId
            })

            // Create and send streaming tool thought immediately
            const thought: ThoughtEvent = {
              id: thoughtId,
              type: 'tool_use',
              content: '',
              timestamp: new Date().toISOString(),
              toolName,
              toolInput: {},  // Empty initially, will be populated on stop
              isStreaming: true,
              isReady: false  // Params not complete yet
            }

            onThought?.(thought)
            console.log(`[ClaudeManager] Tool use block started: ${toolName} (${thoughtId})`)
            continue
          }

          // Tool use input JSON delta - accumulate partial JSON
          if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'input_json_delta') {
            const blockIndex = streamEvent.index ?? 0
            const blockState = streamingBlocks.get(blockIndex)

            if (blockState && blockState.type === 'tool_use') {
              const partialJson = streamEvent.delta.partial_json || ''
              blockState.content += partialJson

              // Send delta to renderer (for progress indication)
              onThoughtDelta?.({
                thoughtId: blockState.thoughtId,
                delta: partialJson,
                isToolInput: true  // Flag: this is tool input JSON
              })
            }
            continue
          }

          // ========== Block stop handling ==========
          // content_block_stop - finalize streaming blocks
          if (streamEvent.type === 'content_block_stop') {
            const blockIndex = streamEvent.index ?? 0
            const blockState = streamingBlocks.get(blockIndex)

            if (blockState) {
              if (blockState.type === 'thinking') {
                // Thinking block complete - send final state
                onThoughtDelta?.({
                  thoughtId: blockState.thoughtId,
                  content: blockState.content,
                  isComplete: true  // Signal: thinking is complete
                })

                console.log(`[ClaudeManager] Thinking block complete, length: ${blockState.content.length}`)
              } else if (blockState.type === 'tool_use') {
                // Tool use block complete - parse JSON and send final state
                let toolInput: Record<string, unknown> = {}
                try {
                  if (blockState.content) {
                    toolInput = JSON.parse(blockState.content)
                  }
                } catch (e) {
                  console.error(`[ClaudeManager] Failed to parse tool input JSON:`, e)
                }

                // Record mapping for merging tool_result later
                if (blockState.toolId) {
                  toolIdToThoughtId.set(blockState.toolId, blockState.thoughtId)
                }

                // Send complete signal with parsed input
                onThoughtDelta?.({
                  thoughtId: blockState.thoughtId,
                  toolInput,
                  isComplete: true,  // Signal: tool params are complete
                  isReady: true,     // Tool is ready for execution
                  isToolInput: true  // Flag: this is tool input completion
                })

                // Send tool-call event for tool approval/tracking
                onToolCall?.({
                  id: blockState.toolId || blockState.thoughtId,
                  name: blockState.toolName || '',
                  status: 'running',  // Aligned with local space
                  input: toolInput
                })

                console.log(`[ClaudeManager] Tool use block complete [${blockState.toolName}], input: ${JSON.stringify(toolInput).substring(0, 100)}`)
              }

              // Clean up tracking state
              streamingBlocks.delete(blockIndex)
            }
            continue
          }

          // ========== Text delta handling ==========
          if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
            const text = streamEvent.delta.text || ''
            if (text) {
              textCount++
              if (textCount <= 5) {
                console.log(`[ClaudeManager] Text delta: ${text.substring(0, 50)}...`)
              }
              yield { type: 'text', data: { text } }
            }
            continue
          }

          // Skip other stream_event types - they don't need yield
          continue
        }

        // ========== Handle non-stream events (assistant, result, etc.) ==========

        // System events - MCP status, session_id, and compact boundary
        if (evt.type === 'system') {
          const subtype = evt.subtype as string | undefined

          // Capture session_id for session resumption
          const sessionIdFromMsg = (evt as any).session_id || (evt as any).message?.session_id
          if (sessionIdFromMsg && !capturedSessionId) {
            capturedSessionId = sessionIdFromMsg as string
            console.log(`[ClaudeManager] Captured SDK session_id: ${capturedSessionId}`)
            // Yield session_id to caller for persistence
            yield { type: 'session_id', data: { sessionId: capturedSessionId } }
          }

          // Handle compact_boundary - context compression notification
          if (subtype === 'compact_boundary') {
            const compactMetadata = evt.compact_metadata as { trigger: 'manual' | 'auto'; pre_tokens: number } | undefined
            if (compactMetadata) {
              onCompact?.({
                trigger: compactMetadata.trigger,
                preTokens: compactMetadata.pre_tokens
              })
              console.log(`[ClaudeManager] Compact boundary: trigger=${compactMetadata.trigger}, pre_tokens=${compactMetadata.pre_tokens}`)
            }
          }

          // Extract MCP server status from system init message
          const mcpServers = evt.mcp_servers as Array<{ name: string; status: string }> | undefined
          if (mcpServers && mcpServers.length > 0) {
            onMcpStatus?.({ servers: mcpServers })
            console.log(`[ClaudeManager] MCP servers: ${JSON.stringify(mcpServers)}`)
          }

          continue
        }

        // Terminal output events
        if (evt.type === 'terminal_output') {
          onTerminalOutput?.({
            content: evt.content,
            type: evt.stream_type || 'stdout'
          })
          yield { type: 'terminal', data: evt }
          continue
        }

        // Assistant events - logging only (thinking/tool_use handled by stream_event)
        // Fallback: if no stream_event was received, process thinking/tool_use blocks here
        if (evt.type === 'assistant') {
          const message = evt.message
          console.log(`[ClaudeManager] Assistant event - message.content types:`, message?.content?.map((b: any) => b.type))

          // Fallback: process thinking/tool_use blocks if no stream_event was received
          // This happens when SDK doesn't send stream_event (e.g., session resume mode)
          if (!hasStreamEvent && message?.content && Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block.type === 'thinking' && block.thinking) {
                const thought: ThoughtEvent = {
                  id: `thought-thinking-${sessionId}-${counter++}`,
                  type: 'thinking',
                  content: block.thinking,
                  timestamp: new Date().toISOString(),
                  isStreaming: false
                }
                onThought?.(thought)
                console.log(`[ClaudeManager] [FALLBACK] Thinking block from assistant message: ${(thought.content || '').substring(0, 100)}...`)
              } else if (block.type === 'tool_use' && block.id && block.name) {
                const thoughtId = `thought-tool-${Date.now()}-${counter++}`
                const toolId = block.id
                toolIdToThoughtId.set(toolId, thoughtId)

                const thought: ThoughtEvent = {
                  id: thoughtId,
                  type: 'tool_use',
                  content: '',
                  timestamp: new Date().toISOString(),
                  toolName: block.name,
                  toolInput: block.input || {},
                  isStreaming: false,
                  isReady: true
                }
                onThought?.(thought)
                console.log(`[ClaudeManager] [FALLBACK] Tool use block from assistant message: ${block.name}`)
              }
            }
          }
          // Note: tool_result blocks are NOT in assistant messages - they come in user messages
          continue
        }

        // User events - handle tool_result merging (SDK returns tool_result in user messages)
        if (evt.type === 'user') {
          const message = evt.message
          console.log(`[ClaudeManager] User event - checking for tool_result`)
          if (message?.content && Array.isArray(message.content)) {
            for (const block of message.content) {
              // Handle tool_result blocks - merge into corresponding tool_use
              if (block.type === 'tool_result') {
                const toolUseId = block.tool_use_id
                const toolUseThoughtId = toolIdToThoughtId.get(toolUseId)

                console.log(`[ClaudeManager] Tool result found: tool_use_id=${toolUseId}, thoughtId=${toolUseThoughtId || 'not found'}`)

                if (toolUseThoughtId) {
                  // Found corresponding tool_use - merge result into it
                  const resultContent = typeof block.content === 'string'
                    ? block.content
                    : JSON.stringify(block.content)
                  const toolResult = {
                    output: resultContent || '',
                    isError: block.is_error || false,
                    timestamp: new Date().toISOString()
                  }

                  // Send thought-delta to merge result into tool_use on frontend
                  onThoughtDelta?.({
                    thoughtId: toolUseThoughtId,
                    toolResult,
                    isToolResult: true  // Flag: this is a tool result merge
                  })

                  // Also send tool result event
                  onToolCall?.({
                    id: toolUseId,
                    name: '',
                    input: {},
                    status: 'result',
                    output: resultContent
                  })

                  console.log(`[ClaudeManager] Tool result merged into thought ${toolUseThoughtId}`)
                } else {
                  // No mapping found - this can happen if tool_use wasn't streamed
                  console.log(`[ClaudeManager] Tool result no mapping: ${toolUseId}`)
                }
              }
            }
          }
          continue
        }

        // Result events
        if (evt.type === 'result') {
          console.log(`[ClaudeManager] Result event: is_error=${evt.is_error}, result=${evt.result?.substring(0, 100)}`)

          // Capture session_id from result event if not already captured
          if (!capturedSessionId) {
            const sessionIdFromMsg = (evt as any).session_id
            if (sessionIdFromMsg) {
              capturedSessionId = sessionIdFromMsg as string
              console.log(`[ClaudeManager] Captured SDK session_id from result: ${capturedSessionId}`)
              yield { type: 'session_id', data: { sessionId: capturedSessionId } }
            }
          }

          if (evt.result && textCount === 0) {
            yield { type: 'text', data: { text: evt.result } }
          }
          break
        }

        if (evt.type === 'error') {
          const errorMsg = evt.error?.message || 'Unknown error'
          throw new Error(`Claude V2 Session error: ${errorMsg}`)
        }

        if (evt.type === 'message_stop') {
          break
        }
      }
    } catch (error) {
      console.error('[ClaudeManager] Stream chat error:', error)
      throw new Error(`Claude stream error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // Always unregister active session
      this.unregisterActiveSession(sessionId)
    }
  }

  /**
   * Send a chat message without streaming
   */
  async chat(sessionId: string, messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const session = await this.getOrCreateSession(sessionId, options.workDir)

    const abortController = new AbortController()
    this.registerActiveSession(sessionId, abortController)

    try {
      const lastMessage = messages[messages.length - 1]
      await session.send(lastMessage.content)

      let fullResponse = ''
      for await (const event of session.stream()) {
        const evt = event as any

        if (evt.type === 'content_block_start' || evt.type === 'content_block_delta') {
          if (evt.content_block?.type === 'text') {
            if (evt.content_block?.delta?.type === 'text_delta') {
              fullResponse += evt.content_block.delta.text || ''
            } else if (evt.content_block?.text) {
              fullResponse += evt.content_block.text || ''
            }
          }
        } else if (evt.type === 'message_stop') {
          break
        }
      }

      return fullResponse
    } catch (error) {
      console.error('[ClaudeManager] Chat error:', error)
      throw new Error(`Claude chat error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.unregisterActiveSession(sessionId)
    }
  }

  /**
   * Close a V2 session
   */
  closeSession(conversationId: string): void {
    this.cleanupSession(conversationId, 'explicit close')
  }

  /**
   * Close all sessions
   */
  closeAllSessions(): void {
    const count = this.sessions.size
    console.log(`[ClaudeManager] Closing all ${count} V2 sessions`)

    for (const convId of Array.from(this.sessions.keys())) {
      this.cleanupSession(convId, 'app shutdown')
    }

    this.stopCleanupInterval()
  }

  /**
   * Invalidate all sessions (called when config changes)
   */
  invalidateAllSessions(): void {
    const count = this.sessions.size
    if (count === 0) {
      console.log('[ClaudeManager] No active sessions to invalidate')
      return
    }

    console.log(`[ClaudeManager] Invalidating ${count} sessions due to config change`)

    for (const convId of Array.from(this.sessions.keys())) {
      // If request in flight, defer cleanup
      if (this.activeSessions.has(convId)) {
        console.log(`[ClaudeManager] Deferring session close until idle: ${convId}`)
        continue
      }
      this.cleanupSession(convId, 'config change')
    }
  }

  /**
   * Get session statistics
   */
  getStats(): { totalSessions: number; activeRequests: number } {
    return {
      totalSessions: this.sessions.size,
      activeRequests: this.activeSessions.size
    }
  }

  // ============================================
  // File Operations (using V2 Session tools)
  // ============================================

  /**
   * List files in directory using V2 Session
   */
  async listFiles(sessionId: string, path: string): Promise<FileInfo[]> {
    const session = await this.getOrCreateSession(sessionId)

    try {
      const command = `ls -la "${path.replace(/"/g, '\\"')}"`
      await session.send(command)

      let output = ''
      for await (const event of session.stream()) {
        const evt = event as any
        if (evt.type === 'terminal_output') {
          output += evt.content
        } else if (evt.type === 'message_stop') {
          break
        }
      }

      const lines = output.trim().split('\n').slice(1)
      return lines.map(line => {
        const parts = line.trim().split(/\s+/)
        const name = parts[parts.length - 1]
        const isDir = line.startsWith('d')
        return {
          name,
          isDirectory: isDir,
          size: parseInt(parts[4] || '0', 10),
          modifiedTime: new Date()
        }
      }).filter(f => f.name !== '.' && f.name !== '..')
    } catch (error) {
      throw new Error(`File listing failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Read file using V2 Session
   */
  async readFile(sessionId: string, path: string): Promise<string> {
    const session = await this.getOrCreateSession(sessionId)

    try {
      const command = `cat "${path.replace(/"/g, '\\"')}"`
      await session.send(command)

      let output = ''
      for await (const event of session.stream()) {
        const evt = event as any
        if (evt.type === 'terminal_output') {
          output += evt.content
        } else if (evt.type === 'message_stop') {
          break
        }
      }

      return output
    } catch (error) {
      throw new Error(`File read failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Write file using V2 Session
   */
  async writeFile(sessionId: string, path: string, content: string): Promise<void> {
    const session = await this.getOrCreateSession(sessionId)

    try {
      const base64Content = Buffer.from(content).toString('base64')
      const command = `echo "${base64Content}" | base64 -d > "${path.replace(/"/g, '\\"')}"`
      await session.send(command)

      for await (const event of session.stream()) {
        const evt = event as any
        if (evt.type === 'message_stop') {
          break
        }
      }
    } catch (error) {
      throw new Error(`File write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Delete file using V2 Session
   */
  async deleteFile(sessionId: string, path: string): Promise<void> {
    const session = await this.getOrCreateSession(sessionId)

    try {
      const command = `rm -f "${path.replace(/"/g, '\\"')}"`
      await session.send(command)

      for await (const event of session.stream()) {
        const evt = event as any
        if (evt.type === 'message_stop') {
          break
        }
      }
    } catch (error) {
      throw new Error(`File delete failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Execute command via V2 Session
   */
  async executeCommand(sessionId: string, command: string): Promise<string> {
    const session = await this.getOrCreateSession(sessionId)

    try {
      await session.send(command)

      let output = ''
      for await (const event of session.stream()) {
        const evt = event as any
        if (evt.type === 'terminal_output') {
          output += evt.content
        } else if (evt.type === 'message_stop') {
          break
        }
      }

      return output
    } catch (error) {
      throw new Error(`Command execution failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
