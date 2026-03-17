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
  currentView: 'library' | 'market' | 'editor'
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

  // Agent 面板状态（仅用于控制面板显示）
  agentPanelOpen: boolean

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
  setCurrentView: (view: 'library' | 'market' | 'editor') => void
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

  // Actions - Agent 面板
  setAgentPanelOpen: (open: boolean) => void
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
  // Agent 面板状态
  agentPanelOpen: false,
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
      agentPanelOpen: false
    })
  },

  setGeneratedSkillSpec: (spec) => set({ generatedSkillSpec: spec }),

  // ==========================================
  // Agent 面板
  // ==========================================

  setAgentPanelOpen: (open) => set({ agentPanelOpen: open }),

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
