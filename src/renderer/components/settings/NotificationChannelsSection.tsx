/**
 * Notification Channels Section Component
 * Manages external notification channel configurations (email, WeCom, DingTalk, Feishu, webhook)
 */

import { useState, useCallback, useRef } from 'react'
import {
  Mail, MessageSquare, Bell, Webhook, Loader2,
  CheckCircle, XCircle, ChevronDown
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { HaloConfig } from '../../types'
import { NOTIFICATION_CHANNEL_META } from '../../../shared/types/notification-channels'
import type {
  NotificationChannelType,
  NotificationChannelsConfig,
  EmailChannelConfig,
  WecomChannelConfig,
  DingtalkChannelConfig,
  FeishuChannelConfig,
  WebhookChannelConfig,
} from '../../../shared/types/notification-channels'

// ============================================
// Types
// ============================================

interface NotificationChannelsSectionProps {
  config: HaloConfig | null
  setConfig: (config: HaloConfig) => void
}

interface TestResult {
  success: boolean
  error?: string
}

/** Field descriptor for data-driven form rendering */
interface FieldDef {
  key: string
  label: string
  type: 'text' | 'password' | 'number' | 'toggle' | 'select'
  placeholder?: string
  required?: boolean
  options?: { value: string; label: string }[]
  nested?: string // dot-separated path for nested fields like "smtp.host"
}

/** Channel descriptor for data-driven rendering */
interface ChannelDef {
  type: NotificationChannelType
  icon: typeof Mail
  fields: FieldDef[]
  defaults: Record<string, unknown>
}

// ============================================
// Channel Definitions (data-driven)
// ============================================

const CHANNEL_ICONS: Record<NotificationChannelType, typeof Mail> = {
  email: Mail,
  wecom: MessageSquare,
  dingtalk: Bell,
  feishu: MessageSquare,
  webhook: Webhook,
}

function buildChannelDefs(): ChannelDef[] {
  return [
    {
      type: 'email',
      icon: CHANNEL_ICONS.email,
      fields: [
        { key: 'smtp.host', label: 'SMTP Host', type: 'text', placeholder: 'smtp.gmail.com', required: true, nested: 'smtp.host' },
        { key: 'smtp.port', label: 'SMTP Port', type: 'number', placeholder: '465', required: true, nested: 'smtp.port' },
        { key: 'smtp.secure', label: 'Use SSL/TLS', type: 'toggle', nested: 'smtp.secure' },
        { key: 'smtp.user', label: 'Username', type: 'text', placeholder: 'user@example.com', required: true, nested: 'smtp.user' },
        { key: 'smtp.password', label: 'Password', type: 'password', placeholder: 'App password', required: true, nested: 'smtp.password' },
        { key: 'defaultTo', label: 'Default Recipient', type: 'text', placeholder: 'recipient@example.com', required: true },
      ],
      defaults: { enabled: false, smtp: { host: '', port: 465, secure: true, user: '', password: '' }, defaultTo: '' },
    },
    {
      type: 'wecom',
      icon: CHANNEL_ICONS.wecom,
      fields: [
        { key: 'corpId', label: 'Corp ID', type: 'text', placeholder: 'ww...', required: true },
        { key: 'agentId', label: 'Agent ID', type: 'number', placeholder: '1000002', required: true },
        { key: 'secret', label: 'Secret', type: 'password', required: true },
        { key: 'defaultToUser', label: 'Default User ID', type: 'text', placeholder: 'userid (optional)' },
        { key: 'defaultToParty', label: 'Default Party ID', type: 'text', placeholder: 'party id (optional)' },
      ],
      defaults: { enabled: false, corpId: '', agentId: 0, secret: '', defaultToUser: '', defaultToParty: '' },
    },
    {
      type: 'dingtalk',
      icon: CHANNEL_ICONS.dingtalk,
      fields: [
        { key: 'appKey', label: 'App Key', type: 'text', required: true },
        { key: 'appSecret', label: 'App Secret', type: 'password', required: true },
        { key: 'agentId', label: 'Agent ID', type: 'number', placeholder: '0', required: true },
        { key: 'robotCode', label: 'Robot Code', type: 'text', placeholder: 'Robot code (optional)' },
        { key: 'defaultChatId', label: 'Default Chat ID', type: 'text', placeholder: 'Chat ID (optional)' },
      ],
      defaults: { enabled: false, appKey: '', appSecret: '', agentId: 0, robotCode: '', defaultChatId: '' },
    },
    {
      type: 'feishu',
      icon: CHANNEL_ICONS.feishu,
      fields: [
        { key: 'appId', label: 'App ID', type: 'text', required: true },
        { key: 'appSecret', label: 'App Secret', type: 'password', required: true },
        { key: 'defaultChatId', label: 'Default Chat ID', type: 'text', placeholder: 'Chat ID (optional)' },
        { key: 'defaultUserId', label: 'Default User ID', type: 'text', placeholder: 'User open_id (optional)' },
      ],
      defaults: { enabled: false, appId: '', appSecret: '', defaultChatId: '', defaultUserId: '' },
    },
    {
      type: 'webhook',
      icon: CHANNEL_ICONS.webhook,
      fields: [
        { key: 'url', label: 'URL', type: 'text', placeholder: 'https://example.com/webhook', required: true },
        {
          key: 'method', label: 'Method', type: 'select',
          options: [{ value: 'POST', label: 'POST' }, { value: 'PUT', label: 'PUT' }],
        },
        { key: 'headers', label: 'Headers (JSON)', type: 'text', placeholder: '{"Authorization": "Bearer ..."}' },
        { key: 'secret', label: 'HMAC Secret', type: 'password', placeholder: 'Signing secret (optional)' },
      ],
      defaults: { enabled: false, url: '', method: 'POST', headers: undefined, secret: '' },
    },
  ]
}

const CHANNEL_DEFS = buildChannelDefs()

// ============================================
// Helpers
// ============================================

/** Get a nested value from an object using dot-separated path */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** Set a nested value on an object using dot-separated path, returning a new object */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.')
  if (parts.length === 1) {
    return { ...obj, [parts[0]]: value }
  }
  const [head, ...rest] = parts
  const child = (obj[head] != null && typeof obj[head] === 'object') ? obj[head] as Record<string, unknown> : {}
  return { ...obj, [head]: setNestedValue(child, rest.join('.'), value) }
}

// ============================================
// Channel Card Sub-component
// ============================================

interface ChannelCardProps {
  def: ChannelDef
  channelConfig: Record<string, unknown>
  isExpanded: boolean
  onToggleExpand: () => void
  onSave: (channelType: string, channelConfig: Record<string, unknown>) => Promise<void>
  onTest: (channelType: string) => void
  isTesting: boolean
  testResult?: TestResult
}

function ChannelCard({
  def,
  channelConfig,
  isExpanded,
  onToggleExpand,
  onSave,
  onTest,
  isTesting,
  testResult,
}: ChannelCardProps) {
  const { t } = useTranslation()
  const meta = NOTIFICATION_CHANNEL_META[def.type]
  const Icon = def.icon
  const isEnabled = Boolean(channelConfig?.enabled)

  // Local draft state for debounced saves
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentConfig = draft ?? channelConfig

  const scheduleSave = useCallback((updated: Record<string, unknown>) => {
    setDraft(updated)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      onSave(def.type, updated)
      setDraft(null)
      saveTimerRef.current = null
    }, 500)
  }, [def.type, onSave])

  const handleToggleEnabled = async () => {
    const updated = { ...currentConfig, enabled: !isEnabled }
    // Toggle saves immediately (no debounce)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setDraft(null)
    await onSave(def.type, updated)
  }

  const handleFieldChange = (fieldKey: string, value: unknown, nested?: string) => {
    const path = nested || fieldKey
    const updated = setNestedValue({ ...currentConfig }, path, value)
    scheduleSave(updated)
  }

  const getFieldValue = (field: FieldDef): unknown => {
    const path = field.nested || field.key
    return getNestedValue(currentConfig || {}, path)
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Card Header */}
      <button
        type="button"
        onClick={onToggleExpand}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Icon className="w-5 h-5 text-muted-foreground" />
          <div className="text-left">
            <p className="font-medium text-sm">{t(meta.labelKey)}</p>
            <p className="text-xs text-muted-foreground">{t(meta.descriptionKey)}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Status dot */}
          <div className={`w-2 h-2 rounded-full ${isEnabled ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
          <ChevronDown
            className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
          />
        </div>
      </button>

      {/* Card Body */}
      {isExpanded && (
        <div className="px-4 pb-4 pt-2 border-t border-border space-y-4 animate-in slide-in-from-top-1 duration-150">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{t('Enabled')}</p>
              <p className="text-xs text-muted-foreground">{t('Enable this notification channel')}</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={isEnabled}
                onChange={handleToggleEnabled}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-secondary rounded-full peer peer-checked:bg-primary transition-colors">
                <div
                  className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform ${
                    isEnabled ? 'translate-x-5' : 'translate-x-0.5'
                  } mt-0.5`}
                />
              </div>
            </label>
          </div>

          {/* Channel fields */}
          <div className="space-y-3">
            {def.fields.map((field) => (
              <ChannelField
                key={field.key}
                field={field}
                value={getFieldValue(field)}
                onChange={(value) => handleFieldChange(field.key, value, field.nested)}
              />
            ))}
          </div>

          {/* Test button and result */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => onTest(def.type)}
              disabled={isTesting || !isEnabled}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary/10 text-primary hover:bg-primary/20 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isTesting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Bell className="w-4 h-4" />
              )}
              {isTesting ? t('Testing...') : t('Test')}
            </button>

            {testResult && (
              <div className={`flex items-center gap-1.5 text-sm ${testResult.success ? 'text-green-500' : 'text-red-500'}`}>
                {testResult.success ? (
                  <CheckCircle className="w-4 h-4" />
                ) : (
                  <XCircle className="w-4 h-4" />
                )}
                <span>
                  {testResult.success
                    ? t('Test passed')
                    : testResult.error || t('Test failed')}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================
// Field Renderer Sub-component
// ============================================

interface ChannelFieldProps {
  field: FieldDef
  value: unknown
  onChange: (value: unknown) => void
}

function ChannelField({ field, value, onChange }: ChannelFieldProps) {
  const { t } = useTranslation()

  if (field.type === 'toggle') {
    const checked = Boolean(value)
    return (
      <div className="flex items-center justify-between">
        <label className="text-sm text-muted-foreground">{t(field.label)}</label>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-secondary rounded-full peer peer-checked:bg-primary transition-colors">
            <div
              className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform ${
                checked ? 'translate-x-5' : 'translate-x-0.5'
              } mt-0.5`}
            />
          </div>
        </label>
      </div>
    )
  }

  if (field.type === 'select') {
    return (
      <div className="space-y-1">
        <label className="text-sm text-muted-foreground">{t(field.label)}</label>
        <select
          value={(value as string) || field.options?.[0]?.value || ''}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        >
          {field.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    )
  }

  // Text, password, number inputs
  const inputType = field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text'

  // For the headers field (JSON), display stringified value
  let displayValue: string
  if (field.key === 'headers' && typeof value === 'object' && value !== null) {
    displayValue = JSON.stringify(value)
  } else {
    displayValue = value != null ? String(value) : ''
  }

  const handleChange = (raw: string) => {
    if (field.type === 'number') {
      onChange(raw === '' ? 0 : Number(raw))
    } else if (field.key === 'headers') {
      // Store raw string while typing; parse on blur
      onChange(raw === '' ? undefined : raw)
    } else {
      onChange(raw)
    }
  }

  const handleBlur = () => {
    // For headers field, try to parse JSON on blur
    if (field.key === 'headers' && typeof value === 'string' && value.trim()) {
      try {
        const parsed = JSON.parse(value)
        onChange(parsed)
      } catch {
        // Keep as raw string — user will see validation errors on test
      }
    }
  }

  return (
    <div className="space-y-1">
      <label className="text-sm text-muted-foreground">
        {t(field.label)}
        {field.required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      <input
        type={inputType}
        value={displayValue}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        placeholder={field.placeholder ? t(field.placeholder) : undefined}
        className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </div>
  )
}

// ============================================
// Main Component
// ============================================

export function NotificationChannelsSection({ config, setConfig }: NotificationChannelsSectionProps) {
  const { t } = useTranslation()

  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set())
  const [testingChannel, setTestingChannel] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({})

  const toggleExpanded = useCallback((channelType: string) => {
    setExpandedChannels((prev) => {
      const next = new Set(prev)
      if (next.has(channelType)) {
        next.delete(channelType)
      } else {
        next.add(channelType)
      }
      return next
    })
  }, [])

  const handleSaveChannel = useCallback(async (channelType: string, channelConfig: Record<string, unknown>) => {
    if (!config) return
    const updatedConfig = {
      ...config,
      notificationChannels: {
        ...config.notificationChannels,
        [channelType]: channelConfig,
      },
    } as HaloConfig
    try {
      await api.setConfig({ notificationChannels: updatedConfig.notificationChannels })
      setConfig(updatedConfig)
      // Clear cached tokens so new credentials take effect immediately
      api.clearNotificationChannelCache().catch(() => {})
    } catch (error) {
      console.error('[NotificationChannelsSection] Failed to save channel config:', error)
    }
  }, [config, setConfig])

  const handleTestChannel = useCallback(async (channelType: string) => {
    setTestingChannel(channelType)
    setTestResults((prev) => {
      const next = { ...prev }
      delete next[channelType]
      return next
    })
    try {
      const result = await api.testNotificationChannel(channelType) as { data: TestResult }
      setTestResults((prev) => ({ ...prev, [channelType]: result.data }))
    } catch {
      setTestResults((prev) => ({ ...prev, [channelType]: { success: false, error: t('Test failed') } }))
    } finally {
      setTestingChannel(null)
    }
  }, [t])

  const getChannelConfig = (channelType: NotificationChannelType): Record<string, unknown> => {
    const channels = config?.notificationChannels as NotificationChannelsConfig | undefined
    if (!channels) return {}
    const raw = channels[channelType]
    if (!raw) return {}
    return raw as unknown as Record<string, unknown>
  }

  return (
    <section id="notification-channels" className="bg-card rounded-xl border border-border p-6">
      <div className="mb-4">
        <h2 className="text-lg font-medium">{t('Notification Channels')}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t('Configure external channels for receiving notifications when tasks complete')}
        </p>
      </div>

      <div className="space-y-3">
        {CHANNEL_DEFS.map((def) => (
          <ChannelCard
            key={def.type}
            def={def}
            channelConfig={getChannelConfig(def.type)}
            isExpanded={expandedChannels.has(def.type)}
            onToggleExpand={() => toggleExpanded(def.type)}
            onSave={handleSaveChannel}
            onTest={handleTestChannel}
            isTesting={testingChannel === def.type}
            testResult={testResults[def.type]}
          />
        ))}
      </div>
    </section>
  )
}
