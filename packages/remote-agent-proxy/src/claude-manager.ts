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
    this.workDir = workDir
    this.model = model
  }

  /**
   * Get or create a V2 session for a given session ID
   */
  getSession(sessionId: string): SDKSession {
    if (!this.sessions.has(sessionId)) {
      const options: SDKSessionOptions = {
        model: this.model || 'claude-sonnet-4-20250514',
      }

      // Add Claude Code path if provided
      if (this.pathToClaudeCodeExecutable) {
        options.pathToClaudeCodeExecutable = this.pathToClaudeCodeExecutable
      }

      // Pass API key and base URL via environment variables
      // The V2 Session reads these from process.env
      options.env = options.env || {}
      if (this.apiKey) {
        options.env.ANTHROPIC_API_KEY = this.apiKey
      }
      if (this.baseUrl) {
        options.env.ANTHROPIC_BASE_URL = this.baseUrl
      }
      if (this.workDir) {
        options.env.CLAUDE_WORK_DIR = this.workDir
      }

      console.log(`[ClaudeManager] Creating V2 session with options:`, {
        model: options.model,
        hasApiKey: !!this.apiKey,
        baseUrl: this.baseUrl,
        workDir: this.workDir
      })

      const session = unstable_v2_createSession(options)
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
      const options: SDKSessionOptions = {
        model: this.model || 'claude-sonnet-4-20250514',
      }

      // Add Claude Code path if provided
      if (this.pathToClaudeCodeExecutable) {
        options.pathToClaudeCodeExecutable = this.pathToClaudeCodeExecutable
      }

      // Pass API key and base URL via environment variables
      options.env = options.env || {}
      if (this.apiKey) {
        options.env.ANTHROPIC_API_KEY = this.apiKey
      }
      if (this.baseUrl) {
        options.env.ANTHROPIC_BASE_URL = this.baseUrl
      }
      if (this.workDir) {
        options.env.CLAUDE_WORK_DIR = this.workDir
      }

      const session = await unstable_v2_resumeSession(sessionId, options)
      this.sessions.set(sessionId, session)
      console.log(`[ClaudeManager] Resumed V2 session: ${sessionId}`)
    }
    return this.sessions.get(sessionId)!
  }

  /**
   * Stream chat messages using V2 session
   * Returns an async generator that yields typed event chunks
   *
   * Supports multi-turn conversations by sending full message history
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
      // Send all messages in order for multi-turn conversation support
      // The V2 session maintains conversation history internally
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        const isLastMessage = i === messages.length - 1

        // Send message to V2 session
        console.log(`[ClaudeManager] Sending message ${i + 1}/${messages.length}: ${msg.content.substring(0, 50)}...`)
        await session.send(msg.content)

        // Only stream response for the last message
        if (isLastMessage) {
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
          break  // Exit after processing the last message's response
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
