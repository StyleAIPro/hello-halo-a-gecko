/**
 * useAISources - CRUD orchestration for AI source management
 *
 * Encapsulates the add/update/delete/switch operations and UI state
 * (add form, editing, deleting confirmation, expand/collapse).
 */

import { useState, useCallback } from 'react'
import type { AISource, AISourcesConfig, AicoBotConfig } from '../types'
import { getBuiltinProvider } from '../types'
import { api } from '../api'

interface UseAISourcesOptions {
  config: AicoBotConfig
  setConfig: (config: AicoBotConfig) => void
}

interface UseAISourcesResult {
  aiSources: AISourcesConfig
  currentSource: AISource | undefined
  showAddForm: boolean
  editingSourceId: string | null
  deletingSourceId: string | null
  expandedSourceId: string | null
  reloadConfig: () => Promise<void>
  switchSource: (sourceId: string) => Promise<void>
  saveSource: (source: AISource) => Promise<void>
  deleteSource: (sourceId: string) => Promise<void>
  openAddForm: () => void
  cancelForm: () => void
  setEditingSourceId: (id: string | null) => void
  setDeletingSourceId: (id: string | null) => void
  setExpandedSourceId: (id: string | null) => void
  getSourceDisplayInfo: (source: AISource) => { name: string; icon: string; description: string }
}

export function useAISources({ config, setConfig }: UseAISourcesOptions): UseAISourcesResult {
  const aiSources: AISourcesConfig = config.aiSources || {
    version: 2,
    currentId: null,
    sources: []
  }

  const [showAddForm, setShowAddForm] = useState(false)
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null)
  const [deletingSourceId, setDeletingSourceId] = useState<string | null>(null)
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null)

  const currentSource = aiSources.sources.find(s => s.id === aiSources.currentId)

  const reloadConfig = useCallback(async () => {
    const result = await api.getConfig()
    if (result.success && result.data) {
      setConfig(result.data as AicoBotConfig)
    }
  }, [setConfig])

  const switchSource = useCallback(async (sourceId: string) => {
    const result = await api.aiSourcesSwitchSource(sourceId)
    if (result.success && result.data) {
      setConfig(prev => ({ ...prev, aiSources: result.data as AISourcesConfig }))
    }
  }, [setConfig])

  const saveSource = useCallback(async (source: AISource) => {
    const sources = config.aiSources?.sources || []
    const existingIndex = sources.findIndex(s => s.id === source.id)

    // Add or update atomically (backend reads from disk, preserves tokens)
    const saveResult = existingIndex >= 0
      ? await api.aiSourcesUpdateSource(source.id, source)
      : await api.aiSourcesAddSource(source)

    if (!saveResult.success) {
      console.error('[useAISources] Failed to save source:', saveResult.error)
      return
    }

    // Switch to saved source as current
    const switchResult = await api.aiSourcesSwitchSource(source.id)
    if (switchResult.success && switchResult.data) {
      setConfig(prev => ({
        ...prev,
        aiSources: switchResult.data as AISourcesConfig,
        isFirstLaunch: false
      }))
    }

    await api.setConfig({ isFirstLaunch: false })
    setShowAddForm(false)
    setEditingSourceId(null)
  }, [config, setConfig])

  const deleteSource = useCallback(async (sourceId: string) => {
    const result = await api.aiSourcesDeleteSource(sourceId)
    if (result.success && result.data) {
      setConfig(prev => ({ ...prev, aiSources: result.data as AISourcesConfig }))
    }
    setDeletingSourceId(null)
  }, [setConfig])

  const openAddForm = useCallback(() => {
    setShowAddForm(true)
    setEditingSourceId(null)
  }, [])

  const cancelForm = useCallback(() => {
    setShowAddForm(false)
    setEditingSourceId(null)
  }, [])

  const getSourceDisplayInfo = (source: AISource) => {
    const builtin = getBuiltinProvider(source.provider)
    return {
      name: source.name || builtin?.name || source.provider,
      icon: builtin?.icon || 'key',
      description: builtin?.description || ''
    }
  }

  return {
    aiSources,
    currentSource,
    showAddForm,
    editingSourceId,
    deletingSourceId,
    expandedSourceId,
    reloadConfig,
    switchSource,
    saveSource,
    deleteSource,
    openAddForm,
    cancelForm,
    setEditingSourceId,
    setDeletingSourceId,
    setExpandedSourceId,
    getSourceDisplayInfo
  }
}
