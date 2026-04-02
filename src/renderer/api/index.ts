/**
 * Halo API - Unified interface for both IPC and HTTP modes
 * Automatically selects the appropriate transport
 */

import {
  isElectron,
  httpRequest,
  onEvent,
  connectWebSocket,
  disconnectWebSocket,
  subscribeToConversation,
  unsubscribeFromConversation,
  setAuthToken,
  clearAuthToken,
  getAuthToken
} from './transport'

// Re-export onEvent for components that need to listen to IPC events
export { onEvent } from './transport'
import type {
  HealthStatusResponse,
  HealthStateResponse,
  HealthRecoveryResponse,
  HealthReportResponse,
  HealthExportResponse,
  HealthCheckResponse
} from '../../shared/types'
import type { InstalledSkill } from '../../shared/skill/skill-types'

// Response type
interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/**
 * API object - drop-in replacement for window.halo
 * Works in both Electron and remote web mode
 */
export const api = {
  // ===== Authentication (remote only) =====
  isRemoteMode: () => !isElectron(),
  isAuthenticated: () => !!getAuthToken(),

  login: async (token: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return { success: true }
    }

    const result = await httpRequest<void>('POST', '/api/remote/login', { token })
    if (result.success) {
      setAuthToken(token)
      connectWebSocket()
    }
    return result
  },

  logout: () => {
    clearAuthToken()
    disconnectWebSocket()
  },

  // ===== Generic Auth (provider-agnostic) =====
  authGetProviders: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.authGetProviders()
    }
    return httpRequest('GET', '/api/auth/providers')
  },

  authStartLogin: async (providerType: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.authStartLogin(providerType)
    }
    return httpRequest('POST', '/api/auth/start-login', { providerType })
  },

  authCompleteLogin: async (providerType: string, state: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.authCompleteLogin(providerType, state)
    }
    return httpRequest('POST', '/api/auth/complete-login', { providerType, state })
  },

  authRefreshToken: async (providerType: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.authRefreshToken(providerType)
    }
    return httpRequest('POST', '/api/auth/refresh-token', { providerType })
  },

  authCheckToken: async (providerType: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.authCheckToken(providerType)
    }
    return httpRequest('GET', `/api/auth/check-token?providerType=${providerType}`)
  },

  authLogout: async (providerType: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.authLogout(providerType)
    }
    return httpRequest('POST', '/api/auth/logout', { providerType })
  },

  onAuthLoginProgress: (callback: (data: { provider: string; status: string }) => void) =>
    onEvent('auth:login-progress', callback),

  // ===== Config =====
  getConfig: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getConfig()
    }
    return httpRequest('GET', '/api/config')
  },

  setConfig: async (updates: Record<string, unknown>): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.setConfig(updates)
    }
    return httpRequest('POST', '/api/config', updates)
  },

  validateApi: async (
    apiKey: string,
    apiUrl: string,
    provider: string,
    model?: string
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.validateApi(apiKey, apiUrl, provider, model)
    }
    return httpRequest('POST', '/api/config/validate', { apiKey, apiUrl, provider, model })
  },

  fetchModels: async (
    apiKey: string,
    apiUrl: string
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.fetchModels(apiKey, apiUrl)
    }
    return httpRequest('POST', '/api/config/fetch-models', { apiKey, apiUrl })
  },

  refreshAISourcesConfig: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.refreshAISourcesConfig()
    }
    return httpRequest('POST', '/api/config/refresh-ai-sources')
  },

  // ===== AI Sources CRUD (atomic - backend reads from disk, never overwrites rotating tokens) =====
  aiSourcesSwitchSource: async (sourceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.aiSourcesSwitchSource(sourceId)
    }
    return httpRequest('POST', '/api/ai-sources/switch-source', { sourceId })
  },

  aiSourcesSetModel: async (modelId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.aiSourcesSetModel(modelId)
    }
    return httpRequest('POST', '/api/ai-sources/set-model', { modelId })
  },

  aiSourcesAddSource: async (source: unknown): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.aiSourcesAddSource(source)
    }
    return httpRequest('POST', '/api/ai-sources/sources', source as Record<string, unknown>)
  },

  aiSourcesUpdateSource: async (sourceId: string, updates: unknown): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.aiSourcesUpdateSource(sourceId, updates)
    }
    return httpRequest('PUT', `/api/ai-sources/sources/${sourceId}`, updates as Record<string, unknown>)
  },

  aiSourcesDeleteSource: async (sourceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.aiSourcesDeleteSource(sourceId)
    }
    return httpRequest('DELETE', `/api/ai-sources/sources/${sourceId}`)
  },

  // ===== Space =====
  getHaloSpace: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getHaloSpace()
    }
    return httpRequest('GET', '/api/spaces/halo')
  },

  listSpaces: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.listSpaces()
    }
    return httpRequest('GET', '/api/spaces')
  },

  createSpace: async (input: {
    name: string
    icon: string
    customPath?: string
    workingDir?: string
    claudeSource?: 'local' | 'remote'
    remoteServerId?: string
    remotePath?: string
    useSshTunnel?: boolean  // Use SSH port forwarding instead of direct WebSocket connection
  }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.createSpace(input)
    }
    return httpRequest('POST', '/api/spaces', input)
  },

  deleteSpace: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.deleteSpace(spaceId)
    }
    return httpRequest('DELETE', `/api/spaces/${spaceId}`)
  },

  // ===== Hyper Space =====
  createHyperSpace: async (input: {
    name: string
    icon: string
    customPath?: string
    spaceType?: 'hyper'
    agents?: any[]
    orchestration?: any
  }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.createHyperSpace(input)
    }
    return httpRequest('POST', '/api/spaces/hyper', input)
  },

  getHyperSpaceStatus: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getHyperSpaceStatus(spaceId)
    }
    return httpRequest('GET', `/api/spaces/${spaceId}/hyper-status`)
  },

  getSpace: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getSpace(spaceId)
    }
    return httpRequest('GET', `/api/spaces/${spaceId}`)
  },

  openSpaceFolder: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.openSpaceFolder(spaceId)
    }
    // In remote mode, just return the path (can't open folder remotely)
    return httpRequest('POST', `/api/spaces/${spaceId}/open`)
  },

  getDefaultSpacePath: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getDefaultSpacePath()
    }
    // In remote mode, get default path from server
    return httpRequest('GET', '/api/spaces/default-path')
  },

  selectFolder: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.selectFolder()
    }
    // Cannot select folder in remote mode
    return { success: false, error: 'Cannot select folder in remote mode' }
  },

  updateSpace: async (
    spaceId: string,
    updates: { name?: string; icon?: string }
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.updateSpace(spaceId, updates)
    }
    return httpRequest('PUT', `/api/spaces/${spaceId}`, updates)
  },

  // Update space preferences (layout settings)
  updateSpacePreferences: async (
    spaceId: string,
    preferences: {
      layout?: {
        artifactRailExpanded?: boolean
        chatWidth?: number
      }
    }
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.updateSpacePreferences(spaceId, preferences)
    }
    return httpRequest('PUT', `/api/spaces/${spaceId}/preferences`, preferences)
  },

  // Get space preferences
  getSpacePreferences: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getSpacePreferences(spaceId)
    }
    return httpRequest('GET', `/api/spaces/${spaceId}/preferences`)
  },

  // Get or create skill space
  getSkillSpace: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getSkillSpace()
    }
    return httpRequest('GET', '/api/spaces/skill-space')
  },

  // Get skill space ID
  getSkillSpaceId: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getSkillSpaceId()
    }
    return httpRequest('GET', '/api/spaces/skill-space/id')
  },

  // Check if space is skill space
  isSkillSpace: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.isSkillSpace(spaceId)
    }
    return httpRequest('GET', `/api/spaces/${spaceId}/is-skill-space`)
  },

  // ===== Conversation =====
  listConversations: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.listConversations(spaceId)
    }
    return httpRequest('GET', `/api/spaces/${spaceId}/conversations`)
  },

  createConversation: async (spaceId: string, title?: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.createConversation(spaceId, title)
    }
    return httpRequest('POST', `/api/spaces/${spaceId}/conversations`, { title })
  },

  getConversation: async (
    spaceId: string,
    conversationId: string
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getConversation(spaceId, conversationId)
    }
    return httpRequest('GET', `/api/spaces/${spaceId}/conversations/${conversationId}`)
  },

  updateConversation: async (
    spaceId: string,
    conversationId: string,
    updates: Record<string, unknown>
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.updateConversation(spaceId, conversationId, updates)
    }
    return httpRequest(
      'PUT',
      `/api/spaces/${spaceId}/conversations/${conversationId}`,
      updates
    )
  },

  deleteConversation: async (
    spaceId: string,
    conversationId: string
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.deleteConversation(spaceId, conversationId)
    }
    return httpRequest(
      'DELETE',
      `/api/spaces/${spaceId}/conversations/${conversationId}`
    )
  },

  addMessage: async (
    spaceId: string,
    conversationId: string,
    message: { role: string; content: string }
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.addMessage(spaceId, conversationId, message)
    }
    return httpRequest(
      'POST',
      `/api/spaces/${spaceId}/conversations/${conversationId}/messages`,
      message
    )
  },

  updateLastMessage: async (
    spaceId: string,
    conversationId: string,
    updates: Record<string, unknown>
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.updateLastMessage(spaceId, conversationId, updates)
    }
    return httpRequest(
      'PUT',
      `/api/spaces/${spaceId}/conversations/${conversationId}/messages/last`,
      updates
    )
  },

  getMessageThoughts: async (
    spaceId: string,
    conversationId: string,
    messageId: string
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getMessageThoughts(spaceId, conversationId, messageId)
    }
    return httpRequest(
      'GET',
      `/api/spaces/${spaceId}/conversations/${conversationId}/messages/${messageId}/thoughts`
    )
  },

  toggleStarConversation: async (
    spaceId: string,
    conversationId: string,
    starred: boolean
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.toggleStarConversation(spaceId, conversationId, starred)
    }
    return httpRequest(
      'POST',
      `/api/spaces/${spaceId}/conversations/${conversationId}/star`,
      { starred }
    )
  },

  getAgentCommands: async (
    spaceId: string,
    conversationId: string
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getAgentCommands(spaceId, conversationId)
    }
    return httpRequest(
      'GET',
      `/api/spaces/${spaceId}/conversations/${conversationId}/agent-commands`
    )
  },

  // ===== Agent =====
  sendMessage: async (request: {
    spaceId: string
    conversationId: string
    message: string
    resumeSessionId?: string
    images?: Array<{
      id: string
      type: 'image'
      mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
      data: string
      name?: string
      size?: number
    }>
    aiBrowserEnabled?: boolean  // Enable AI Browser tools
    thinkingEnabled?: boolean  // Enable extended thinking mode
    canvasContext?: {  // Canvas context for AI awareness
      isOpen: boolean
      tabCount: number
      activeTab: {
        type: string
        title: string
        url?: string
        path?: string
      } | null
      tabs: Array<{
        type: string
        title: string
        url?: string
        path?: string
        isActive: boolean
      }>
    }
    agentId?: string  // Target agent ID for Hyper Space ('leader' or specific agent ID)
  }): Promise<ApiResponse> => {
    // Subscribe to conversation events before sending
    if (!isElectron()) {
      subscribeToConversation(request.conversationId)
    }

    if (isElectron()) {
      return window.halo.sendMessage(request)
    }
    return httpRequest('POST', '/api/agent/message', request)
  },

  stopGeneration: async (conversationId?: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.stopGeneration(conversationId)
    }
    return httpRequest('POST', '/api/agent/stop', { conversationId })
  },

  // Inject message at turn boundary (for turn-level message injection)
  injectMessage: async (request: {
    conversationId: string
    content: string
    images?: Array<{
      type: string
      data: string
      mediaType: string
    }>
    thinkingEnabled?: boolean
    aiBrowserEnabled?: boolean
  }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.injectMessage(request)
    }
    // Remote mode not supported for injection
    return { success: false, error: 'Message injection only available in desktop app' }
  },

  approveTool: async (conversationId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.approveTool(conversationId)
    }
    return httpRequest('POST', '/api/agent/approve', { conversationId })
  },

  rejectTool: async (conversationId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.rejectTool(conversationId)
    }
    return httpRequest('POST', '/api/agent/reject', { conversationId })
  },

  // Get current session state for recovery after refresh
  getSessionState: async (conversationId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getSessionState(conversationId)
    }
    return httpRequest('GET', `/api/agent/session/${conversationId}`)
  },

  // Get Hyper Space worker session states for recovery after page refresh
  getHyperSpaceWorkerStates: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getHyperSpaceWorkerStates(spaceId)
    }
    return httpRequest('GET', `/api/hyper-space/${spaceId}/worker-states`)
  },

  // Warm up V2 session - call when switching conversations to prepare for faster message sending
  ensureSessionWarm: async (spaceId: string, conversationId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      // No need to wait, initialize in background
      window.halo.ensureSessionWarm(spaceId, conversationId).catch((error: unknown) => {
        console.error('[API] ensureSessionWarm error:', error)
      })
      return { success: true }
    }
    // HTTP mode: send warm-up request to backend
    return httpRequest('POST', '/api/agent/warm', { spaceId, conversationId }).catch(() => ({
      success: false // Warm-up failure should not block
    }))
  },

  // Answer a pending AskUserQuestion
  answerQuestion: async (data: {
    conversationId: string
    id: string
    answers: Record<string, string>
  }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.answerQuestion(data)
    }
    return httpRequest('POST', '/api/agent/answer-question', data)
  },

  // Test MCP server connections
  testMcpConnections: async (): Promise<{ success: boolean; servers: unknown[]; error?: string }> => {
    if (isElectron()) {
      return window.halo.testMcpConnections()
    }
    // HTTP mode: call backend endpoint
    const result = await httpRequest('POST', '/api/agent/test-mcp')
    return result as { success: boolean; servers: unknown[]; error?: string }
  },

  // Manually trigger context compression for a conversation
  compactContext: async (conversationId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.compactContext(conversationId)
    }
    return httpRequest('POST', '/api/agent/compact', { conversationId })
  },

  // ===== Artifact =====
  listArtifacts: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.listArtifacts(spaceId)
    }
    return httpRequest('GET', `/api/spaces/${spaceId}/artifacts`)
  },

  listArtifactsTree: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.listArtifactsTree(spaceId)
    }
    return httpRequest('GET', `/api/spaces/${spaceId}/artifacts/tree`)
  },

  // Load children for lazy tree expansion
  loadArtifactChildren: async (spaceId: string, dirPath: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.loadArtifactChildren(spaceId, dirPath)
    }
    return httpRequest('POST', `/api/spaces/${spaceId}/artifacts/children`, { dirPath })
  },

  // Initialize file watcher for a space
  initArtifactWatcher: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.initArtifactWatcher(spaceId)
    }
    // In remote mode, watcher is managed by server
    return { success: true }
  },

  // Subscribe to artifact change events
  onArtifactChanged: (callback: (data: {
    type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
    path: string
    relativePath: string
    spaceId: string
    item?: unknown
  }) => void) => {
    if (isElectron()) {
      return window.halo.onArtifactChanged(callback)
    }
    // In remote mode, use WebSocket events
    return onEvent('artifact:changed', callback)
  },

  // Subscribe to tree update events (pre-computed data, zero IPC round-trips)
  onArtifactTreeUpdate: (callback: (data: {
    spaceId: string
    updatedDirs: Array<{ dirPath: string; children: unknown[] }>
    changes: Array<{
      type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
      path: string
      relativePath: string
      spaceId: string
      item?: unknown
    }>
  }) => void) => {
    if (isElectron()) {
      return window.halo.onArtifactTreeUpdate(callback)
    }
    // In remote mode, use WebSocket events
    return onEvent('artifact:tree-update', callback)
  },

  openArtifact: async (filePath: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.openArtifact(filePath)
    }
    // Can't open files remotely
    return { success: false, error: 'Cannot open files in remote mode' }
  },

  showArtifactInFolder: async (filePath: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.showArtifactInFolder(filePath)
    }
    // Can't open folder remotely
    return { success: false, error: 'Cannot open folder in remote mode' }
  },

  // Download artifact (remote mode only - triggers browser download)
  downloadArtifact: (filePath: string): void => {
    if (isElectron()) {
      // In Electron, just open the file
      window.halo.openArtifact(filePath)
      return
    }
    // In remote mode, trigger download via browser with token in URL
    const token = getAuthToken()
    const url = `/api/artifacts/download?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token || '')}`
    const link = document.createElement('a')
    link.href = url
    link.download = filePath.split('/').pop() || 'download'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  },

  // Get download URL for an artifact (for use with fetch or direct links)
  getArtifactDownloadUrl: (filePath: string): string => {
    const token = getAuthToken()
    return `/api/artifacts/download?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token || '')}`
  },

  // Read artifact content for Content Canvas
  readArtifactContent: async (filePath: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.readArtifactContent(filePath)
    }
    // In remote mode, fetch content via API
    return httpRequest('GET', `/api/artifacts/content?path=${encodeURIComponent(filePath)}`)
  },

  // Save artifact content (CodeViewer edit mode)
  saveArtifactContent: async (filePath: string, content: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.saveArtifactContent(filePath, content)
    }
    // In remote mode, save content via API
    return httpRequest('POST', '/api/artifacts/save', { path: filePath, content })
  },

  detectFileType: async (filePath: string): Promise<ApiResponse<{
    isText: boolean
    canViewInCanvas: boolean
    contentType: 'code' | 'markdown' | 'html' | 'image' | 'pdf' | 'text' | 'json' | 'csv' | 'binary'
    language?: string
    mimeType: string
  }>> => {
    if (isElectron()) {
      return window.halo.detectFileType(filePath)
    }
    // In remote mode, detect file type via API
    return httpRequest('GET', `/api/artifacts/detect-type?path=${encodeURIComponent(filePath)}`)
  },

  // ===== Onboarding =====
  writeOnboardingArtifact: async (
    spaceId: string,
    fileName: string,
    content: string
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.writeOnboardingArtifact(spaceId, fileName, content)
    }
    return httpRequest('POST', `/api/spaces/${spaceId}/onboarding/artifact`, { fileName, content })
  },

  saveOnboardingConversation: async (
    spaceId: string,
    userMessage: string,
    aiResponse: string
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.saveOnboardingConversation(spaceId, userMessage, aiResponse)
    }
    return httpRequest('POST', `/api/spaces/${spaceId}/onboarding/conversation`, { userMessage, aiResponse })
  },

  // ===== Remote Access (Electron only) =====
  enableRemoteAccess: async (port?: number): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.enableRemoteAccess(port)
  },

  disableRemoteAccess: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.disableRemoteAccess()
  },

  enableTunnel: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.enableTunnel()
  },

  disableTunnel: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.disableTunnel()
  },

  getRemoteStatus: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.getRemoteStatus()
  },

  getRemoteQRCode: async (includeToken?: boolean): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.getRemoteQRCode(includeToken)
  },

  setRemotePassword: async (password: string): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.setRemotePassword(password)
  },

  regenerateRemotePassword: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.regenerateRemotePassword()
  },

  // ===== System Settings (Electron only) =====
  getAutoLaunch: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.getAutoLaunch()
  },

  setAutoLaunch: async (enabled: boolean): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.setAutoLaunch(enabled)
  },

  openLogFolder: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.openLogFolder()
  },

  // ===== Window (Electron only) =====
  setTitleBarOverlay: async (options: {
    color: string
    symbolColor: string
  }): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: true } // No-op in remote mode
    }
    return window.halo.setTitleBarOverlay(options)
  },

  maximizeWindow: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.maximizeWindow()
  },

  unmaximizeWindow: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.unmaximizeWindow()
  },

  isWindowMaximized: async (): Promise<ApiResponse<boolean>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.isWindowMaximized()
  },

  toggleMaximizeWindow: async (): Promise<ApiResponse<boolean>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.toggleMaximizeWindow()
  },

  /**
   * Force window repaint to fix BrowserView click-blocking on Windows.
   * Performs a tiny size change to trigger DWM re-composition.
   */
  forceRepaint: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.forceRepaint()
    }
    return { success: false, error: 'Only available in desktop app' }
  },

  onWindowMaximizeChange: (callback: (isMaximized: boolean) => void) => {
    if (!isElectron()) {
      return () => { } // No-op in remote mode
    }
    return window.halo.onWindowMaximizeChange(callback)
  },

  // ===== Notification Channels =====
  testNotificationChannel: async (channelType: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.testNotificationChannel(channelType)
    }
    return httpRequest('POST', '/api/notify-channels/test', { channelType })
  },

  clearNotificationChannelCache: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.clearNotificationChannelCache()
    }
    return httpRequest('POST', '/api/notify-channels/clear-cache')
  },

  // ===== Event Listeners =====
  onAgentMessage: (callback: (data: unknown) => void) =>
    onEvent('agent:message', callback),
  onAgentToolCall: (callback: (data: unknown) => void) =>
    onEvent('agent:tool-call', callback),
  onAgentToolResult: (callback: (data: unknown) => void) =>
    onEvent('agent:tool-result', callback),
  onAgentError: (callback: (data: unknown) => void) =>
    onEvent('agent:error', callback),
  onAgentComplete: (callback: (data: unknown) => void) =>
    onEvent('agent:complete', callback),
  onAgentThought: (callback: (data: unknown) => void) =>
    onEvent('agent:thought', callback),
  onAgentThoughtDelta: (callback: (data: unknown) => void) =>
    onEvent('agent:thought-delta', callback),
  onAgentMcpStatus: (callback: (data: unknown) => void) =>
    onEvent('agent:mcp-status', callback),
  onAgentCompact: (callback: (data: unknown) => void) =>
    onEvent('agent:compact', callback),
  onAgentAskQuestion: (callback: (data: unknown) => void) =>
    onEvent('agent:ask-question', callback),
  onAgentTerminal: (callback: (data: unknown) => void) =>
    onEvent('agent:terminal', callback),
  onAgentTurnBoundary: (callback: (data: unknown) => void) =>
    onEvent('agent:turn-boundary', callback),
  onAgentInjectionStart: (callback: (data: unknown) => void) =>
    onEvent('agent:injection-start', callback),
  onAgentTeamMessage: (callback: (data: unknown) => void) =>
    onEvent('agent:team-message', callback),
  onWorkerStarted: (callback: (data: unknown) => void) =>
    onEvent('worker:started', callback),
  onWorkerCompleted: (callback: (data: unknown) => void) =>
    onEvent('worker:completed', callback),
  onRemoteStatusChange: (callback: (data: unknown) => void) =>
    onEvent('remote:status-change', callback),

  // ===== WebSocket Control =====
  connectWebSocket,
  disconnectWebSocket,
  subscribeToConversation,
  unsubscribeFromConversation,

  // ===== Browser (Embedded Browser for Content Canvas) =====
  // Note: Browser features only available in desktop app (not remote mode)

  createBrowserView: async (viewId: string, url?: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.createBrowserView(viewId, url)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  destroyBrowserView: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.destroyBrowserView(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  showBrowserView: async (
    viewId: string,
    bounds: { x: number; y: number; width: number; height: number }
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.showBrowserView(viewId, bounds)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  hideBrowserView: async (viewId: string, force: boolean = false): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.hideBrowserView(viewId, force)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  resizeBrowserView: async (
    viewId: string,
    bounds: { x: number; y: number; width: number; height: number }
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.resizeBrowserView(viewId, bounds)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  navigateBrowserView: async (viewId: string, url: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.navigateBrowserView(viewId, url)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  browserGoBack: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.browserGoBack(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  browserGoForward: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.browserGoForward(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  browserReload: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.browserReload(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  browserStop: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.browserStop(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  getBrowserState: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getBrowserState(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  captureBrowserView: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.captureBrowserView(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  executeBrowserJS: async (viewId: string, code: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.executeBrowserJS(viewId, code)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  setBrowserZoom: async (viewId: string, level: number): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.setBrowserZoom(viewId, level)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  toggleBrowserDevTools: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.toggleBrowserDevTools(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  showBrowserContextMenu: async (options: { viewId: string; url?: string; zoomLevel: number }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.showBrowserContextMenu(options)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  onBrowserStateChange: (callback: (data: unknown) => void) =>
    onEvent('browser:state-change', callback),

  onBrowserAllViewsHidden: (callback: () => void) =>
    onEvent('browser:all-views-hidden', callback as (data: unknown) => void),

  onBrowserZoomChanged: (callback: (data: { viewId: string; zoomLevel: number }) => void) =>
    onEvent('browser:zoom-changed', callback as (data: unknown) => void),

  // Canvas Tab Context Menu (native Electron menu)
  showCanvasTabContextMenu: async (options: {
    tabId: string
    tabIndex: number
    tabTitle: string
    tabPath?: string
    tabCount: number
    hasTabsToRight: boolean
  }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.showCanvasTabContextMenu(options)
    }
    return { success: false, error: 'Native menu only available in desktop app' }
  },

  onCanvasTabAction: (callback: (data: {
    action: 'close' | 'closeOthers' | 'closeToRight' | 'copyPath' | 'refresh'
    tabId?: string
    tabIndex?: number
    tabPath?: string
  }) => void) =>
    onEvent('canvas:tab-action', callback as (data: unknown) => void),

  // AI Browser active view change notification
  // Sent when AI Browser tools create or select a view
  onAIBrowserActiveViewChanged: (callback: (data: { viewId: string; url: string | null; title: string | null }) => void) =>
    onEvent('ai-browser:active-view-changed', callback as (data: unknown) => void),

  // ===== Search =====
  search: async (
    query: string,
    scope: 'conversation' | 'space' | 'global',
    conversationId?: string,
    spaceId?: string
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.search(query, scope, conversationId, spaceId)
    }
    return httpRequest('POST', '/api/search', {
      query,
      scope,
      conversationId,
      spaceId
    })
  },

  cancelSearch: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.cancelSearch()
    }
    return httpRequest('POST', '/api/search/cancel')
  },

  onSearchProgress: (callback: (data: { current: number; total: number; searchId: string }) => void) =>
    onEvent('search:progress', callback),

  onSearchCancelled: (callback: () => void) =>
    onEvent('search:cancelled', callback),

  // ===== Updater (Electron only) =====
  checkForUpdates: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.checkForUpdates()
  },

  installUpdate: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.installUpdate()
  },

  getVersion: async (): Promise<ApiResponse<string>> => {
    if (isElectron()) {
      const version = await window.halo.getVersion()
      return { success: true, data: version }
    }
    // Remote mode: get version from server
    return httpRequest('GET', '/api/system/version')
  },

  onUpdaterStatus: (callback: (data: {
    status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'manual-download' | 'error'
    version?: string
    percent?: number
    message?: string
    releaseNotes?: string | { version: string; note: string }[]
  }) => void) => {
    if (!isElectron()) {
      return () => { } // No-op in remote mode
    }
    return window.halo.onUpdaterStatus(callback)
  },

  // ===== Notification (in-app toast) =====
  onNotificationToast: (callback: (data: {
    title: string
    body?: string
    variant?: 'default' | 'success' | 'warning' | 'error'
    duration?: number
    appId?: string
  }) => void) => {
    if (!isElectron()) {
      return () => { } // No-op in remote mode
    }
    return window.halo.onNotificationToast(callback)
  },

  // ===== Overlay (Electron only) =====
  // Used for floating UI elements that need to render above BrowserViews
  showChatCapsuleOverlay: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.showChatCapsuleOverlay()
  },

  hideChatCapsuleOverlay: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.hideChatCapsuleOverlay()
  },

  onCanvasExitMaximized: (callback: () => void) => {
    if (!isElectron()) {
      return () => { } // No-op in remote mode
    }
    return window.halo.onCanvasExitMaximized(callback)
  },

  // ===== Performance Monitoring (Electron only, Developer Tools) =====
  perfStart: async (config?: { sampleInterval?: number; maxSamples?: number }): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.perfStart(config)
  },

  perfStop: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.perfStop()
  },

  perfGetState: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.perfGetState()
  },

  perfGetHistory: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.perfGetHistory()
  },

  perfClearHistory: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.perfClearHistory()
  },

  perfSetConfig: async (config: { enabled?: boolean; sampleInterval?: number; warnOnThreshold?: boolean }): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.perfSetConfig(config)
  },

  perfExport: async (): Promise<ApiResponse<string>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.perfExport()
  },

  onPerfSnapshot: (callback: (data: unknown) => void) =>
    onEvent('perf:snapshot', callback),

  onPerfWarning: (callback: (data: unknown) => void) =>
    onEvent('perf:warning', callback),

  // Report renderer metrics to main process (for combined monitoring)
  perfReportRendererMetrics: (metrics: {
    fps: number
    frameTime: number
    renderCount: number
    domNodes: number
    eventListeners: number
    jsHeapUsed: number
    jsHeapLimit: number
    longTasks: number
  }): void => {
    if (isElectron()) {
      window.halo.perfReportRendererMetrics(metrics)
    }
  },

  // ===== Git Bash (Windows only, Electron only) =====
  getGitBashStatus: async (): Promise<ApiResponse<{
    found: boolean
    path: string | null
    source: 'system' | 'app-local' | 'env-var' | null
  }>> => {
    if (!isElectron()) {
      // In remote mode, assume Git Bash is available (server handles it)
      return { success: true, data: { found: true, path: null, source: null } }
    }
    return window.halo.getGitBashStatus()
  },

  installGitBash: async (onProgress: (progress: {
    phase: 'downloading' | 'extracting' | 'configuring' | 'done' | 'error'
    progress: number
    message: string
    error?: string
  }) => void): Promise<{ success: boolean; path?: string; error?: string }> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.installGitBash(onProgress)
  },

  openExternal: async (url: string): Promise<void> => {
    if (!isElectron()) {
      // In remote mode, open in new tab
      window.open(url, '_blank')
      return
    }
    return window.halo.openExternal(url)
  },

  // ===== GitHub Integration (Electron only) =====

  githubGetAuthStatus: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.githubGetAuthStatus()
  },

  githubLoginBrowser: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.githubLoginBrowser()
  },

  githubLoginToken: async (token: string): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.githubLoginToken(token)
  },

  githubLogout: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.githubLogout()
  },

  githubSetupGitCredentials: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.githubSetupGitCredentials()
  },

  githubGitConfig: async (key: string, value: string): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.githubGitConfig(key, value)
  },

  githubGetGitConfig: async (key: string): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.githubGetGitConfig(key)
  },

  onGithubLoginProgress: (callback: (data: { code?: string; url?: string; message: string }) => void) => {
    if (!isElectron()) {
      return () => {}
    }
    return window.halo.onGithubLoginProgress(callback)
  },

  // ===== Bootstrap Lifecycle (Electron only) =====
  // Used to coordinate renderer initialization with main process service registration.
  // Implements Pull+Push pattern for reliable initialization:
  // - Pull: getBootstrapStatus() for immediate state query (handles HMR, error recovery)
  // - Push: onBootstrapExtendedReady() for event-based notification (normal startup)

  getBootstrapStatus: async (): Promise<{
    extendedReady: boolean
    extendedReadyAt: number
  }> => {
    if (!isElectron()) {
      // In remote mode, services are always ready (server handles it)
      return { extendedReady: true, extendedReadyAt: Date.now() }
    }
    const result = await window.halo.getBootstrapStatus()
    return result.data ?? { extendedReady: false, extendedReadyAt: 0 }
  },

  onBootstrapExtendedReady: (callback: (data: { timestamp: number; duration: number }) => void) => {
    if (!isElectron()) {
      // In remote mode, services are always ready (server handles it)
      // Call callback immediately
      setTimeout(() => callback({ timestamp: Date.now(), duration: 0 }), 0)
      return () => {}
    }
    return window.halo.onBootstrapExtendedReady(callback)
  },

  // ===== Health System (Electron only) =====
  getHealthStatus: async (): Promise<ApiResponse<HealthStatusResponse>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.getHealthStatus()
  },

  getHealthState: async (): Promise<ApiResponse<HealthStateResponse>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.getHealthState()
  },

  triggerHealthRecovery: async (strategyId: string, userConsented: boolean): Promise<ApiResponse<HealthRecoveryResponse>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.triggerHealthRecovery(strategyId, userConsented)
  },

  generateHealthReport: async (): Promise<ApiResponse<HealthReportResponse>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.generateHealthReport()
  },

  generateHealthReportText: async (): Promise<ApiResponse<string>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.generateHealthReportText()
  },

  exportHealthReport: async (filePath?: string): Promise<ApiResponse<HealthExportResponse>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.exportHealthReport(filePath)
  },

  runHealthCheck: async (): Promise<ApiResponse<HealthCheckResponse>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.runHealthCheck()
  },

  // ===== Apps =====
  appList: async (filter?: { spaceId?: string; status?: string; type?: string }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appList(filter)
    }
    const params = new URLSearchParams()
    if (filter?.spaceId) params.set('spaceId', filter.spaceId)
    if (filter?.status) params.set('status', filter.status)
    if (filter?.type) params.set('type', filter.type)
    const qs = params.toString()
    return httpRequest('GET', `/api/apps${qs ? '?' + qs : ''}`)
  },

  appGet: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appGet(appId)
    }
    return httpRequest('GET', `/api/apps/${appId}`)
  },

  appInstall: async (input: { spaceId: string; spec: unknown; userConfig?: Record<string, unknown> }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appInstall(input)
    }
    return httpRequest('POST', '/api/apps/install', input as Record<string, unknown>)
  },

  appUninstall: async (appId: string, options?: { purge?: boolean }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appUninstall({ appId, options })
    }
    const qs = options?.purge ? '?purge=true' : ''
    return httpRequest('DELETE', `/api/apps/${appId}${qs}`)
  },

  appReinstall: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appReinstall({ appId })
    }
    return httpRequest('POST', `/api/apps/${appId}/reinstall`)
  },

  appDelete: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appDelete({ appId })
    }
    return httpRequest('DELETE', `/api/apps/${appId}/permanent`)
  },

  appPause: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appPause(appId)
    }
    return httpRequest('POST', `/api/apps/${appId}/pause`)
  },

  appResume: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appResume(appId)
    }
    return httpRequest('POST', `/api/apps/${appId}/resume`)
  },

  appTrigger: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appTrigger(appId)
    }
    return httpRequest('POST', `/api/apps/${appId}/trigger`)
  },

  appGetState: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appGetState(appId)
    }
    return httpRequest('GET', `/api/apps/${appId}/state`)
  },

  appGetActivity: async (appId: string, options?: { limit?: number; offset?: number; type?: string; since?: number }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appGetActivity({ appId, options })
    }
    const params = new URLSearchParams()
    if (options?.limit) params.set('limit', String(options.limit))
    if (options?.offset) params.set('offset', String(options.offset))
    if (options?.since) params.set('before', String(options.since))
    const qs = params.toString()
    return httpRequest('GET', `/api/apps/${appId}/activity${qs ? '?' + qs : ''}`)
  },

  appGetSession: async (appId: string, runId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appGetSession({ appId, runId })
    }
    return httpRequest('GET', `/api/apps/${appId}/runs/${runId}/session`)
  },

  appRespondEscalation: async (appId: string, escalationId: string, response: { choice?: string; text?: string }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appRespondEscalation({
        appId,
        escalationId,
        response: { ts: Date.now(), ...response },
      })
    }
    return httpRequest('POST', `/api/apps/${appId}/escalation/${escalationId}/respond`, response as Record<string, unknown>)
  },

  appUpdateConfig: async (appId: string, config: Record<string, unknown>): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appUpdateConfig({ appId, config })
    }
    return httpRequest('POST', `/api/apps/${appId}/config`, config)
  },

  appUpdateFrequency: async (appId: string, subscriptionId: string, frequency: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appUpdateFrequency({ appId, subscriptionId, frequency })
    }
    return httpRequest('POST', `/api/apps/${appId}/frequency`, { subscriptionId, frequency })
  },

  appUpdateOverrides: async (appId: string, overrides: Record<string, unknown>): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appUpdateOverrides({ appId, overrides })
    }
    return httpRequest('PATCH', `/api/apps/${appId}/overrides`, overrides)
  },

  appUpdateSpec: async (appId: string, specPatch: Record<string, unknown>): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appUpdateSpec({ appId, specPatch })
    }
    return httpRequest('PATCH', `/api/apps/${appId}/spec`, specPatch)
  },

  appGrantPermission: async (appId: string, permission: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appGrantPermission({ appId, permission })
    }
    return httpRequest('POST', `/api/apps/${appId}/permissions/grant`, { permission })
  },

  appRevokePermission: async (appId: string, permission: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appRevokePermission({ appId, permission })
    }
    return httpRequest('POST', `/api/apps/${appId}/permissions/revoke`, { permission })
  },

  // App Import / Export
  appExportSpec: async (appId: string): Promise<ApiResponse<{ yaml: string; filename: string }>> => {
    if (isElectron()) {
      return window.halo.appExportSpec(appId)
    }
    return httpRequest('GET', `/api/apps/${appId}/export-spec`)
  },

  appImportSpec: async (input: { spaceId: string; yamlContent: string; userConfig?: Record<string, unknown> }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appImportSpec(input)
    }
    return httpRequest('POST', '/api/apps/import-spec', input as Record<string, unknown>)
  },

  // App Chat
  appChatSend: async (request: { appId: string; spaceId: string; message: string; thinkingEnabled?: boolean }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appChatSend(request)
    }
    return httpRequest('POST', `/api/apps/${request.appId}/chat/send`, request as unknown as Record<string, unknown>)
  },

  appChatStop: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appChatStop(appId)
    }
    return httpRequest('POST', `/api/apps/${appId}/chat/stop`)
  },

  appChatStatus: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appChatStatus(appId)
    }
    return httpRequest('GET', `/api/apps/${appId}/chat/status`)
  },

  appChatMessages: async (appId: string, spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appChatMessages({ appId, spaceId })
    }
    return httpRequest('GET', `/api/apps/${appId}/chat/messages?spaceId=${spaceId}`)
  },

  appChatSessionState: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appChatSessionState(appId)
    }
    return httpRequest('GET', `/api/apps/${appId}/chat/session-state`)
  },

  // App Event Listeners
  onAppStatusChanged: (callback: (data: unknown) => void) =>
    onEvent('app:status_changed', callback),

  onAppActivityEntry: (callback: (data: unknown) => void) =>
    onEvent('app:activity_entry:new', callback),

  onAppEscalation: (callback: (data: unknown) => void) =>
    onEvent('app:escalation:new', callback),

  onAppNavigate: (callback: (data: unknown) => void) =>
    onEvent('app:navigate', callback),

  // ===== Store (App Registry) =====
  storeListApps: async (query: { search?: string; locale?: string; category?: string; type?: string; tags?: string[] }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeListApps(query)
    }
    const params = new URLSearchParams()
    if (query.search) params.set('search', query.search)
    if (query.locale) params.set('locale', query.locale)
    if (query.category) params.set('category', query.category)
    if (query.type) params.set('type', query.type)
    if (query.tags && query.tags.length > 0) {
      params.set('tags', query.tags.join(','))
    }
    const qs = params.toString()
    return httpRequest('GET', `/api/store/apps${qs ? '?' + qs : ''}`)
  },

  storeGetAppDetail: async (slug: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeGetAppDetail(slug)
    }
    return httpRequest('GET', `/api/store/apps/${slug}`)
  },

  storeInstall: async (slug: string, spaceId: string, userConfig?: Record<string, unknown>): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeInstall({ slug, spaceId, userConfig })
    }
    return httpRequest('POST', `/api/store/apps/${slug}/install`, { spaceId, userConfig })
  },

  storeRefresh: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeRefresh()
    }
    return httpRequest('POST', '/api/store/refresh')
  },

  storeCheckUpdates: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeCheckUpdates()
    }
    return httpRequest('GET', '/api/store/updates')
  },

  storeGetRegistries: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeGetRegistries()
    }
    return httpRequest('GET', '/api/store/registries')
  },

  storeAddRegistry: async (input: { name: string; url: string }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeAddRegistry(input)
    }
    return httpRequest('POST', '/api/store/registries', input)
  },

  storeRemoveRegistry: async (registryId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeRemoveRegistry(registryId)
    }
    return httpRequest('DELETE', `/api/store/registries/${registryId}`)
  },

  storeToggleRegistry: async (registryId: string, enabled: boolean): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeToggleRegistry({ registryId, enabled })
    }
    return httpRequest('POST', `/api/store/registries/${registryId}/toggle`, { enabled })
  },

  // ===== Remote Server =====
  remoteServerAdd: async (server: unknown): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.add(server)
    }
    return httpRequest('POST', '/api/remote-server', server as Record<string, unknown>)
  },

  remoteServerList: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.list()
    }
    return httpRequest('GET', '/api/remote-server')
  },

  remoteServerDeploy: async (serverId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.deploy(serverId)
    }
    return httpRequest('POST', `/api/remote-server/${serverId}/deploy`)
  },

  remoteServerConnect: async (serverId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.connect(serverId)
    }
    return httpRequest('POST', `/api/remote-server/${serverId}/connect`)
  },

  remoteServerDisconnect: async (serverId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.disconnect(serverId)
    }
    return httpRequest('POST', `/api/remote-server/${serverId}/disconnect`)
  },

  remoteServerDelete: async (serverId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.delete(serverId)
    }
    return httpRequest('DELETE', `/api/remote-server/${serverId}`)
  },

  remoteServerGet: async (serverId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.get(serverId)
    }
    return httpRequest('GET', `/api/remote-server/${serverId}`)
  },

  remoteServerUpdate: async (server: Record<string, unknown>): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.update(server)
    }
    return httpRequest('PUT', '/api/remote-server', server)
  },

  remoteServerTestConnection: async (serverId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.testConnection(serverId)
    }
    return httpRequest('POST', `/api/remote-server/${serverId}/test-connection`)
  },

  // Alias methods for component compatibility
  getRemoteServers: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.list()
    }
    return httpRequest('GET', '/api/remote-server')
  },

  getRemoteServer: async (serverId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.get(serverId)
    }
    return httpRequest('GET', `/api/remote-server/${serverId}`)
  },

  addRemoteServer: async (server: Record<string, unknown>): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.add(server)
    }
    return httpRequest('POST', '/api/remote-server', server)
  },

  updateRemoteServer: async (server: Record<string, unknown>): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.update(server)
    }
    return httpRequest('PUT', '/api/remote-server', server)
  },

  deleteRemoteServer: async (serverId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.delete(serverId)
    }
    return httpRequest('DELETE', `/api/remote-server/${serverId}`)
  },

  testRemoteConnection: async (serverId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.testConnection(serverId)
    }
    return httpRequest('POST', `/api/remote-server/${serverId}/test-connection`)
  },

  checkRemoteAgentConnection: async (serverId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteAgent.checkConnection(serverId)
    }
    return httpRequest('GET', `/api/remote-agent/${serverId}/status`)
  },

  sendRemoteAgentMessage: async (serverId: string, params: { sessionId?: string; content: string; attachments?: any[] }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteAgent.chat(serverId, params)
    }
    return httpRequest('POST', `/api/remote-agent/${serverId}/chat`, params)
  },

  getRemoteAgentMessages: async (serverId: string, sessionId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteAgent.getMessages(serverId, sessionId)
    }
    return httpRequest('GET', `/api/remote-agent/${serverId}/chat/${sessionId}`)
  },

  listRemoteFiles: async (serverId: string, path: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteAgent.fsList(serverId, path)
    }
    return httpRequest('GET', `/api/remote-agent/${serverId}/fs/list?path=${encodeURIComponent(path)}`)
  },

  // ===== Remote Agent =====
  remoteAgentSendMessage: async (serverId: string, message: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteAgent.sendMessage(serverId, message)
    }
    return httpRequest('POST', `/api/remote-agent/${serverId}/message`, { message })
  },

  remoteAgentFsList: async (serverId: string, path?: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteAgent.fsList(serverId, path)
    }
    const params = path ? `?path=${encodeURIComponent(path)}` : ''
    return httpRequest('GET', `/api/remote-agent/${serverId}/fs/list${params}`)
  },

  remoteAgentFsRead: async (serverId: string, path: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteAgent.fsRead(serverId, path)
    }
    return httpRequest('GET', `/api/remote-agent/${serverId}/fs/read?path=${encodeURIComponent(path)}`)
  },

  remoteAgentFsWrite: async (serverId: string, path: string, content: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteAgent.fsWrite(serverId, path, content)
    }
    return httpRequest('POST', `/api/remote-agent/${serverId}/fs/write`, { path, content })
  },

  remoteAgentFsDelete: async (serverId: string, path: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteAgent.fsDelete(serverId, path)
    }
    return httpRequest('DELETE', `/api/remote-agent/${serverId}/fs`, { path })
  },

  onRemoteAgentStream: (callback: (data: unknown) => void) =>
    onEvent('remote-agent:stream', callback),
  onRemoteAgentComplete: (callback: (data: unknown) => void) =>
    onEvent('remote-agent:complete', callback),
  onRemoteAgentError: (callback: (data: unknown) => void) =>
    onEvent('remote-agent:error', callback),
  onRemoteAgentFsResult: (callback: (data: unknown) => void) =>
    onEvent('remote-agent:fs:result', callback),

  remoteAgentCheckConnection: async (serverId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteAgent.checkConnection(serverId)
    }
    return httpRequest('GET', `/api/remote-agent/${serverId}/connection-status`)
  },

  remoteAgentGetMessages: async (serverId: string, sessionId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteAgent.getMessages(serverId, sessionId)
    }
    return httpRequest('GET', `/api/remote-agent/${serverId}/messages/${sessionId}`)
  },

  // ===== Remote Server Agent Management =====
  remoteServerCheckAgent: async (serverId: string): Promise<ApiResponse<{ installed: boolean; version?: string }>> => {
    if (isElectron()) {
      return window.halo.remoteServer.checkAgent(serverId)
    }
    return httpRequest('GET', `/api/remote-server/${serverId}/check-agent`)
  },

  remoteServerDeployAgent: async (serverId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.deployAgent(serverId)
    }
    return httpRequest('POST', `/api/remote-server/${serverId}/deploy-agent`)
  },
  remoteServerUpdateAgent: async (serverId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.updateAgent(serverId)
    }
    return httpRequest('POST', `/api/remote-server/${serverId}/update-agent`)
  },

  remoteServerStartAgent: async (serverId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.startAgent(serverId)
    }
    return httpRequest('POST', `/api/remote-server/${serverId}/start-agent`)
  },

  remoteServerStopAgent: async (serverId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.remoteServer.stopAgent(serverId)
    }
    return httpRequest('POST', `/api/remote-server/${serverId}/stop-agent`)
  },

  remoteServerGetAgentLogs: async (serverId: string, lines: number = 100): Promise<ApiResponse<{ logs: string }>> => {
    if (isElectron()) {
      return window.halo.remoteServer.getAgentLogs(serverId, lines)
    }
    return httpRequest('GET', `/api/remote-server/${serverId}/agent-logs?lines=${lines}`)
  },

  remoteServerIsAgentRunning: async (serverId: string): Promise<ApiResponse<{ running: boolean }>> => {
    if (isElectron()) {
      return window.halo.remoteServer.isAgentRunning(serverId)
    }
    return httpRequest('GET', `/api/remote-server/${serverId}/agent-running`)
  },

  // Sync skills from local to remote server
  remoteServerSyncSkills: async (serverId: string): Promise<ApiResponse<{ success: boolean; syncedCount: number; message: string }>> => {
    if (isElectron()) {
      return window.halo.remoteServer.syncSkills(serverId)
    }
    return httpRequest('POST', `/api/remote-server/${serverId}/sync-skills`)
  },

  // ===== Terminal & Skill Generation =====
  getTerminalWebSocketUrl: async (spaceId: string, conversationId: string): Promise<ApiResponse<{ wsUrl: string }>> => {
    if (isElectron()) {
      return window.halo.getTerminalWebSocketUrl(spaceId, conversationId)
    }
    // Remote mode: construct WebSocket URL from server
    const token = getAuthToken()
    const wsUrl = `ws://localhost:8765/terminal?spaceId=${spaceId}&conversationId=${conversationId}&token=${token || ''}`
    return { success: true, data: { wsUrl } }
  },

  // Send command to user terminal
  sendTerminalCommand: async (spaceId: string, conversationId: string, command: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.sendTerminalCommand(spaceId, conversationId, command)
    }
    return httpRequest('POST', '/api/terminal/command', { spaceId, conversationId, command })
  },

  // Get recent terminal output (for Agent query)
  getTerminalOutput: async (spaceId: string, conversationId: string, lines?: number): Promise<ApiResponse<{ lines: string[] }>> => {
    if (isElectron()) {
      return window.halo.getTerminalOutput(spaceId, conversationId, lines)
    }
    return httpRequest('GET', `/api/terminal/output?spaceId=${spaceId}&conversationId=${conversationId}&lines=${lines || 50}`)
  },

  generateSkillFromTerminal: async (spaceId: string, conversationId: string): Promise<ApiResponse<{
    id: string
    name: string
    description: string
    triggerCommand: string
    systemPrompt: string
    examples: string[]
  }>> => {
    if (isElectron()) {
      return window.halo.generateSkillFromTerminal(spaceId, conversationId)
    }
    return httpRequest('POST', '/api/skills/generate-from-terminal', { spaceId, conversationId })
  },

  saveSkill: async (skill: {
    name: string
    description: string
    triggerCommand: string
    systemPrompt: string
    examples?: string[]
  }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.saveSkill(skill)
    }
    return httpRequest('POST', '/api/skills', skill)
  },

  listSkills: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.listSkills()
    }
    return httpRequest('GET', '/api/skills')
  },

  // ===== Skill Management (New) =====
  skillList: async (): Promise<ApiResponse<InstalledSkill[]>> => {
    if (isElectron()) {
      return window.halo.skillList()
    }
    return httpRequest('GET', '/api/skills')
  },

  skillToggle: async (skillId: string, enabled: boolean): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillToggle(skillId, enabled)
    }
    return httpRequest('POST', '/api/skills/toggle', { skillId, enabled })
  },

  skillUninstall: async (skillId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillUninstall(skillId)
    }
    return httpRequest('POST', '/api/skills/uninstall', { skillId })
  },

  skillExport: async (skillId: string): Promise<ApiResponse<{ yamlContent: string }>> => {
    if (isElectron()) {
      return window.halo.skillExport(skillId)
    }
    return httpRequest('GET', `/api/skills/${skillId}/export`)
  },

  skillInstall: async (input: {
    mode: 'market' | 'yaml'
    skillId?: string
    yamlContent?: string
  }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillInstall(input)
    }
    return httpRequest('POST', '/api/skills/install', input)
  },

  skillMarketList: async (page?: number, pageSize?: number): Promise<ApiResponse<{ skills: any[]; total: number; hasMore: boolean }>> => {
    if (isElectron()) {
      return window.halo.skillMarketList(page, pageSize)
    }
    return httpRequest('GET', '/api/skills/market')
  },

  skillMarketSearch: async (query: string, page?: number, pageSize?: number): Promise<ApiResponse<{ skills: any[]; total: number; hasMore: boolean }>> => {
    if (isElectron()) {
      return window.halo.skillMarketSearch(query, page, pageSize)
    }
    return httpRequest('GET', `/api/skills/market/search?q=${encodeURIComponent(query)}`)
  },

  skillMarketDetail: async (skillId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillMarketDetail(skillId)
    }
    return { success: false, error: 'Only available in desktop app' }
  },

  skillMarketSources: async (): Promise<ApiResponse<any[]>> => {
    if (isElectron()) {
      return window.halo.skillMarketSources()
    }
    return httpRequest('GET', '/api/skills/market/sources')
  },

  skillMarketToggleSource: async (sourceId: string, enabled: boolean): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillMarketToggleSource(sourceId, enabled)
    }
    return httpRequest('POST', '/api/skills/market/toggle-source', { sourceId, enabled })
  },

  skillMarketSetActiveSource: async (sourceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillMarketSetActiveSource(sourceId)
    }
    return httpRequest('POST', '/api/skills/market/set-active', { sourceId })
  },

  skillMarketAddSource: async (source: { name: string; url: string; repos?: string[]; description?: string }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillMarketAddSource(source)
    }
    return httpRequest('POST', '/api/skills/market/add-source', source)
  },

  skillMarketRemoveSource: async (sourceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillMarketRemoveSource(sourceId)
    }
    return httpRequest('DELETE', `/api/skills/market/sources/${sourceId}`)
  },

  skillConfigGet: async (): Promise<ApiResponse<{ config: any }>> => {
    if (isElectron()) {
      return window.halo.skillConfigGet()
    }
    return httpRequest('GET', '/api/skills/config')
  },

  skillConfigUpdate: async (config: { globalShared?: boolean }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillConfigUpdate(config)
    }
    return httpRequest('POST', '/api/skills/config', config)
  },

   skillRefresh: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillRefresh()
    }
    return httpRequest('POST', '/api/skills/refresh')
  },

  skillFiles: async (skillId: string): Promise<ApiResponse<SkillFileNode[]>> => {
    if (isElectron()) {
      return window.halo.skillFiles(skillId)
    }
    return httpRequest('GET', `/api/skills/${skillId}/files`)
  },

  skillFileContent: async (skillId: string, filePath: string): Promise<ApiResponse<string>> => {
    if (isElectron()) {
      return window.halo.skillFileContent(skillId, filePath)
    }
    return httpRequest('GET', `/api/skills/${skillId}/files/${filePath}`)
  },

  skillFileSave: async (skillId: string, filePath: string, content: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillFileSave(skillId, filePath, content)
    }
    return httpRequest('POST', `/api/skills/${skillId}/files/${filePath}`, { content })
  },

  // ============================================
  // Skill Generator & Temp Agent Session
  // ============================================

  /**
   * 分析对话，提取技能模式
   */
  skillAnalyzeConversations: async (spaceId: string, conversationIds: string[]): Promise<ApiResponse<{
    analysisResult: any;
    similarSkills: any[];
    suggestedName: string;
    suggestedCommand: string;
  }>> => {
    if (isElectron()) {
      return window.halo.skillAnalyzeConversations(spaceId, conversationIds)
    }
    return httpRequest('POST', '/api/skills/analyze-conversations', { spaceId, conversationIds })
  },

  /**
   * 创建临时 Agent 会话
   */
  skillCreateTempSession: async (options: {
    skillName: string;
    context: any;
  }): Promise<ApiResponse<{ sessionId: string }>> => {
    if (isElectron()) {
      return window.halo.skillCreateTempSession(options)
    }
    return httpRequest('POST', '/api/skills/temp-session', options)
  },

  /**
   * 发送消息到临时会话
   */
  skillSendTempMessage: async (sessionId: string, message: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillSendTempMessage(sessionId, message)
    }
    return httpRequest('POST', `/api/skills/temp-session/${sessionId}/message`, { message })
  },

  /**
   * 关闭临时会话
   */
  skillCloseTempSession: async (sessionId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillCloseTempSession(sessionId)
    }
    return httpRequest('DELETE', `/api/skills/temp-session/${sessionId}`)
  },

  /**
   * 监听技能生成流式消息
   */
  onSkillTempMessageChunk: (callback: (data: { sessionId: string; chunk: any }) => void): (() => void) => {
    if (isElectron() && window.halo.onSkillTempMessageChunk) {
      return window.halo.onSkillTempMessageChunk(callback)
    }
    // 非 Electron 环境暂不支持流式
    return () => {}
  },

  /**
   * 监听技能安装输出
   */
  onSkillInstallOutput: (callback: (data: { skillId: string; output: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string } }) => void): (() => void) => {
    if (isElectron() && window.halo.onSkillInstallOutput) {
      return window.halo.onSkillInstallOutput(callback)
    }
    // 非 Electron 环境暂不支持
    return () => {}
  },

  // ===== Skill Conversation (持久化会话) =====

  /**
   * 列出技能生成器的所有会话
   * @param relatedSkillId 可选，按技能 ID 过滤会话
   */
  skillConversationList: async (relatedSkillId?: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillConversationList(relatedSkillId)
    }
    const query = relatedSkillId ? `?relatedSkillId=${encodeURIComponent(relatedSkillId)}` : ''
    return httpRequest('GET', `/api/skills/conversations${query}`)
  },

  /**
   * 获取技能生成器会话详情
   */
  skillConversationGet: async (conversationId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillConversationGet(conversationId)
    }
    return httpRequest('GET', `/api/skills/conversations/${conversationId}`)
  },

  /**
   * 创建新的技能生成器会话
   * @param title 会话标题
   * @param relatedSkillId 可选，关联的技能 ID
   */
  skillConversationCreate: async (title?: string, relatedSkillId?: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillConversationCreate(title, relatedSkillId)
    }
    return httpRequest('POST', '/api/skills/conversations', { title, relatedSkillId })
  },

  /**
   * 删除技能生成器会话
   */
  skillConversationDelete: async (conversationId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillConversationDelete(conversationId)
    }
    return httpRequest('DELETE', `/api/skills/conversations/${conversationId}`)
  },

  /**
   * 发送消息到技能生成器会话
   * @param conversationId 会话 ID
   * @param message 消息内容
   * @param metadata 可选的元数据（包含选中的会话、参考网页等，用于折叠卡片显示）
   */
  skillConversationSend: async (
    conversationId: string,
    message: string,
    metadata?: {
      selectedConversations?: Array<{
        id: string
        title: string
        spaceName: string
        messageCount: number
        formattedContent?: string
      }>
      sourceWebpages?: Array<{
        url: string
        title?: string
        content?: string
      }>
    }
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillConversationSend(conversationId, message, metadata)
    }
    return httpRequest('POST', `/api/skills/conversations/${conversationId}/send`, { message, metadata })
  },

  /**
   * 停止技能生成器消息生成
   */
  skillConversationStop: async (conversationId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillConversationStop(conversationId)
    }
    return httpRequest('POST', `/api/skills/conversations/${conversationId}/stop`)
  },

  /**
   * 关闭技能生成器会话
   */
  skillConversationClose: async (conversationId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.skillConversationClose(conversationId)
    }
    return httpRequest('POST', `/api/skills/conversations/${conversationId}/close`)
  },

  /**
   * 获取网页内容（用于从网页创建技能）
   */
  fetchWebPageContent: async (url: string): Promise<ApiResponse<{ title: string; content: string }>> => {
    if (isElectron()) {
      return window.halo.fetchWebPageContent(url)
    }
    return httpRequest('POST', '/api/skills/fetch-webpage', { url })
  },

  /**
   * 监听技能会话流式消息
   */
  onSkillConversationChunk: (callback: (data: { conversationId: string; chunk: any }) => void): (() => void) => {
    if (isElectron() && window.halo.onSkillConversationChunk) {
      return window.halo.onSkillConversationChunk(callback)
    }
    // 非 Electron 环境暂不支持流式
    return () => {}
  },

  // ===== Hyper Space (Multi-Agent Collaboration) =====

  /**
   * Create a Hyper Space with multiple agents
   */
  createHyperSpace: async (params: {
    name: string
    icon?: string
    agents: any[]
    orchestration?: any
    customPath?: string
    remoteServerId?: string
    remotePath?: string
    useSshTunnel?: boolean
  }): Promise<ApiResponse<{ space: any }>> => {
    if (isElectron()) {
      return window.halo.createHyperSpace(params)
    }
    return httpRequest('POST', '/api/hyper-space/create', params)
  },

  /**
   * Get Hyper Space team status
   */
  getHyperSpaceStatus: async (spaceId: string): Promise<ApiResponse<{
    status: string
    leader: { id: string; status: string }
    workers: Array<{ id: string; status: string; currentTaskId?: string }>
    pendingTasks: number
  }>> => {
    if (isElectron()) {
      return window.halo.getHyperSpaceStatus(spaceId)
    }
    return httpRequest('GET', `/api/hyper-space/${spaceId}/status`)
  },

  /**
   * Add agent to Hyper Space
   */
  addAgentToHyperSpace: async (spaceId: string, agent: any): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.addAgentToHyperSpace(spaceId, agent)
    }
    return httpRequest('POST', `/api/hyper-space/${spaceId}/agents`, { agent })
  },

  /**
   * Remove agent from Hyper Space
   */
  removeAgentFromHyperSpace: async (spaceId: string, agentId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.removeAgentFromHyperSpace(spaceId, agentId)
    }
    return httpRequest('DELETE', `/api/hyper-space/${spaceId}/agents/${agentId}`)
  },

  /**
   * Update Hyper Space orchestration config
   */
  updateHyperSpaceConfig: async (spaceId: string, config: any): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.updateHyperSpaceConfig(spaceId, config)
    }
    return httpRequest('PUT', `/api/hyper-space/${spaceId}/config`, { config })
  },

  /**
   * Get Hyper Space tasks for a conversation
   */
  getHyperSpaceTasks: async (conversationId: string): Promise<ApiResponse<{ tasks: any[] }>> => {
    if (isElectron()) {
      return window.halo.getHyperSpaceTasks(conversationId)
    }
    return httpRequest('GET', `/api/hyper-space/tasks/${conversationId}`)
  },

  /**
   * Get HyperSpace members for @ mention autocomplete
   */
  getHyperSpaceMembers: async (spaceId: string): Promise<ApiResponse<{
    members: Array<{
      id: string
      name: string
      role: 'leader' | 'worker'
      type: 'local' | 'remote'
      capabilities?: string[]
    }>
  }>> => {
    if (isElectron()) {
      return window.halo.getHyperSpaceMembers(spaceId)
    }
    return httpRequest('GET', `/api/hyper-space/${spaceId}/members`)
  },

  /**
   * Listen to Hyper Space progress events
   */
  onHyperSpaceProgress: (callback: (data: {
    spaceId: string
    conversationId: string
    taskId: string
    agentId: string
    delta: string
    timestamp: number
  }) => void): (() => void) => {
    return onEvent('agent:hyper-progress', callback)
  },
}

// Export type for the API
export type HaloApi = typeof api
