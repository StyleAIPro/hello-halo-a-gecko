import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKSessionOptions,
  type SDKSession
} from '@anthropic-ai/claude-agent-sdk'
import https from 'https'
import http from 'http'

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
}

/**
 * Tool call from V2 Session
 */
export interface ToolCall {
  id: string
  name: string
  input: any
  status: 'started' | 'delta' | 'result' | 'error'
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
 * Build system prompt for Claude Code
 */
function buildSystemPrompt(workDir: string, modelInfo?: string): string {
  const today = new Date().toISOString().split('T')[0]
  return `You are Claude Code (via Halo Remote Agent), Anthropic's official CLI for Claude. You are an interactive agent running on a remote server that helps users with software engineering tasks.

IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming.

# Tone and style
- Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
- Your responses should be short and concise.
- When referencing specific functions or pieces of code include the pattern file_path:line_number to allow the user to easily navigate to the source code location.
- Do not use a colon before tool calls.

# Tools and Permissions
You MUST use tools to answer questions. NEVER answer from memory or assumptions.

Available tools: Read, Write, Edit, Grep, Glob, Bash, WebSearch, WebFetch, Task

CRITICAL - When to use tools:
- "What files are in this directory?" / "当前目录有什么？" / "目录里有什么" → MUST use Bash (ls -la) or Glob tool
- "What's in file X?" / "读取某文件" / "看看某文件" → MUST use Read tool
- "Run command X" / "执行某命令" → MUST use Bash tool
- "Find files matching X" / "查找文件" → MUST use Glob or Grep tool
- "Edit/Modify file X" / "修改文件" → MUST use Edit tool
- Any question about files, directories, or code → MUST use appropriate tool FIRST

Your current working directory is: ${workDir}
Model: ${modelInfo || 'unknown'}
Date: ${today}

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
`
}

/**
 * Claude Manager using V2 Session for full Claude Code capabilities
 * Supports:
 * - Session persistence (conversation history)
 * - Session resumption
 * - Process reuse (fast responses)
 */
export class ClaudeManager {
  private sessions: Map<string, SDKSession> = new Map()
  private apiKey?: string
  private baseUrl?: string
  private pathToClaudeCodeExecutable?: string
  private workDir?: string
  private model?: string

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
    this.workDir = workDir || process.cwd()  // Default to current directory
    this.model = model
  }

  /**
   * Get or create a V2 session for a given session ID
   */
  getSession(sessionId: string): SDKSession {
    if (!this.sessions.has(sessionId)) {
      // Build full SDK options (use 'as any' to bypass incomplete type definitions)
      const options: any = {
        model: this.model || 'claude-sonnet-4-20250514',
        // CRITICAL: Set working directory - this is where tools execute
        cwd: this.workDir || process.cwd(),
        // CRITICAL: System prompt defines Claude Code identity and capabilities
        systemPrompt: buildSystemPrompt(this.workDir || process.cwd(), this.model),
        // CRITICAL: Permission mode - use 'acceptEdits' for root user
        // Note: 'bypassPermissions' is blocked for root user for security
        permissionMode: 'acceptEdits',
        // CRITICAL: Allowed tools - defines what Claude can do
        allowedTools: [...DEFAULT_ALLOWED_TOOLS],
        // Enable token-level streaming
        includePartialMessages: true,
        // Max turns for tool calls
        maxTurns: 50,
      }

      // Add Claude Code path if provided
      if (this.pathToClaudeCodeExecutable) {
        options.pathToClaudeCodeExecutable = this.pathToClaudeCodeExecutable
      }

      // CRITICAL: Inherit process.env (especially PATH) so subprocess can find executables
      // Without this, Bash tool cannot find ls, cat, etc.
      options.env = { ...process.env }
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

      console.log(`[ClaudeManager] Creating V2 session with options:`, {
        model: options.model,
        cwd: options.cwd,
        hasAuthToken: !!this.apiKey,
        baseUrl: this.baseUrl,
        permissionMode: options.permissionMode,
        allowedTools: options.allowedTools?.length
      })

      // Use 'as any' to bypass type check - SDK supports more params than types define
      const session = unstable_v2_createSession(options as any)
      this.sessions.set(sessionId, session)
      console.log(`[ClaudeManager] Created new V2 session: ${sessionId}`)
    }
    return this.sessions.get(sessionId)!
  }

  /**
   * Resume an existing V2 session by session ID
   */
  async resumeSession(sessionId: string): Promise<SDKSession> {
    if (!this.sessions.has(sessionId)) {
      // Build full SDK options (use 'as any' to bypass incomplete type definitions)
      const options: any = {
        model: this.model || 'claude-sonnet-4-20250514',
        // CRITICAL: Set working directory - this is where tools execute
        cwd: this.workDir || process.cwd(),
        // CRITICAL: System prompt defines Claude Code identity and capabilities
        systemPrompt: buildSystemPrompt(this.workDir || process.cwd(), this.model),
        // CRITICAL: Permission mode - use 'acceptEdits' for root user
        // Note: 'bypassPermissions' is blocked for root user for security
        permissionMode: 'acceptEdits',
        // CRITICAL: Allowed tools - defines what Claude can do
        allowedTools: [...DEFAULT_ALLOWED_TOOLS],
        // Enable token-level streaming
        includePartialMessages: true,
        // Max turns for tool calls
        maxTurns: 50,
      }

      // Add Claude Code path if provided
      if (this.pathToClaudeCodeExecutable) {
        options.pathToClaudeCodeExecutable = this.pathToClaudeCodeExecutable
      }

      // CRITICAL: Inherit process.env (especially PATH) so subprocess can find executables
      // Without this, Bash tool cannot find ls, cat, etc.
      options.env = { ...process.env }
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

      // Use 'as any' to bypass type check - SDK supports more params than types define
      const session = await unstable_v2_resumeSession(sessionId, options as any)
      this.sessions.set(sessionId, session)
      console.log(`[ClaudeManager] Resumed V2 session: ${sessionId}`)
    }
    return this.sessions.get(sessionId)!
  }

  /**
   * Stream chat messages using V2 session
   * Returns an async generator that yields typed event chunks
   *
   * IMPORTANT: Only sends the LAST user message to the V2 session.
   * The V2 session maintains its own conversation history internally.
   * Sending the full history would confuse the model (especially Qwen).
   */
  async *streamChat(
    sessionId: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
    onToolCall?: (tool: ToolCall) => void,
    onTerminalOutput?: (output: TerminalOutput) => void
  ): AsyncGenerator<{ type: string; data?: any }> {
    const session = this.getSession(sessionId)

    try {
      // CRITICAL: Only send the LAST user message!
      // The V2 session maintains conversation history internally.
      // Sending all messages would confuse the model.
      const lastMessage = messages[messages.length - 1]
      if (!lastMessage || lastMessage.role !== 'user') {
        throw new Error('Last message must be from user')
      }

      console.log(`[ClaudeManager] Sending last user message: ${lastMessage.content.substring(0, 50)}...`)
      await session.send(lastMessage.content)

      console.log(`[ClaudeManager] Starting stream for session ${sessionId}...`)
      let eventCount = 0
      let textCount = 0

      // Stream response
      for await (const event of session.stream()) {
        eventCount++
        // Event types from V2 Session (as any for flexibility)
        const evt = event as any

        // Log all events for debugging
        if (eventCount <= 10 || evt.type?.includes('text') || evt.type?.includes('content')) {
          console.log(`[ClaudeManager] Event ${eventCount}: type=${evt.type}`, JSON.stringify(evt).substring(0, 200))
        }

        // Tool execution events
        if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
          onToolCall?.({
            id: evt.content_block.id,
            name: evt.content_block.name,
            input: evt.content_block.input,
            status: 'started'
          })
          yield { type: 'tool_call', data: evt.content_block }
        } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'tool_use_delta') {
          onToolCall?.({
            id: evt.delta.tool_use_id,
            name: '',
            input: evt.delta.partial_json,
            status: 'delta'
          })
          yield { type: 'tool_delta', data: evt.delta }
        } else if (evt.type === 'content_block_stop' && evt.content_block?.type === 'tool_use') {
          onToolCall?.({
            id: evt.content_block.id,
            name: '',
            input: {},
            status: 'result',
            output: evt.content_block.result
          })
          yield { type: 'tool_result', data: evt.content_block.result }
        }

        // Terminal output events (if supported by SDK)
        else if (evt.type === 'terminal_output') {
          onTerminalOutput?.({
            content: evt.content,
            type: evt.stream_type || 'stdout'
          })
          yield { type: 'terminal', data: evt }
        }

        // Text content events - handle multiple formats
        else if (evt.type === 'content_block_start') {
          // Check for text block
          if (evt.content_block?.type === 'text') {
            const text = evt.content_block?.text || ''
            if (text) {
              textCount++
              console.log(`[ClaudeManager] Text from content_block_start: ${text.substring(0, 50)}...`)
              yield { type: 'text', data: { text } }
            }
          }
        } else if (evt.type === 'content_block_delta') {
          // Check for text delta
          if (evt.delta?.type === 'text_delta' || evt.delta?.text) {
            const text = evt.delta?.text || ''
            if (text) {
              textCount++
              if (textCount <= 5) {
                console.log(`[ClaudeManager] Text delta: ${text.substring(0, 50)}...`)
              }
              yield { type: 'text', data: { text } }
            }
          }
        }

        // Handle V2 Session assistant events (contains text content)
        else if (evt.type === 'assistant') {
          const message = evt.message
          if (message?.content && Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block.type === 'text' && block.text) {
                textCount++
                console.log(`[ClaudeManager] Text from assistant event: ${block.text.substring(0, 50)}...`)
                yield { type: 'text', data: { text: block.text } }
              }
              // Also handle thinking blocks if present
              if (block.type === 'thinking' && block.thinking) {
                console.log(`[ClaudeManager] Thinking: ${block.thinking.substring(0, 50)}...`)
                yield { type: 'thinking', data: { text: block.thinking } }
              }
            }
          }
        }

        // Handle V2 Session result events (contains final result)
        else if (evt.type === 'result') {
          console.log(`[ClaudeManager] Result event: is_error=${evt.is_error}, result=${evt.result?.substring(0, 100)}`)
          // Yield the final result as text if we haven't already
          if (evt.result && textCount === 0) {
            yield { type: 'text', data: { text: evt.result } }
          }
          // End the stream after result
          break
        }

        else if (evt.type === 'error') {
          // Handle error
          const errorMsg = evt.error?.message || 'Unknown error'
          throw new Error(`Claude V2 Session error: ${errorMsg}`)
        } else if (evt.type === 'message_stop') {
          // End of stream
          break
        }
      }
    } catch (error) {
      console.error('[ClaudeManager] Stream chat error:', error)
      throw new Error(`Claude stream error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Send a chat message without streaming
   */
  async chat(sessionId: string, messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const session = this.getSession(sessionId)

    try {
      // Build user message (last message from history)
      const lastMessage = messages[messages.length - 1]
      const messageContent = lastMessage.content

      // Send message to V2 session
      await session.send(messageContent)

      // Collect full response
      let fullResponse = ''
      for await (const event of session.stream()) {
        // Event types from V2 Session (as any for flexibility)
        const evt = event as any

        // Extract text content from various event types
        if (evt.type === 'content_block_start' || evt.type === 'content_block_delta') {
          if (evt.content_block?.type === 'text') {
            if (evt.content_block?.delta?.type === 'text_delta') {
              fullResponse += evt.content_block.delta.text || ''
            } else if (evt.content_block?.text) {
              fullResponse += evt.content_block.text || ''
            }
          }
        } else if (evt.type === 'message_stop') {
          // End of stream
          break
        }
      }

      return fullResponse
    } catch (error) {
      console.error('[ClaudeManager] Chat error:', error)
      throw new Error(`Claude chat error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Close a V2 session
   */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      try {
        session.close()
        this.sessions.delete(sessionId)
        console.log(`[ClaudeManager] Closed V2 session: ${sessionId}`)
      } catch (error) {
        console.error(`[ClaudeManager] Error closing session ${sessionId}:`, error)
      }
    }
  }

  /**
   * Close all sessions
   */
  closeAllSessions(): void {
    for (const [sessionId, session] of this.sessions.entries()) {
      try {
        session.close()
      } catch (error) {
        console.error(`[ClaudeManager] Error closing session ${sessionId}:`, error)
      }
    }
    this.sessions.clear()
    console.log('[ClaudeManager] All sessions closed')
  }

  /**
   * List files in directory using V2 Session
   * Uses Bash tool to execute ls command
   */
  async listFiles(sessionId: string, path: string): Promise<FileInfo[]> {
    const session = this.getSession(sessionId)

    try {
      // Execute ls command via session
      const command = `ls -la "${path.replace(/"/g, '\\"')}"`
      await session.send(command)

      // Collect output
      let output = ''
      for await (const event of session.stream()) {
        const evt = event as any
        if (evt.type === 'terminal_output') {
          output += evt.content
        } else if (evt.type === 'message_stop') {
          break
        }
      }

      // Parse ls output
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
   * Uses Bash tool to execute cat command
   */
  async readFile(sessionId: string, path: string): Promise<string> {
    const session = this.getSession(sessionId)

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
   * Uses Bash tool to execute echo/cat command
   */
  async writeFile(sessionId: string, path: string, content: string): Promise<void> {
    const session = this.getSession(sessionId)

    try {
      // Use base64 encoding for binary safety and to handle special characters
      const base64Content = Buffer.from(content).toString('base64')
      const command = `echo "${base64Content}" | base64 -d > "${path.replace(/"/g, '\\"')}"`
      await session.send(command)

      // Wait for completion
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
   * Uses Bash tool to execute rm command
   */
  async deleteFile(sessionId: string, path: string): Promise<void> {
    const session = this.getSession(sessionId)

    try {
      const command = `rm -f "${path.replace(/"/g, '\\"')}"`
      await session.send(command)

      // Wait for completion
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
    const session = this.getSession(sessionId)

    try {
      await session.send(command)

      // Collect output
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
