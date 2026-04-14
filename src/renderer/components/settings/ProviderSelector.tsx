/**
 * ProviderSelector - Blank custom API form
 * No presets - user fills in everything manually
 */

import { useState, useRef } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { ChevronDown, Eye, EyeOff, Loader2, RefreshCw, X } from 'lucide-react'
import type {
  AISource,
  AISourcesConfig,
  ModelOption,
  ProviderId
} from '../../types'
import { useTranslation } from '../../i18n'
import { api } from '../../api'

interface ProviderSelectorProps {
  aiSources: AISourcesConfig
  onSave: (source: AISource) => Promise<void>
  onCancel: () => void
  editingSourceId?: string | null
}

export function ProviderSelector({
  aiSources,
  onSave,
  onCancel,
  editingSourceId
}: ProviderSelectorProps) {
  const { t } = useTranslation()

  const editingSource = editingSourceId
    ? aiSources.sources.find(s => s.id === editingSourceId)
    : null

  // All blank - only prefill if editing
  const [sourceName, setSourceName] = useState(editingSource?.name || '')
  const [apiKey, setApiKey] = useState(editingSource?.apiKey || '')
  const [apiUrl, setApiUrl] = useState(editingSource?.apiUrl || '')
  const [model, setModel] = useState(editingSource?.model || '')
  const [contextWindow, setContextWindow] = useState<number | undefined>(
    editingSource?.contextWindow
  )

  const [showApiKey, setShowApiKey] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const [validationResult, setValidationResult] = useState<{
    valid: boolean
    message?: string
  } | null>(null)
  const [fetchedModels, setFetchedModels] = useState<ModelOption[]>(
    editingSource?.availableModels || []
  )
  const [modelSearchQuery, setModelSearchQuery] = useState('')
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const modelDropdownRef = useRef<HTMLDivElement>(null)

  // Close model dropdown on outside click
  useState(() => {
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false)
        setModelSearchQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  })

  // Fetch models from API
  const handleFetchModels = async () => {
    if (!apiKey || !apiUrl) {
      setValidationResult({ valid: false, message: t('Please enter API Key and URL first') })
      return
    }

    setIsFetchingModels(true)
    setValidationResult(null)

    try {
      const response = await api.fetchModels(apiKey, apiUrl)

      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to fetch models')
      }

      const { models } = response.data as { models: ModelOption[] }
      setFetchedModels(models)

      if (!model || !models.some(m => m.id === model)) {
        setModel(models[0]?.id || '')
      }

      setValidationResult({ valid: true, message: t('Found ${count} models').replace('${count}', String(models.length)) })
    } catch (error) {
      console.error('[ProviderSelector] Failed to fetch models:', error)
      setValidationResult({ valid: false, message: t('Failed to fetch models') })
    } finally {
      setIsFetchingModels(false)
    }
  }

  // Delete model from list
  const handleDeleteModel = (modelId: string) => {
    const newModels = fetchedModels.filter(m => m.id !== modelId)
    setFetchedModels(newModels)
    if (model === modelId && newModels.length > 0) {
      setModel(newModels[0].id)
    }
  }

  // Filter models by search
  const filteredModels = fetchedModels.filter(m => {
    if (!modelSearchQuery) return true
    const q = modelSearchQuery.toLowerCase()
    return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
  })

  // Handle save
  const handleSave = async () => {
    if (!apiKey) {
      setValidationResult({ valid: false, message: t('Please enter API Key') })
      return
    }
    if (!apiUrl) {
      setValidationResult({ valid: false, message: t('Please enter API URL') })
      return
    }
    if (!model) {
      setValidationResult({ valid: false, message: t('Please enter a model ID') })
      return
    }

    setIsValidating(true)
    setValidationResult(null)

    try {
      const availableModels: ModelOption[] = fetchedModels.length > 0
        ? fetchedModels
        : [{ id: model, name: model }]

      if (!availableModels.some(m => m.id === model)) {
        availableModels.unshift({ id: model, name: model })
      }

      const now = new Date().toISOString()

      const source: AISource = {
        id: editingSource?.id || uuidv4(),
        name: sourceName || t('Custom API'),
        provider: 'openai' as ProviderId,
        authType: 'api-key',
        apiUrl,
        apiKey,
        model,
        availableModels,
        contextWindow: contextWindow || undefined,
        createdAt: editingSource?.createdAt || now,
        updatedAt: now
      }

      await onSave(source)
    } catch (error) {
      console.error('[ProviderSelector] Save failed:', error)
      setValidationResult({ valid: false, message: t('Save failed') })
    } finally {
      setIsValidating(false)
    }
  }

  // Handle test connection
  const handleTestConnection = async () => {
    if (!apiKey) {
      setValidationResult({ valid: false, message: t('Please enter API Key') })
      return
    }

    setIsValidating(true)
    setValidationResult(null)

    try {
      const result = await api.validateApi(apiKey, apiUrl, 'openai', model)

      if (!result.success || !result.data?.valid) {
        setValidationResult({
          valid: false,
          message: result.data?.message || result.error || t('Connection failed')
        })
      } else {
        setValidationResult({ valid: true, message: t('Connection successful') })
      }
    } catch {
      setValidationResult({ valid: false, message: t('Connection failed') })
    } finally {
      setIsValidating(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Source Name */}
      <div>
        <label className="block text-sm font-medium text-muted-foreground mb-1">
          {t('Display Name')}
        </label>
        <input
          type="text"
          value={sourceName}
          onChange={(e) => setSourceName(e.target.value)}
          placeholder={t('e.g. My API')}
          className="w-full px-3 py-2 bg-input border border-border rounded-lg
                   text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>

      {/* API Key */}
      <div>
        <label className="block text-sm font-medium text-muted-foreground mb-1">
          API Key
        </label>
        <div className="relative">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            className="w-full px-3 py-2 pr-10 bg-input border border-border rounded-lg
                     text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <button
            onClick={() => setShowApiKey(!showApiKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
          >
            {showApiKey ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>
      </div>

      {/* API URL */}
      <div>
        <label className="block text-sm font-medium text-muted-foreground mb-1">
          API URL
        </label>
        <input
          type="text"
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          placeholder="https://your-api-server.com/v1"
          className="w-full px-3 py-2 bg-input border border-border rounded-lg
                   text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>

      {/* Model */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-sm font-medium text-muted-foreground">
            {t('Model')}
          </label>
          <button
            onClick={handleFetchModels}
            disabled={isFetchingModels || !apiKey || !apiUrl}
            className="flex items-center gap-1 text-sm text-primary hover:text-primary/80 disabled:opacity-50"
          >
            <RefreshCw size={14} className={isFetchingModels ? 'animate-spin' : ''} />
            {t('Fetch Models')}
          </button>
        </div>

        {fetchedModels.length > 0 ? (
          <div className="relative" ref={modelDropdownRef}>
            <button
              onClick={() => setShowModelDropdown(!showModelDropdown)}
              className="w-full flex items-center justify-between px-3 py-2 bg-input
                       border border-border rounded-lg text-foreground
                       hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <span className="truncate">{model || t('Select model')}</span>
              <ChevronDown size={18} className={`transition-transform shrink-0 ${showModelDropdown ? 'rotate-180' : ''}`} />
            </button>

            {showModelDropdown && (
              <div className="absolute z-50 w-full mt-1 bg-card border border-border
                            rounded-lg shadow-lg max-h-60 overflow-hidden">
                <div className="p-2 border-b border-border">
                  <input
                    type="text"
                    value={modelSearchQuery}
                    onChange={(e) => setModelSearchQuery(e.target.value)}
                    placeholder={t('Search models...')}
                    className="w-full px-3 py-1.5 text-sm bg-input border border-border
                             rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
                    autoFocus
                  />
                </div>

                <div className="max-h-48 overflow-y-auto">
                  {filteredModels.map(m => (
                    <div
                      key={m.id}
                      onClick={() => {
                        setModel(m.id)
                        setShowModelDropdown(false)
                        setModelSearchQuery('')
                      }}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary/80 cursor-pointer ${
                        model === m.id ? 'bg-primary/10' : ''
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-foreground truncate">{m.name}</div>
                        {m.name !== m.id && (
                          <div className="text-xs text-muted-foreground truncate">{m.id}</div>
                        )}
                      </div>
                      {fetchedModels.length > 1 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteModel(m.id) }}
                          className="p-1 text-muted-foreground hover:text-red-500 rounded transition-colors shrink-0"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                  {filteredModels.length === 0 && (
                    <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                      {t('No models found')}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={t('Enter model ID')}
            className="w-full px-3 py-2 bg-input border border-border rounded-lg
                     text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        )}
      </div>

      {/* Context Window */}
      <div>
        <label className="block text-sm font-medium text-muted-foreground mb-1">
          {t('Context Window (tokens)')}
        </label>
        <input
          type="number"
          value={contextWindow || ''}
          onChange={(e) => setContextWindow(e.target.value ? parseInt(e.target.value, 10) : undefined)}
          placeholder={t('e.g. 200000')}
          min={1024}
          step={1024}
          className="w-full px-3 py-2 bg-input border border-border rounded-lg
                   text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {t('Leave empty to use default (200K). Used for automatic compression threshold.')}
        </p>
      </div>

      {/* Validation Result */}
      {validationResult && (
        <div className={`flex items-center gap-2 p-2 rounded-lg ${
          validationResult.valid
            ? 'bg-green-500/10 text-green-600'
            : 'bg-red-500/10 text-red-600'
        }`}>
          <span className="text-sm">{validationResult.message}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <button
          onClick={onCancel}
          className="flex-1 px-4 py-2 bg-secondary text-muted-foreground hover:bg-secondary/80 hover:text-foreground rounded-lg transition-colors"
        >
          {t('Cancel')}
        </button>
        <button
          onClick={handleSave}
          disabled={isValidating || !apiKey || !apiUrl}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg
                   hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isValidating && <Loader2 size={16} className="animate-spin" />}
          {editingSource ? t('Update') : t('Save')}
        </button>
      </div>
      <div className="flex justify-end pt-1">
        <button
          onClick={handleTestConnection}
          disabled={isValidating || !apiKey}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {t('Test connection')}
        </button>
      </div>
    </div>
  )
}
