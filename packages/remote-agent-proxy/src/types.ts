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
  type: 'auth' | 'claude:chat' | 'fs:list' | 'fs:read' | 'fs:write' | 'fs:upload' | 'fs:delete' | 'ping' | 'tool:approve' | 'tool:reject' | 'claude:interrupt' | 'close:session' |
        'agent:spawn' | 'agent:steer' | 'agent:kill' | 'agent:list'  // Hyper Space agent management
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
    result?: string   // Tool execution result (for tool:approve with hyper-space tools)
    // Agent management payloads
    task?: string
    capabilities?: string[]
    agentId?: string
    instruction?: string
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
  hyperSpaceTools?: HyperSpaceToolsConfig  // Enable Hyper Space MCP tools for remote workers
}

/**
 * Hyper Space tools configuration for remote workers.
 * When present, the proxy creates an MCP server with proxy tools
 * that delegate execution to the Halo client via WebSocket.
 */
export interface HyperSpaceToolsConfig {
  spaceId: string
  conversationId: string        // Parent (leader's) conversation ID
  workerId: string
  workerName: string
  teamId: string
}

export interface ServerMessage {
  type: 'auth:success' | 'auth:failed' |
         'claude:stream' | 'claude:complete' | 'claude:error' | 'claude:session' | 'claude:usage' |
         'fs:result' | 'fs:error' | 'pong' |
         'tool:call' | 'tool:delta' | 'tool:result' | 'tool:error' |
         'terminal:output' |
         'thought' | 'thought:delta' |  // Thinking process events
         'mcp:status' |  // MCP server status
         'compact:boundary' |  // Context compression notification
         'text:block-start' |  // Text block start signal
         'worker:started' | 'worker:completed' |  // Subagent worker lifecycle
         'agent:spawned' | 'agent:status' | 'agent:killed' | 'agent:list' | 'agent:error'  // Hyper Space agent management
  sessionId?: string
  data?: any
}

// ============================================
// Hyper Space Agent Types
// ============================================

/**
 * Agent spawn request payload
 */
export interface AgentSpawnPayload {
  task: string
  capabilities?: string[]
  agentType?: 'leader' | 'worker'
  systemPrompt?: string
}

/**
 * Agent spawned response data
 */
export interface AgentSpawnedData {
  agentId: string
  taskId: string
  role: 'leader' | 'worker'
  status: 'starting' | 'running' | 'idle'
}

/**
 * Agent status response data
 */
export interface AgentStatusData {
  agentId: string
  status: 'idle' | 'running' | 'completed' | 'error'
  currentTaskId?: string
  lastHeartbeat?: number
  progress?: number  // 0-100
}

/**
 * Agent list response data
 */
export interface AgentListData {
  agents: Array<{
    id: string
    role: 'leader' | 'worker'
    status: string
    currentTaskId?: string
    lastHeartbeat?: number
  }>
}

/**
 * Agent error response data
 */
export interface AgentErrorData {
  agentId?: string
  error: string
  code?: string
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
