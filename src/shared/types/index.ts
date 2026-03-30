/**
 * Shared Types - Cross-process type definitions
 *
 * This module exports all shared types used by both main and renderer processes.
 * Import from this index for clean access to all shared types.
 */

// AI Sources types - export all types
export type {
  AuthType,
  BuiltinProviderId,
  ProviderId,
  LoginStatus,
  ApiProvider,
  ModelOption,
  AISourceUser,
  AISource,
  AISourcesConfig,
  OAuthSourceConfig,
  CustomSourceConfig,
  LegacyAISourcesConfig,
  BackendRequestConfig,
  OAuthLoginState,
  OAuthStartResult,
  OAuthCompleteResult,
  AISourceType,
  AISourceUserInfo,
  LocalizedText
} from './ai-sources'

// AI Sources - export constants and functions
export {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  createEmptyAISourcesConfig,
  getCurrentSource,
  getSourceById,
  getCurrentModelName,
  hasAnyAISource,
  isSourceConfigured,
  createSource,
  addSource,
  updateSource,
  deleteSource,
  setCurrentSource,
  setCurrentModel,
  getAvailableModels,
  resolveLocalizedText
} from './ai-sources'

// Health System types
export * from './health'

// Artifact types (shared between main process and file-watcher worker)
export * from './artifact'

// Notification channel types (shared between main process and renderer)
export * from './notification-channels'

// File changes types (shared between main process agent and renderer diff)
export type { FileChangesSummary, ThoughtLike } from '../file-changes'
export { countChangedLines, calculateDiffStats, extractFileChangesSummaryFromThoughts } from '../file-changes'

// Remote Server types
export interface RemoteServer {
  id: string
  name: string
  host: string
  sshPort: number
  username: string
  password: string  // encrypted
  wsPort: number
  authToken: string
  status: 'disconnected' | 'connected' | 'deploying' | 'error'
  error?: string
  workDir?: string
  claudeApiKey?: string
  claudeBaseUrl?: string  // Custom API base URL (e.g., for OpenAI-compatible APIs)
  claudeModel?: string    // Custom model name
  aiSourceId?: string     // Reference to AISource.id for preset selection
  sdkInstalled?: boolean  // Whether claude-agent-sdk is installed
  sdkVersion?: string  // Installed SDK version
  agentPath?: string  // Path to claude-agent binary (e.g., '/usr/local/bin/claude-agent')
}

export interface RemoteServerConnection {
  serverId: string
  url: string
  authToken: string
}

export interface RemoteFileMessage {
  type: 'list' | 'read' | 'write' | 'upload' | 'download' | 'delete'
  path?: string
  content?: string
}

export interface RemoteClaudeMessage {
  sessionId: string
  message: string
}

export interface FileInfo {
  name: string
  isDirectory: boolean
  size: number
  modifiedTime: Date
}

/**
 * Terminal output data structure
 */
export interface TerminalOutputData {
  content: string
  type: 'stdout' | 'stderr'
}

export interface Space {
  id: string
  name: string
  icon: string
  path: string
  isTemp: boolean
  createdAt: string
  updatedAt: string
  preferences?: SpacePreferences
  workingDir?: string

  // Remote Claude support
  claudeSource?: 'local' | 'remote'
  remoteServerId?: string
  remotePath?: string
  useSshTunnel?: boolean  // Use SSH port forwarding instead of direct WebSocket connection

  // Hyper Space support
  spaceType?: 'local' | 'remote' | 'hyper'
  agents?: Array<{
    id: string
    name: string
    type: 'local' | 'remote'
    role: 'leader' | 'worker'
    remoteServerId?: string
    remotePath?: string
    useSshTunnel?: boolean
    capabilities?: string[]
    workingDir?: string
    model?: string
    thinkingEnabled?: boolean
    systemPromptAddition?: string
  }>
  orchestration?: {
    mode: 'parallel' | 'sequential' | 'adaptive'
    routing: {
      strategy: string
      defaultAgentId?: string
    }
    aggregation: {
      strategy: string
      summarizerAgentId?: string
    }
    announce: {
      enabled: boolean
      timeout?: number
      retries?: number
    }
  }
}

export interface CreateSpaceInput {
  name: string
  icon: string
  customPath?: string
  claudeSource?: 'local' | 'remote'
  remoteServerId?: string
  remotePath?: string
  useSshTunnel?: boolean  // Use SSH port forwarding instead of direct WebSocket connection
}

// Hyper Space types
export * from './hyper-space'
