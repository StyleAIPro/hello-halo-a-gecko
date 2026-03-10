export interface RemoteServerConfig {
  port: number
  authToken?: string
  workDir?: string
  claudeApiKey?: string
  claudeBaseUrl?: string
  model?: string
  maxThinkingTokens?: number
  pathToClaudeCodeExecutable?: string
}

export interface ClientMessage {
  type: 'auth' | 'claude:chat' | 'fs:list' | 'fs:read' | 'fs:write' | 'fs:upload' | 'fs:delete' | 'ping' | 'tool:approve' | 'tool:reject' | 'claude:interrupt' | 'close:session'
  sessionId?: string
  payload?: {
    messages?: any[]
    options?: ChatOptions & { workDir?: string }
    stream?: boolean
    path?: string
    content?: string
    token?: string
    toolId?: string
    reason?: string
  }
}

/**
 * Extended chat options with workDir support
 */
export interface ChatOptions {
  maxTokens?: number
  system?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  maxThinkingTokens?: number
  workDir?: string  // Dynamic working directory from client
}

export interface ServerMessage {
  type: 'auth:success' | 'auth:failed' |
         'claude:stream' | 'claude:complete' | 'claude:error' | 'claude:session' |
         'fs:result' | 'fs:error' | 'pong' |
         'tool:call' | 'tool:delta' | 'tool:result' | 'tool:error' |
         'terminal:output' |
         'thought' | 'thought:delta' |  // Thinking process events
         'mcp:status' |  // MCP server status
         'compact:boundary' |  // Context compression notification
         'text:block-start'  // Text block start signal
  sessionId?: string
  data?: any
}

export interface FileInfo {
  name: string
  isDirectory: boolean
  size: number
  modifiedTime: Date
}

// Tool call data structures
export interface ToolCallData {
  id: string
  name: string
  input: any
  status: 'started' | 'running' | 'delta' | 'result' | 'error'
  output?: any
  error?: string
}

export interface TerminalOutputData {
  content: string
  type: 'stdout' | 'stderr'
}

// Thought data structures (aligned with local Thought type)
export interface ThoughtData {
  id: string
  type: 'thinking' | 'tool_use' | 'tool_result' | 'text' | 'error' | 'result' | 'system'
  content?: string
  timestamp: string
  // For tool_use
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: {
    output: string
    isError: boolean
    timestamp: string
  }
  // For streaming state
  isStreaming?: boolean
  isReady?: boolean
  // For error
  errorCode?: string
}

export interface ThoughtDeltaData {
  thoughtId: string
  delta?: string
  content?: string
  isComplete?: boolean
  // For tool_use
  toolInput?: Record<string, unknown>
  toolResult?: {
    output: string
    isError: boolean
    timestamp: string
  }
  isReady?: boolean
  isToolInput?: boolean
  isToolResult?: boolean
}
