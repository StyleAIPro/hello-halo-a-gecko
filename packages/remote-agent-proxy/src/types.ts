export interface RemoteServerConfig {
  port: number
  authToken?: string
  workDir?: string
  claudeApiKey?: string
  claudeBaseUrl?: string
  model?: string
  maxThinkingTokens?: number
}

export interface ClientMessage {
  type: 'auth' | 'claude:chat' | 'fs:list' | 'fs:read' | 'fs:write' | 'fs:upload' | 'fs:delete' | 'ping' | 'tool:approve' | 'tool:reject'
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
  status: 'started' | 'delta' | 'result' | 'error'
  output?: any
  error?: string
}

export interface TerminalOutputData {
  content: string
  type: 'stdout' | 'stderr'
}
