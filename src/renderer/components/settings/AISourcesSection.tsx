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
 * - Dynamic OAuth provider support (configured via product.json)
 */

import { useState, useEffect } from 'react'
import {
  Plus, Check, ChevronDown, ChevronRight, Edit2, Trash2, LogOut, Loader2, Key, Globe,
  LogIn, User, Cloud, Server, Shield, Lock, Zap, MessageSquare, Wrench, Github,
  type LucideIcon
} from 'lucide-react'
import type {
  AISource,
  AISourcesConfig,
  HaloConfig,
  ProviderId
} from '../../types'
import { getBuiltinProvider, isOAuthProvider as isOAuthProviderFn } from '../../types'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { api } from '../../api'
import { ProviderSelector } from './ProviderSelector'
import { resolveLocalizedText, type LocalizedText } from '../../../shared/types'

// ============================================================================
// Types for dynamic OAuth providers (from product.json)
// ============================================================================

/**
 * Provider configuration from backend (product.json)
 */
interface AuthProviderConfig {
  type: string
  displayName: LocalizedText
  description: LocalizedText
  icon: string
  iconBgColor: string
  recommended: boolean
  enabled: boolean
  builtin?: boolean
}

// ============================================================================
// Helper functions for dynamic providers
// ============================================================================

function getLocalizedText(value: LocalizedText): string {
  return resolveLocalizedText(value, getCurrentLanguage())
}

/**
 * Map icon names to Lucide components
 */
const iconMap: Record<string, LucideIcon> = {
  'log-in': LogIn,
  'user': User,
  'globe': Globe,
  'key': Key,
  'cloud': Cloud,
  'server': Server,
  'shield': Shield,
  'lock': Lock,
  'zap': Zap,
  'message-square': MessageSquare,
  'wrench': Wrench,
  'github': Github
}

/**
 * Get icon component by name
 */
function getIconComponent(iconName: string): LucideIcon {
  return iconMap[iconName] || Globe
}

/**
 * Convert hex color to RGBA with opacity
 */
function hexToRgba(hex: string, alpha: number = 0.15): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return `rgba(128, 128, 128, ${alpha})`
  return `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`
}

interface AISourcesSectionProps {
  config: HaloConfig
  setConfig: (config: HaloConfig) => void
}

// OAuth login state
interface OAuthLoginState {
  provider: string
  status: string
  userCode?: string
  verificationUri?: string
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

  // OAuth state
  const [loginState, setLoginState] = useState<OAuthLoginState | null>(null)
  const [loggingOutSourceId, setLoggingOutSourceId] = useState<string | null>(null)

  // Dynamic OAuth providers from product.json
  const [oauthProviders, setOAuthProviders] = useState<AuthProviderConfig[]>([])

  // Fetch available OAuth providers on mount
  useEffect(() => {
    const fetchProviders = async () => {
      try {
        const result = await api.authGetProviders()
        if (result.success && result.data) {
          // Filter to get only OAuth providers (exclude 'custom' which is API Key based)
          // Note: 'builtin' means the provider code is bundled in the app, not that it's not OAuth
          // Both external and builtin OAuth providers should be shown here
          const providers = (result.data as AuthProviderConfig[])
            .filter(p => p.type !== 'custom')
          setOAuthProviders(providers)
        }
      } catch (error) {
        console.error('[AISourcesSection] Failed to fetch auth providers:', error)
      }
    }
    fetchProviders()
  }, [])

  // Listen for OAuth login progress
  useEffect(() => {
    const unsubscribe = api.onAuthLoginProgress((data: { provider: string; status: string }) => {
      setLoginState(data)
      if (data.status === 'completed' || data.status === 'failed') {
        setTimeout(() => {
          reloadConfig()
          setLoginState(null)
        }, 500)
      }
    })
    return () => unsubscribe()
  }, [])

  // Reload config from backend
  const reloadConfig = async () => {
    const result = await api.getConfig()
    if (result.success && result.data) {
      setConfig(result.data as HaloConfig)
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

  // Handle OAuth login
  const handleOAuthLogin = async (providerType: ProviderId) => {
    try {
      setLoginState({ provider: providerType, status: t('Starting login...') })

      const result = await api.authStartLogin(providerType)
      if (!result.success) {
        console.error('[AISourcesSection] OAuth login start failed:', result.error)
        setLoginState(null)
        return
      }

      const { state, userCode, verificationUri } = result.data as {
        loginUrl: string
        state: string
        userCode?: string
        verificationUri?: string
      }

      setLoginState({
        provider: providerType,
        status: userCode ? t('Enter the code in your browser') : t('Waiting for login...'),
        userCode,
        verificationUri
      })

      const completeResult = await api.authCompleteLogin(providerType, state)
      if (!completeResult.success) {
        console.error('[AISourcesSection] OAuth login complete failed:', completeResult.error)
        setLoginState(null)
        return
      }

      // Success - reload config
      await reloadConfig()
      setLoginState(null)
    } catch (err) {
      console.error('[AISourcesSection] OAuth login error:', err)
      setLoginState(null)
    }
  }

  // Handle OAuth logout
  const handleOAuthLogout = async (sourceId: string) => {
    try {
      setLoggingOutSourceId(sourceId)
      await api.authLogout(sourceId)
      await reloadConfig()
    } catch (err) {
      console.error('[AISourcesSection] OAuth logout error:', err)
    } finally {
      setLoggingOutSourceId(null)
    }
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
    const isOAuth = source.authType === 'oauth'

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
            {isOAuth ? (
              <Globe size={18} className="text-text-secondary" />
            ) : (
              <Key size={18} className="text-text-secondary" />
            )}
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

          {/* User info for OAuth */}
          {isOAuth && source.user?.name && (
            <span className="text-xs text-text-secondary px-2 py-1 bg-surface-tertiary rounded">
              {source.user.name}
            </span>
          )}

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

              {/* Auth Type */}
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">{t('Auth Type')}</span>
                <span className="text-text-primary">
                  {isOAuth ? 'OAuth' : 'API Key'}
                </span>
              </div>

              {/* API URL (non-OAuth only) */}
              {!isOAuth && (
                <div className="flex justify-between text-sm">
                  <span className="text-text-secondary">{t('API URL')}</span>
                  <span className="text-text-primary truncate max-w-[200px]">
                    {source.apiUrl}
                  </span>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-2">
                {isOAuth ? (
                  // OAuth: only logout
                  <button
                    onClick={() => handleOAuthLogout(source.id)}
                    disabled={loggingOutSourceId === source.id}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm text-red-500
                             bg-red-500/10 hover:bg-red-500/20 rounded-md transition-colors"
                  >
                    {loggingOutSourceId === source.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <LogOut size={14} />
                    )}
                    {t('Logout')}
                  </button>
                ) : (
                  // API Key: edit and delete
                  <>
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
                  </>
                )}
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

  // Show OAuth login state
  if (loginState) {
    return (
      <div className="p-4 bg-surface-secondary rounded-lg border border-border-primary space-y-4">
        <div className="flex items-center gap-3">
          <Loader2 size={20} className="animate-spin text-primary" />
          <span className="text-text-primary">{loginState.status}</span>
        </div>
        {loginState.userCode && (
          <div className="p-3 bg-surface-tertiary rounded-md text-center">
            <p className="text-sm text-text-secondary mb-2">{t('Your code')}:</p>
            <p className="text-2xl font-mono font-bold text-primary">{loginState.userCode}</p>
            {loginState.verificationUri && (
              <a
                href={loginState.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline mt-2 block"
              >
                {t('Open verification page')}
              </a>
            )}
          </div>
        )}
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

      {/* Dynamic OAuth Providers (from product.json) */}
      {(() => {
        // Filter out providers that are already logged in
        const availableOAuthProviders = oauthProviders.filter(
          provider => !aiSources.sources.some(s => s.provider === provider.type)
        )

        if (availableOAuthProviders.length === 0) return null

        return (
          <div className="pt-4 border-t border-border-secondary">
            <h4 className="text-sm font-medium text-text-secondary mb-3">
              {t('OAuth Login')}
            </h4>
            <div className="space-y-2">
              {availableOAuthProviders.map(provider => {
                const IconComponent = getIconComponent(provider.icon)
                return (
                  <button
                    key={provider.type}
                    onClick={() => handleOAuthLogin(provider.type as ProviderId)}
                    className="flex items-center gap-3 w-full p-3 bg-surface-secondary hover:bg-surface-tertiary
                             border border-border-primary rounded-lg transition-colors"
                  >
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center"
                      style={{ backgroundColor: provider.iconBgColor }}
                    >
                      <IconComponent size={20} className="text-white" />
                    </div>
                    <div className="flex-1 text-left">
                      <div className="font-medium text-text-primary">
                        {getLocalizedText(provider.displayName)}
                      </div>
                      <div className="text-xs text-text-secondary">
                        {getLocalizedText(provider.description)}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
