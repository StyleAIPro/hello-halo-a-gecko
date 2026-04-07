/**
 * AISourcesSection - AI Sources Management Component (v2)
 *
 * Manages the list of configured AI sources using the v2 data structure.
 * Displays current sources, allows switching, adding, editing, and deleting.
 *
 * Features:
 * - List of configured sources with status indicators
 * - Quick switch between sources
 * - Add new source via ProviderSelector
 * - Edit existing source configuration
 * - Delete source with confirmation
 */

import { useState } from 'react'
import {
  Plus, Check, ChevronRight, Edit2, Trash2, Key
} from 'lucide-react'
import type {
  AISource,
  AISourcesConfig,
  AicoBotConfig
} from '../../types'
import { getBuiltinProvider } from '../../types'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { ProviderSelector } from './ProviderSelector'

interface AISourcesSectionProps {
  config: AicoBotConfig
  setConfig: (config: AicoBotConfig) => void
}

export function AISourcesSection({ config, setConfig }: AISourcesSectionProps) {
  const { t } = useTranslation()

  // Get v2 aiSources
  const aiSources: AISourcesConfig = config.aiSources || {
    version: 2,
    currentId: null,
    sources: []
  }

  // State
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null)
  const [deletingSourceId, setDeletingSourceId] = useState<string | null>(null)
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null)

  // Reload config from backend
  const reloadConfig = async () => {
    const result = await api.getConfig()
    if (result.success && result.data) {
      setConfig(result.data as AicoBotConfig)
    }
  }

  // Get current source
  const currentSource = aiSources.sources.find(s => s.id === aiSources.currentId)

  // Handle switch source (atomic: backend reads latest tokens from disk)
  const handleSwitchSource = async (sourceId: string) => {
    const result = await api.aiSourcesSwitchSource(sourceId)
    if (result.success && result.data) {
      setConfig({ ...config, aiSources: result.data as AISourcesConfig })
    }
  }

  // Handle save source (add or update)
  const handleSaveSource = async (source: AISource) => {
    const existingIndex = aiSources.sources.findIndex(s => s.id === source.id)

    // Add or update source atomically (backend reads from disk, preserves tokens)
    const saveResult = existingIndex >= 0
      ? await api.aiSourcesUpdateSource(source.id, source)
      : await api.aiSourcesAddSource(source)

    if (!saveResult.success) {
      console.error('[AISourcesSection] Failed to save source:', saveResult.error)
      return
    }

    // Switch to saved source as current, get latest data from disk
    const switchResult = await api.aiSourcesSwitchSource(source.id)
    if (switchResult.success && switchResult.data) {
      setConfig({ ...config, aiSources: switchResult.data as AISourcesConfig, isFirstLaunch: false })
    }

    // Persist isFirstLaunch flag (no aiSources in payload, safe)
    await api.setConfig({ isFirstLaunch: false })

    setShowAddForm(false)
    setEditingSourceId(null)
  }

  // Handle delete source
  const handleDeleteSource = async (sourceId: string) => {
    const result = await api.aiSourcesDeleteSource(sourceId)
    if (result.success && result.data) {
      setConfig({ ...config, aiSources: result.data as AISourcesConfig })
    }
    setDeletingSourceId(null)
  }

  // Get display info for a source
  const getSourceDisplayInfo = (source: AISource) => {
    const builtin = getBuiltinProvider(source.provider)
    return {
      name: source.name || builtin?.name || source.provider,
      icon: builtin?.icon || 'key',
      description: builtin?.description || ''
    }
  }

  // Render source card
  const renderSourceCard = (source: AISource) => {
    const isCurrent = source.id === aiSources.currentId
    const isExpanded = expandedSourceId === source.id
    const displayInfo = getSourceDisplayInfo(source)

    return (
      <div
        key={source.id}
        className={`border rounded-lg transition-all ${
          isCurrent
            ? 'border-primary bg-primary/5'
            : 'border-border-primary bg-surface-secondary'
        }`}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 p-3 cursor-pointer"
          onClick={() => setExpandedSourceId(isExpanded ? null : source.id)}
        >
          {/* Radio button for selection */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              if (!isCurrent) handleSwitchSource(source.id)
            }}
            className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
              isCurrent
                ? 'border-primary bg-primary'
                : 'border-border-secondary hover:border-primary'
            }`}
          >
            {isCurrent && <Check size={12} className="text-white" />}
          </button>

          {/* Icon */}
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
            isCurrent ? 'bg-primary/20' : 'bg-surface-tertiary'
          }`}>
            <Key size={18} className="text-text-secondary" />
          </div>

          {/* Name & Model */}
          <div className="flex-1 min-w-0">
            <div className="font-medium text-text-primary truncate">
              {displayInfo.name}
            </div>
            <div className="text-xs text-text-tertiary truncate">
              {source.model || t('No model selected')}
            </div>
          </div>

          {/* Expand arrow */}
          <ChevronRight
            size={18}
            className={`text-text-tertiary transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          />
        </div>

        {/* Expanded details */}
        {isExpanded && (
          <div className="px-3 pb-3 pt-0 border-t border-border-secondary">
            <div className="pt-3 space-y-2">
              {/* Provider */}
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">{t('Provider')}</span>
                <span className="text-text-primary">{source.provider}</span>
              </div>

              {/* API URL */}
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">{t('API URL')}</span>
                <span className="text-text-primary truncate max-w-[200px]">
                  {source.apiUrl}
                </span>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => setEditingSourceId(source.id)}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm text-text-secondary
                           bg-surface-tertiary hover:bg-surface-primary rounded-md transition-colors"
                >
                  <Edit2 size={14} />
                  {t('Edit')}
                </button>
                <button
                  onClick={() => setDeletingSourceId(source.id)}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm text-red-500
                           bg-red-500/10 hover:bg-red-500/20 rounded-md transition-colors"
                >
                  <Trash2 size={14} />
                  {t('Delete')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // Show add/edit form
  if (showAddForm || editingSourceId) {
    return (
      <div className="space-y-4">
        <h3 className="font-medium text-text-primary">
          {editingSourceId ? t('Edit Provider') : t('Add AI Provider')}
        </h3>
        <ProviderSelector
          aiSources={aiSources}
          onSave={handleSaveSource}
          onCancel={() => {
            setShowAddForm(false)
            setEditingSourceId(null)
          }}
          editingSourceId={editingSourceId}
        />
      </div>
    )
  }

  // Show delete confirmation
  if (deletingSourceId) {
    const sourceToDelete = aiSources.sources.find(s => s.id === deletingSourceId)
    return (
      <div className="p-4 bg-surface-secondary rounded-lg border border-border-primary space-y-4">
        <h3 className="font-medium text-text-primary">{t('Confirm Delete')}</h3>
        <p className="text-text-secondary">
          {t('Are you sure you want to delete')} <strong>{sourceToDelete?.name}</strong>?
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => setDeletingSourceId(null)}
            className="flex-1 px-4 py-2 text-text-secondary hover:bg-surface-tertiary rounded-md"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={() => handleDeleteSource(deletingSourceId)}
            className="flex-1 px-4 py-2 bg-red-500 text-white rounded-md hover:bg-red-600"
          >
            {t('Delete')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Sources List */}
      {aiSources.sources.length > 0 ? (
        <div className="space-y-2">
          {aiSources.sources.map(renderSourceCard)}
        </div>
      ) : (
        <div className="p-6 text-center text-text-tertiary bg-surface-secondary rounded-lg border border-border-primary">
          {t('No AI sources configured')}
        </div>
      )}

      {/* Add Source Button */}
      <button
        onClick={() => setShowAddForm(true)}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed
                 border-border-secondary hover:border-primary text-text-secondary hover:text-primary
                 rounded-lg transition-colors"
      >
        <Plus size={18} />
        {t('Add AI Provider')}
      </button>
    </div>
  )
}
