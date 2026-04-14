/**
 * API Setup - Completely blank custom API configuration
 * No presets, no defaults - user fills in everything
 */

import { useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useAppStore } from '../../stores/app.store'
import { api } from '../../api'
import { Globe, ChevronDown, ArrowLeft, Eye, EyeOff, Loader2, RefreshCw } from 'lucide-react'
import type { AISourcesConfig, AISource } from '../../types'
import { useTranslation, setLanguage, getCurrentLanguage, SUPPORTED_LOCALES, type LocaleCode } from '../../i18n'

interface ApiSetupProps {
  onBack?: () => void
  showBack?: boolean
}

export function ApiSetup({ onBack, showBack = false }: ApiSetupProps) {
  const { t } = useTranslation()
  const { config, setConfig, setView } = useAppStore()

  // All blank - no defaults
  const [apiUrl, setApiUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [isValidating, setIsValidating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [validationResult, setValidationResult] = useState<{
    valid: boolean
    message?: string
  } | null>(null)
  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const [isLangDropdownOpen, setIsLangDropdownOpen] = useState(false)
  const [currentLang, setCurrentLang] = useState<LocaleCode>(getCurrentLanguage())
  const [showApiKey, setShowApiKey] = useState(false)
  const [useModelList, setUseModelList] = useState(false)

  const handleLanguageChange = (lang: LocaleCode) => {
    setLanguage(lang)
    setCurrentLang(lang)
    setIsLangDropdownOpen(false)
  }

  const fetchModels = async () => {
    if (!apiUrl) {
      setError(t('Please enter API URL first'))
      return
    }
    if (!apiKey) {
      setError(t('Please enter API Key first'))
      return
    }

    setIsFetchingModels(true)
    setError(null)

    try {
      let baseUrl = apiUrl
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1)
      if (baseUrl.endsWith('/chat/completions')) {
        baseUrl = baseUrl.replace(/\/chat\/completions$/, '')
      }

      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch models (${response.status})`)
      }

      const data = await response.json()

      if (data.data && Array.isArray(data.data)) {
        const models = data.data
          .map((m: any) => m.id)
          .filter((id: any) => typeof id === 'string')
          .sort()

        if (models.length === 0) {
          throw new Error('No models found')
        }

        setFetchedModels(models)

        if (!model) {
          setModel(models[0])
        }
      } else {
        throw new Error('Invalid response format')
      }
    } catch {
      setError(t('Failed to fetch models. Check URL and Key.'))
    } finally {
      setIsFetchingModels(false)
    }
  }

  const handleSaveAndEnter = async () => {
    if (!apiKey.trim()) {
      setError(t('Please enter API Key'))
      return
    }
    if (!apiUrl.trim()) {
      setError(t('Please enter API URL'))
      return
    }

    setError(null)

    try {
      const now = new Date().toISOString()

      const newSource: AISource = {
        id: uuidv4(),
        name: t('Custom API'),
        provider: 'openai',
        authType: 'api-key',
        apiUrl,
        apiKey,
        model,
        availableModels: fetchedModels.length > 0
          ? fetchedModels.map(id => ({ id, name: id }))
          : [{ id: model || 'default', name: model || 'Default' }],
        createdAt: now,
        updatedAt: now
      }

      const newConfig = {
        ...config,
        api: {
          provider: 'openai',
          apiKey,
          apiUrl,
          model,
          availableModels: fetchedModels
        },
        aiSources: {
          version: 2,
          currentId: newSource.id,
          sources: [newSource]
        } as AISourcesConfig,
        isFirstLaunch: false
      }

      await api.setConfig(newConfig)
      setConfig(newConfig as any)
      setView('home')
    } catch {
      setError(t('Save failed'))
    }
  }

  const handleTestConnection = async () => {
    if (!apiKey.trim()) {
      setError(t('Please enter API Key'))
      return
    }

    setIsValidating(true)
    setError(null)
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
      setValidationResult({
        valid: false,
        message: t('Connection failed')
      })
    } finally {
      setIsValidating(false)
    }
  }

  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-background p-8 relative overflow-auto">
      {/* Language Selector */}
      <div className="absolute top-6 right-6">
        <div className="relative">
          <button
            onClick={() => setIsLangDropdownOpen(!isLangDropdownOpen)}
            className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 rounded-lg transition-colors"
          >
            <Globe className="w-4 h-4" />
            <span>{SUPPORTED_LOCALES[currentLang]}</span>
            <ChevronDown className={`w-4 h-4 transition-transform ${isLangDropdownOpen ? 'rotate-180' : ''}`} />
          </button>

          {isLangDropdownOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setIsLangDropdownOpen(false)}
              />
              <div className="absolute right-0 mt-1 py-1 w-40 bg-card border border-border rounded-lg shadow-lg z-20">
                {Object.entries(SUPPORTED_LOCALES).map(([code, name]) => (
                  <button
                    key={code}
                    onClick={() => handleLanguageChange(code as LocaleCode)}
                    className={`w-full px-4 py-2 text-left text-sm hover:bg-secondary/80 transition-colors ${currentLang === code ? 'text-primary font-medium' : 'text-foreground'
                      }`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Header */}
      <div className="flex flex-col items-center mb-8">
        <div className="w-16 h-16 rounded-full border-2 border-primary/60 flex items-center justify-center aico-bot-glow">
          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary/30 to-transparent" />
        </div>
        <h1 className="mt-4 text-2xl font-light">AICO-Bot</h1>
      </div>

      {/* Form */}
      <div className="w-full max-w-md">
        <div className="relative mb-6">
          {showBack && onBack && (
            <button
              onClick={onBack}
              className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center gap-1.5 px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 rounded-lg transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
              <span>{t('Back')}</span>
            </button>
          )}
          <h2 className="text-center text-lg">
            {showBack ? t('Configure API') : t('Before you start, configure your AI')}
          </h2>
        </div>

        <div className="bg-card rounded-xl p-6 border border-border space-y-4">
          {/* API Key */}
          <div>
            <label className="block text-sm text-muted-foreground mb-2">API Key</label>
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-xxxxxxxxxxxxx"
                className="w-full px-4 py-2 pr-12 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* API URL */}
          <div>
            <label className="block text-sm text-muted-foreground mb-2">{t('API URL')}</label>
            <input
              type="text"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://your-api-server.com/v1"
              className="w-full px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
            />
          </div>

          {/* Model */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm text-muted-foreground">{t('Model')}</label>
              <button
                onClick={fetchModels}
                disabled={isFetchingModels || !apiKey || !apiUrl}
                className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${isFetchingModels ? 'animate-spin' : ''}`} />
                {t('Fetch Models')}
              </button>
            </div>

            {useModelList && fetchedModels.length > 0 ? (
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
              >
                {fetchedModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={t('Enter model ID')}
                className="w-full px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
              />
            )}
            {fetchedModels.length > 0 && (
              <label className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={useModelList}
                  onChange={(e) => {
                    setUseModelList(e.target.checked)
                    if (e.target.checked && !model && fetchedModels.length > 0) {
                      setModel(fetchedModels[0])
                    }
                  }}
                  className="w-3 h-3 rounded border-border"
                />
                {t('Select from fetched models')}
              </label>
            )}
          </div>
        </div>

        {/* Error */}
        {error && (
          <p className="text-center mt-4 text-sm text-red-500">{error}</p>
        )}

        {/* Validation result */}
        {validationResult && (
          <div className={`mt-4 p-3 rounded-lg ${validationResult.valid ? 'bg-green-500/10 border border-green-500/30' : 'bg-red-500/10 border border-red-500/30'}`}>
            <p className={`text-sm ${validationResult.valid ? 'text-green-500' : 'text-red-500'}`}>
              {validationResult.message}
            </p>
          </div>
        )}

        {/* Buttons */}
        <div className="mt-6 flex gap-3">
          <button
            onClick={handleTestConnection}
            disabled={isValidating}
            className="px-4 py-3 bg-secondary text-foreground rounded-lg border border-border hover:bg-secondary/80 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isValidating && <Loader2 className="w-4 h-4 animate-spin" />}
            {isValidating ? t('Testing...') : t('Test connection')}
          </button>
          <button
            onClick={handleSaveAndEnter}
            disabled={isValidating}
            className="flex-1 px-8 py-3 bg-primary text-primary-foreground rounded-lg btn-primary disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {t('Save and enter')}
          </button>
        </div>
      </div>
    </div>
  )
}
