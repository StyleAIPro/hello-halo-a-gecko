/**
 * Skill Store - Zustand state management for Skill page
 */

import { create } from 'zustand'
import { api } from '../../api'
import type { InstalledSkill, RemoteSkillItem, SkillMarketSource, SkillLibraryConfig, SkillFileNode } from '../../../shared/skill/skill-types'

// ============================================
// Types
// ============================================

/**
 * Agent 消息
 */
export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  isStreaming?: boolean
}

/**
 * 对话分析结果
 */
export interface ConversationAnalysis {
  userIntent: {
    taskType: string
    primaryGoal: string
    keywords: string[]
  }
  toolPattern: {
    toolSequence: string[]
    successPattern: string
  }
  reusability: {
    score: number
    patterns: string[]
  }
}

/**
 * 相似技能
 */
export interface SimilarSkill {
  skill: InstalledSkill
  similarity: number
  matchReasons: string[]
  suggestedImprovements: string[]
}

// ============================================
// State Interface
// ============================================

interface SkillState {
  // 已安装的技能
  installedSkills: InstalledSkill[]
  loading: boolean
  error: string | null

  // 市场技能
  marketSkills: RemoteSkillItem[]
  marketLoading: boolean
  marketError: string | null

  // 市场源
  marketSources: SkillMarketSource[]

  // 技能库配置
  config: SkillLibraryConfig | null

  // 当前视图
  currentView: 'library' | 'market' | 'generator'
  searchQuery: string
  selectedSkillId: string | null

  // === 技能生成器状态 ===
  // 分析结果
  analysisResult: ConversationAnalysis | null
  analysisLoading: boolean
  analysisError: string | null
  // 相似技能
  similarSkills: SimilarSkill[]
  // 生成的技能配置
  generatedSkillSpec: {
    name: string
    description: string
    triggerCommand: string
    systemPrompt: string
  } | null

  // === Agent 会话状态 ===
  agentSessionId: string | null
  agentStatus: 'idle' | 'running' | 'complete' | 'error'
  agentMessages: AgentMessage[]
  agentPanelOpen: boolean
  agentError: string | null

  // Actions - 已安装技能
  loadInstalledSkills: () => Promise<void>
  toggleSkill: (skillId: string, enabled: boolean) => Promise<boolean>
  uninstallSkill: (skillId: string) => Promise<boolean>
  exportSkill: (skillId: string) => Promise<string | null>

  // Actions - 市场技能
  loadMarketSkills: () => Promise<void>
  searchMarketSkills: (query: string) => Promise<void>
  installFromMarket: (skillId: string) => Promise<boolean>

  // Actions - 市场源
  loadMarketSources: () => Promise<void>
  toggleMarketSource: (sourceId: string, enabled: boolean) => Promise<void>
  setActiveMarketSource: (sourceId: string) => Promise<void>
  addMarketSource: (source: { name: string; url: string; repos?: string[]; description?: string }) => Promise<void>
  removeMarketSource: (sourceId: string) => Promise<void>
  getMarketSkillDetail: (skillId: string) => Promise<RemoteSkillItem | null>

  // Actions - 配置
  loadConfig: () => Promise<void>
  updateConfig: (config: Partial<SkillLibraryConfig>) => Promise<void>

  // Actions - UI
  setCurrentView: (view: 'library' | 'market' | 'generator') => void
  setSearchQuery: (query: string) => void
  setSelectedSkillId: (id: string | null) => void
  refreshSkills: () => Promise<void>

  // Actions - Remote sync
  syncSkillsToRemote: (serverId: string) => Promise<{ success: boolean; syncedCount: number; message: string }>

  // Actions - 文件操作
  loadSkillFiles: (skillId: string) => Promise<SkillFileNode[] | null>
  loadSkillFileContent: (skillId: string, filePath: string) => Promise<string | null>

  // Actions - 技能生成器
  analyzeConversations: (spaceId: string, conversationIds: string[]) => Promise<void>
  clearGeneratorState: () => void
  setGeneratedSkillSpec: (spec: SkillState['generatedSkillSpec']) => void

  // Actions - Agent 会话
  createAgentSession: (skillName: string, selectedConversations?: { id: string; title: string; spaceId: string; spaceName: string; updatedAt: string }[]) => Promise<boolean>
  sendAgentMessage: (message: string) => Promise<void>
  closeAgentSession: () => Promise<void>
  addAgentMessage: (message: AgentMessage) => void
  updateLastAgentMessage: (content: string, isStreaming?: boolean) => void
  setAgentStatus: (status: SkillState['agentStatus']) => void
  setAgentPanelOpen: (open: boolean) => void
  setAgentSessionId: (id: string | null) => void
}

// ============================================
// Initial State
// ============================================

const initialState = {
  installedSkills: [],
  loading: false,
  error: null,
  marketSkills: [],
  marketLoading: false,
  marketError: null,
  marketSources: [],
  config: null,
  currentView: 'library' as const,
  searchQuery: '',
  selectedSkillId: null,
  // 生成器状态
  analysisResult: null,
  analysisLoading: false,
  analysisError: null,
  similarSkills: [],
  generatedSkillSpec: null,
  // Agent 会话状态
  agentSessionId: null,
  agentStatus: 'idle' as const,
  agentMessages: [],
  agentPanelOpen: false,
  agentError: null,
}

// ============================================
// Store
// ============================================

export const useSkillStore = create<SkillState>((set, get) => ({
  ...initialState,

  // ==========================================
  // 已安装技能
  // ==========================================

  loadInstalledSkills: async () => {
    set({ loading: true, error: null })
    try {
      const result = await api.skillList()
      if (result.success) {
        set({ installedSkills: result.data || [], loading: false })
      } else {
        set({ error: result.error || 'Failed to load skills', loading: false })
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to load skills', loading: false })
    }
  },

  toggleSkill: async (skillId: string, enabled: boolean) => {
    try {
      const result = await api.skillToggle(skillId, enabled)
      if (result.success) {
        set((state) => ({
          installedSkills: state.installedSkills.map((skill) =>
            skill.appId === skillId ? { ...skill, enabled } : skill
          ),
        }))
        return true
      }
      return false
    } catch (error) {
      console.error('Failed to toggle skill:', error)
      return false
    }
  },

  uninstallSkill: async (skillId: string) => {
    try {
      const result = await api.skillUninstall(skillId)
      if (result.success) {
        set((state) => ({
          installedSkills: state.installedSkills.filter((skill) => skill.appId !== skillId),
          selectedSkillId: state.selectedSkillId === skillId ? null : state.selectedSkillId,
        }))
        return true
      }
      return false
    } catch (error) {
      console.error('Failed to uninstall skill:', error)
      return false
    }
  },

  exportSkill: async (skillId: string) => {
    try {
      const result = await api.skillExport(skillId)
      if (result.success) {
        return result.data || null
      }
      return null
    } catch (error) {
      console.error('Failed to export skill:', error)
      return null
    }
  },

  // ==========================================
  // 市场技能
  // ==========================================

  loadMarketSkills: async (sourceId?: string) => {
    set({ marketLoading: true, marketError: null })
    try {
      const result = await api.skillMarketList(sourceId)
      if (result.success) {
        set({ marketSkills: result.data || [], marketLoading: false })
      } else {
        set({ marketError: result.error || 'Failed to load market skills', marketLoading: false })
      }
    } catch (error) {
      set({ marketError: error instanceof Error ? error.message : 'Failed to load market skills', marketLoading: false })
    }
  },

  searchMarketSkills: async (query: string) => {
    if (!query.trim()) {
      get().loadMarketSkills()
      return
    }

    try {
      const result = await api.skillMarketSearch(query)
      if (result.success) {
        set({ marketSkills: result.data || [] })
      }
    } catch (error) {
      console.error('Failed to search skills:', error)
    }
  },

  installFromMarket: async (skillId: string) => {
    try {
      const result = await api.skillInstall({ mode: 'market', skillId })
      return result.success || false
    } catch (error) {
      console.error('Failed to install skill from market:', error)
      return false
    }
  },

  // ==========================================
  // 市场源
  // ==========================================

  loadMarketSources: async () => {
    try {
      const result = await api.skillMarketSources()
      if (result.success) {
        set({ marketSources: result.data || [] })
      }
    } catch (error) {
      console.error('Failed to load market sources:', error)
    }
  },

  toggleMarketSource: async (sourceId: string, enabled: boolean) => {
    try {
      await api.skillMarketToggleSource(sourceId, enabled)
      set((state) => ({
        marketSources: state.marketSources.map((source) =>
          source.id === sourceId ? { ...source, enabled } : source
        ),
      }))
    } catch (error) {
      console.error('Failed to toggle market source:', error)
    }
  },

  setActiveMarketSource: async (sourceId: string) => {
    try {
      await api.skillMarketSetActiveSource(sourceId)
    } catch (error) {
      console.error('Failed to set active market source:', error)
    }
  },

  addMarketSource: async (source: { name: string; url: string; repos?: string[]; description?: string }) => {
    try {
      const result = await api.skillMarketAddSource(source)
      if (result.success && result.data) {
        set((state) => ({
          marketSources: [...state.marketSources, result.data]
        }))
      }
    } catch (error) {
      console.error('Failed to add market source:', error)
    }
  },

  removeMarketSource: async (sourceId: string) => {
    try {
      await api.skillMarketRemoveSource(sourceId)
      set((state) => ({
        marketSources: state.marketSources.filter(s => s.id !== sourceId)
      }))
    } catch (error) {
      console.error('Failed to remove market source:', error)
    }
  },

  getMarketSkillDetail: async (skillId: string) => {
    try {
      const result = await api.skillMarketDetail(skillId)
      if (result.success) {
        return result.data || null
      }
      return null
    } catch (error) {
      console.error('Failed to get market skill detail:', error)
      return null
    }
  },

  // ==========================================
  // 配置
  // ==========================================

  loadConfig: async () => {
    try {
      const result = await api.skillConfigGet()
      if (result.success) {
        set({ config: result.data || null })
      }
    } catch (error) {
      console.error('Failed to load skill config:', error)
    }
  },

  updateConfig: async (config: Partial<SkillLibraryConfig>) => {
    try {
      await api.skillConfigUpdate(config)
      set((state) => ({
        config: state.config ? { ...state.config, ...config } : null,
      }))
    } catch (error) {
      console.error('Failed to update skill config:', error)
    }
  },

  // ==========================================
  // UI
  // ==========================================

  refreshSkills: async () => {
    try {
      await api.skillRefresh()
      await get().loadInstalledSkills()
    } catch (error) {
      console.error('Failed to refresh skills:', error)
    }
  },

  setCurrentView: (view) => set({ currentView: view }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSelectedSkillId: (id) => set({ selectedSkillId: id }),

  // ==========================================
  // 文件操作
  // ==========================================

  loadSkillFiles: async (skillId: string): Promise<SkillFileNode[] | null> => {
    try {
      const result = await api.skillFiles(skillId)
      if (result.success) {
        return result.data || null
      }
      return null
    } catch (error) {
      console.error('Failed to load skill files:', error)
      return null
    }
  },

  loadSkillFileContent: async (skillId: string, filePath: string): Promise<string | null> => {
    try {
      const result = await api.skillFileContent(skillId, filePath)
      if (result.success) {
        return result.data || null
      }
      return null
    } catch (error) {
      console.error('Failed to load skill file content:', error)
      return null
    }
  },

  // ==========================================
  // 技能生成器
  // ==========================================

  analyzeConversations: async (spaceId: string, conversationIds: string[]) => {
    set({ analysisLoading: true, analysisError: null })

    try {
      const result = await api.skillAnalyzeConversations(spaceId, conversationIds)

      if (result.success && result.data) {
        set({
          analysisResult: result.data.analysisResult,
          similarSkills: result.data.similarSkills || [],
          analysisLoading: false
        })
      } else {
        set({
          analysisError: result.error || 'Failed to analyze conversations',
          analysisLoading: false
        })
      }
    } catch (error) {
      set({
        analysisError: error instanceof Error ? error.message : 'Failed to analyze conversations',
        analysisLoading: false
      })
    }
  },

  clearGeneratorState: () => {
    set({
      analysisResult: null,
      analysisError: null,
      similarSkills: [],
      generatedSkillSpec: null,
      agentSessionId: null,
      agentStatus: 'idle',
      agentMessages: [],
      agentPanelOpen: false,
      agentError: null
    })
  },

  setGeneratedSkillSpec: (spec) => set({ generatedSkillSpec: spec }),

  // ==========================================
  // Agent 会话
  // ==========================================

  /**
   * 创建 Agent 会话（简化版：不需要先分析)
   */
  createAgentSession: async (skillName: string, selectedConversations?: { id: string; title: string; spaceId: string; spaceName: string; updatedAt: string }[])    => {
    try {
      // 验证参数
      if (!skillName || !skillName.trim()) {
        set({ agentError: 'Skill name is required' })
        return false
      }

      // 构建初始消息
      const conversationContext = selectedConversations && selectedConversations.length > 0
        ? selectedConversations.map(c => `[${c.spaceName}] ${c.title}`).join('\n\n')
        : '无对话历史'

      // 生成安全的触发命令
      const safeSkillName = (skillName || '').replace(/[^a-z0-9]/g, '') || 'skill'

      const initialPrompt = `请根据以下对话历史帮我创建一个技能：

## 对话历史:
${conversationContext}

## 要求:
1. 技能名称: ${skillName}
2. 触发命令: /${safeSkillName}

## 输出格式
请输出完整的 SKILL.yaml 文件内容，`

      // 创建会话
      const result = await api.skillCreateTempSession({
        skillName,
        context: {
          conversationAnalysis: null, // 暂时为空，          similarSkills: [],
          mode: 'create',
          initialPrompt // 添加初始 prompt
        }
      })

      if (result.success && result.data?.sessionId) {
        set({
          agentSessionId: result.data.sessionId,
          agentStatus: 'idle',
          agentPanelOpen: true,
          agentError: null,
          agentMessages: [{
            id: Date.now().toString(),
            role: 'user',
            content: initialPrompt,
            timestamp: new Date().toISOString()
          }]
        })
        return true
      } else {
        set({ agentError: result.error || 'Failed to create session' })
        return false
      }
    } catch (error) {
      set({ agentError: error instanceof Error ? error.message : 'Failed to create session' })
      return false
    }
  },

  sendAgentMessage: async (message: string) => {
    const { agentSessionId } = get()

    if (!agentSessionId) {
      set({ agentError: 'No active session' })
      return
    }

    // 添加用户消息
    const userMsg: AgentMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: message,
      timestamp: new Date().toISOString()
    }
    set((state) => ({ agentMessages: [...state.agentMessages, userMsg] }))

    // 添加占位的 assistant 消息
    const assistantMsgId = (Date.now() + 1).toString()
    const assistantMsg: AgentMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      isStreaming: true
    }
    set((state) => ({ agentMessages: [...state.agentMessages, assistantMsg], agentStatus: 'running' }))

    try {
      // 发送消息，流式响应会通过 handleChunk 回调处理
      const handleChunk = (data: { sessionId: string; chunk: any }) => {
        // 忽略不属于当前会话的消息
        if (data.sessionId !== agentSessionId) return

        const chunk = data.chunk

        // 处理不同类型的 chunk
        if (chunk.type === 'text' && chunk.content) {
          // 追加文本内容
          set((state) => {
            const messages = [...state.agentMessages]
            if (messages.length > 0) {
              const lastMsg = messages[messages.length - 1]
              if (lastMsg.role === 'assistant') {
                messages[messages.length - 1] = {
                  ...lastMsg,
                  content: lastMsg.content + chunk.content,
                  isStreaming: true
                }
              }
            }
            return { agentMessages: messages }
          })
        } else if (chunk.type === 'complete') {
          // 标记流式结束
          set((state) => {
            const messages = [...state.agentMessages]
            if (messages.length > 0) {
              const lastMsg = messages[messages.length - 1]
              if (lastMsg.role === 'assistant') {
                messages[messages.length - 1] = {
                  ...lastMsg,
                  isStreaming: false
                }
              }
            }
            return { agentStatus: 'complete' }
          })
        } else if (chunk.type === 'error') {
          set({
            agentError: chunk.content || 'Unknown error',
            agentStatus: 'error'
          })
        } else if (chunk.type === 'thinking' && chunk.content) {
          // 处理思考过程（可选显示）
          console.log('[SkillGenerator] Thinking:', chunk.content)
        } else if (chunk.type === 'tool_use' && chunk.toolName) {
          // 处理工具使用（显示给用户）
          set((state) => {
            const messages = [...state.agentMessages]
            if (messages.length > 0) {
              const lastMsg = messages[messages.length - 1]
              if (lastMsg.role === 'assistant') {
                const toolInfo = `\n[使用工具: ${chunk.toolName}]\n`
                messages[messages.length - 1] = {
                  ...lastMsg,
                  content: lastMsg.content + toolInfo,
                  isStreaming: true
                }
              }
            }
            return { agentMessages: messages }
          })
        }
      }

      // 注册一次性监听器（消息发送完成后自动清理）
      const cleanup = window.halo.onSkillTempMessageChunk(handleChunk)

      // 发送消息
      await api.skillSendTempMessage(agentSessionId, message)

      // 注意： cleanup 在这里不需要立即调用，因为流式响应可能还在继续
      // 可以在 closeAgentSession 中调用 cleanup
    } catch (error) {
      set({ agentError: error instanceof Error ? error.message : 'Failed to send message', agentStatus: 'error' })
    }
  },

  closeAgentSession: async () => {
    const { agentSessionId } = get()

    if (agentSessionId) {
      try {
        await api.skillCloseTempSession(agentSessionId)
      } catch (error) {
        console.error('Failed to close session:', error)
      }
    }

    set({
      agentSessionId: null,
      agentStatus: 'idle',
      agentMessages: [],
      agentError: null
    })
  },

  addAgentMessage: (message) => {
    set((state) => ({ agentMessages: [...state.agentMessages, message] }))
  },

  updateLastAgentMessage: (content, isStreaming = false) => {
    set((state) => {
      const messages = [...state.agentMessages]
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1]
        if (lastMsg.role === 'assistant') {
          messages[messages.length - 1] = {
            ...lastMsg,
            content: lastMsg.content + content,
            isStreaming
          }
        }
      }
      return { agentMessages: messages }
    })
  },

  setAgentStatus: (status) => set({ agentStatus: status }),
  setAgentPanelOpen: (open) => set({ agentPanelOpen: open }),
  setAgentSessionId: (id) => set({ agentSessionId: id }),

  // ==========================================
  // Remote sync
  // ==========================================

  syncSkillsToRemote: async (serverId: string) => {
    try {
      const result = await api.remoteServerSyncSkills(serverId)
      if (result.success && result.data) {
        return result.data
      }
      return { success: false, syncedCount: 0, message: result.error || 'Failed to sync skills' }
    } catch (error) {
      console.error('Failed to sync skills to remote:', error)
      return { success: false, syncedCount: 0, message: error instanceof Error ? error.message : 'Failed to sync skills' }
    }
  },
}))
