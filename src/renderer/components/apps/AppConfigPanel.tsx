/**
 * AppConfigPanel
 *
 * Right-panel detail view for editing an automation App's configuration.
 *
 * Two tabs:
 *   - Settings: editable spec fields (name, description, system_prompt),
 *     dynamic config form (config_schema), and frequency selector.
 *   - YAML: full CodeMirror editor for the complete spec — editing power
 *     matches the MCP update_automation_app tool.
 *
 * Design: consistent with McpStatusCard/SkillInfoCard — section headers,
 * bg-secondary inputs, same spacing/typography scale.
 */

import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import { Save, RotateCcw, Unplug, Loader2, FileCode, Settings, Code, AlertTriangle, Globe, Bell, Download } from 'lucide-react'
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml'
import { useAppsStore } from '../../stores/apps.store'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import type { InputDef, SubscriptionDef, AppSpec } from '../../../shared/apps/spec-types'
import type { InstalledApp } from '../../../shared/apps/app-types'
import { resolvePermission } from '../../../shared/apps/app-types'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { AppModelSelector } from './AppModelSelector'
import { appTypeLabel } from './appTypeUtils'

// Lazy-load CodeMirrorEditor to keep initial bundle small
const CodeMirrorEditor = lazy(() =>
  import('../canvas/viewers/CodeMirrorEditor').then(m => ({ default: m.CodeMirrorEditor }))
)

// ============================================
// Types
// ============================================

type ConfigTab = 'settings' | 'yaml'

// ============================================
// Frequency Presets
// ============================================

const FREQUENCY_PRESETS = [
  { label: '1m', value: '1m' },
  { label: '5m', value: '5m' },
  { label: '15m', value: '15m' },
  { label: '30m', value: '30m' },
  { label: '1h', value: '1h' },
  { label: '2h', value: '2h' },
  { label: '6h', value: '6h' },
  { label: '12h', value: '12h' },
  { label: '1d', value: '1d' },
]

// ============================================
// Helpers
// ============================================

/** Parse a duration string like "30m", "2h", "1d" into milliseconds */
function durationToMs(dur: string): number {
  const match = dur.match(/^(\d+)([smhd])$/)
  if (!match) return 0
  const val = Number(match[1])
  switch (match[2]) {
    case 's': return val * 1000
    case 'm': return val * 60_000
    case 'h': return val * 3_600_000
    case 'd': return val * 86_400_000
    default: return 0
  }
}

/** Format a duration string to a human-readable label */
function formatFrequency(dur: string, t: (s: string, opts?: Record<string, unknown>) => string): string {
  const match = dur.match(/^(\d+)([smhd])$/)
  if (!match) return dur
  const val = Number(match[1])
  switch (match[2]) {
    case 's': return t('Every {{count}}s', { count: val })
    case 'm': return t('Every {{count}}m', { count: val })
    case 'h': return t('Every {{count}}h', { count: val })
    case 'd': return t('Every {{count}}d', { count: val })
    default: return dur
  }
}

/** Get the effective frequency for a subscription (user override > spec default) */
function getEffectiveFrequency(sub: SubscriptionDef, app: InstalledApp): string | null {
  const subId = sub.id ?? '0'
  const userOverride = app.userOverrides?.frequency?.[subId]
  if (userOverride) return userOverride
  if (sub.frequency?.default) return sub.frequency.default
  if (sub.source.type === 'schedule') {
    return sub.source.config.every ?? null
  }
  return null
}

/** Filter frequency presets by min/max constraints from the subscription */
function filterPresets(sub: SubscriptionDef): typeof FREQUENCY_PRESETS {
  const minMs = sub.frequency?.min ? durationToMs(sub.frequency.min) : 0
  const maxMs = sub.frequency?.max ? durationToMs(sub.frequency.max) : Infinity
  return FREQUENCY_PRESETS.filter(p => {
    const ms = durationToMs(p.value)
    return ms >= minMs && ms <= maxMs
  })
}

/** Serialize an AppSpec to clean YAML, stripping undefined/null fields */
function specToYaml(spec: AppSpec): string {
  // Create a clean copy without undefined values for nice YAML output
  const clean = JSON.parse(JSON.stringify(spec))
  return stringifyYaml(clean, { lineWidth: 0 })
}

// ============================================
// Config Field Renderer
// ============================================

interface ConfigFieldProps {
  def: InputDef
  value: unknown
  onChange: (key: string, value: unknown) => void
  t: (s: string, opts?: Record<string, unknown>) => string
}

function ConfigField({ def, value, onChange, t }: ConfigFieldProps) {
  const id = `config-${def.key}`

  // Resolve current value (user-provided > default > empty)
  const currentValue = value ?? def.default ?? ''

  switch (def.type) {
    case 'boolean':
      return (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <label htmlFor={id} className="text-sm text-foreground">{def.label}</label>
            {def.description && (
              <p className="text-xs text-muted-foreground mt-0.5">{def.description}</p>
            )}
          </div>
          <button
            id={id}
            type="button"
            role="switch"
            aria-checked={!!currentValue}
            onClick={() => onChange(def.key, !currentValue)}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
              currentValue ? 'bg-primary' : 'bg-muted'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow transform transition-transform mt-0.5 ${
                currentValue ? 'translate-x-[18px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      )

    case 'select':
      return (
        <div className="space-y-1.5">
          <label htmlFor={id} className="text-sm text-foreground">{def.label}</label>
          {def.description && (
            <p className="text-xs text-muted-foreground">{def.description}</p>
          )}
          <select
            id={id}
            value={String(currentValue)}
            onChange={e => onChange(def.key, e.target.value)}
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
          >
            <option value="">{t('Select...')}</option>
            {(def.options ?? []).map(opt => (
              <option key={String(opt.value)} value={String(opt.value)}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )

    case 'number':
      return (
        <div className="space-y-1.5">
          <label htmlFor={id} className="text-sm text-foreground">{def.label}</label>
          {def.description && (
            <p className="text-xs text-muted-foreground">{def.description}</p>
          )}
          <input
            id={id}
            type="number"
            value={currentValue === '' ? '' : Number(currentValue)}
            placeholder={def.placeholder}
            onChange={e => onChange(def.key, e.target.value === '' ? undefined : Number(e.target.value))}
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
          />
        </div>
      )

    case 'text':
      return (
        <div className="space-y-1.5">
          <label htmlFor={id} className="text-sm text-foreground">{def.label}</label>
          {def.description && (
            <p className="text-xs text-muted-foreground">{def.description}</p>
          )}
          <textarea
            id={id}
            value={String(currentValue)}
            placeholder={def.placeholder}
            rows={3}
            onChange={e => onChange(def.key, e.target.value)}
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg resize-none focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
          />
        </div>
      )

    // url, string, email — all text inputs with different types
    default:
      return (
        <div className="space-y-1.5">
          <label htmlFor={id} className="text-sm text-foreground">{def.label}</label>
          {def.description && (
            <p className="text-xs text-muted-foreground">{def.description}</p>
          )}
          <input
            id={id}
            type={def.type === 'email' ? 'email' : def.type === 'url' ? 'url' : 'text'}
            value={String(currentValue)}
            placeholder={def.placeholder}
            onChange={e => onChange(def.key, e.target.value)}
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
          />
        </div>
      )
  }
}

// ============================================
// Frequency Editor
// ============================================

interface FrequencyEditorProps {
  subscription: SubscriptionDef
  app: InstalledApp
  onFrequencyChange: (subscriptionId: string, frequency: string) => void
  t: (s: string, opts?: Record<string, unknown>) => string
}

function FrequencyEditor({ subscription, app, onFrequencyChange, t }: FrequencyEditorProps) {
  const subId = subscription.id ?? '0'
  const currentFreq = getEffectiveFrequency(subscription, app)
  const presets = filterPresets(subscription)

  if (presets.length === 0 || !currentFreq) return null

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-foreground">
          {subscription.source.type === 'schedule'
            ? t('Schedule frequency')
            : t('Check frequency')}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatFrequency(currentFreq, t)}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {presets.map(preset => (
          <button
            key={preset.value}
            onClick={() => onFrequencyChange(subId, preset.value)}
            className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
              currentFreq === preset.value
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80'
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ============================================
// Settings Tab Content
// ============================================

interface SettingsTabProps {
  app: InstalledApp
  appId: string
  t: (s: string, opts?: Record<string, unknown>) => string
}

function SettingsTab({ app, appId, t }: SettingsTabProps) {
  const { updateAppConfig, updateAppFrequency, updateAppSpec, updateAppOverrides, grantPermission, revokePermission } = useAppsStore()

  // ── Spec fields (name, description, system_prompt) ──
  const [specName, setSpecName] = useState(app.spec.name)
  const [specDescription, setSpecDescription] = useState(app.spec.description)
  const [specSystemPrompt, setSpecSystemPrompt] = useState(app.spec.system_prompt ?? '')
  const [specSaving, setSpecSaving] = useState(false)
  const [specSaveSuccess, setSpecSaveSuccess] = useState(false)
  const [specError, setSpecError] = useState<string | null>(null)

  // ── User config form ──
  const [formValues, setFormValues] = useState<Record<string, unknown>>({})
  const [configSaving, setConfigSaving] = useState(false)
  const [configSaveSuccess, setConfigSaveSuccess] = useState(false)

  // Sync from app data
  useEffect(() => {
    setSpecName(app.spec.name)
    setSpecDescription(app.spec.description)
    setSpecSystemPrompt(app.spec.system_prompt ?? '')
    setSpecSaveSuccess(false)
    setSpecError(null)
    setFormValues({ ...app.userConfig })
    setConfigSaveSuccess(false)
  }, [app.id, app.spec.name, app.spec.description, app.spec.system_prompt, app.userConfig])

  const handleFieldChange = useCallback((key: string, value: unknown) => {
    setFormValues(prev => ({ ...prev, [key]: value }))
    setConfigSaveSuccess(false)
  }, [])

  const configSchema = resolveSpecI18n(app.spec, getCurrentLanguage()).config_schema ?? []
  const subscriptions = app.spec.subscriptions ?? []
  const hasConfig = configSchema.length > 0
  const hasFrequency = subscriptions.some(s => s.frequency || s.source.type === 'schedule')

  // Spec fields change detection
  const specHasChanges =
    specName !== app.spec.name ||
    specDescription !== app.spec.description ||
    specSystemPrompt !== (app.spec.system_prompt ?? '')

  // Config form change detection
  const configHasChanges = hasConfig && JSON.stringify(formValues) !== JSON.stringify(app.userConfig)

  async function handleSpecSave() {
    setSpecError(null)
    if (!specName.trim()) {
      setSpecError(t('App name is required'))
      return
    }
    if (!specDescription.trim()) {
      setSpecError(t('Description is required'))
      return
    }

    setSpecSaving(true)
    const patch: Record<string, unknown> = {}
    if (specName !== app.spec.name) patch.name = specName.trim()
    if (specDescription !== app.spec.description) patch.description = specDescription.trim()
    if (specSystemPrompt !== (app.spec.system_prompt ?? '')) {
      patch.system_prompt = specSystemPrompt.trim() || null
    }

    const ok = await updateAppSpec(appId, patch)
    setSpecSaving(false)
    if (ok) {
      setSpecSaveSuccess(true)
      setTimeout(() => setSpecSaveSuccess(false), 2000)
    } else {
      setSpecError(t('Failed to save spec changes'))
    }
  }

  function handleSpecReset() {
    setSpecName(app.spec.name)
    setSpecDescription(app.spec.description)
    setSpecSystemPrompt(app.spec.system_prompt ?? '')
    setSpecSaveSuccess(false)
    setSpecError(null)
  }

  async function handleConfigSave() {
    setConfigSaving(true)
    const ok = await updateAppConfig(appId, formValues)
    setConfigSaving(false)
    if (ok) {
      setConfigSaveSuccess(true)
      setTimeout(() => setConfigSaveSuccess(false), 2000)
    }
  }

  function handleConfigReset() {
    setFormValues({ ...app.userConfig })
    setConfigSaveSuccess(false)
  }

  async function handleFrequencyChange(subscriptionId: string, frequency: string) {
    await updateAppFrequency(appId, subscriptionId, frequency)
  }

  return (
    <div className="space-y-6">
      {/* ── App Spec Fields ── */}
      <div className="space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('App Info')}
        </h3>

        {/* Name */}
        <div className="space-y-1.5">
          <label className="text-sm text-foreground">{t('Name')}</label>
          <input
            type="text"
            value={specName}
            onChange={e => { setSpecName(e.target.value); setSpecSaveSuccess(false); setSpecError(null) }}
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
          />
        </div>

        {/* Description */}
        <div className="space-y-1.5">
          <label className="text-sm text-foreground">{t('Description')}</label>
          <input
            type="text"
            value={specDescription}
            onChange={e => { setSpecDescription(e.target.value); setSpecSaveSuccess(false); setSpecError(null) }}
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
          />
        </div>

        {/* System Prompt */}
        <div className="space-y-1.5">
          <label className="text-sm text-foreground">{t('System Prompt')}</label>
          <textarea
            value={specSystemPrompt}
            onChange={e => { setSpecSystemPrompt(e.target.value); setSpecSaveSuccess(false); setSpecError(null) }}
            rows={6}
            spellCheck={false}
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg resize-none focus:outline-none focus:ring-1 focus:ring-primary text-foreground font-mono"
          />
        </div>

        {/* Spec Save / Reset */}
        {specError && (
          <p className="text-xs text-red-400">{specError}</p>
        )}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleSpecSave}
            disabled={!specHasChanges || specSaving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-40"
          >
            {specSaving
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Save className="w-3.5 h-3.5" />}
            {t('Save')}
          </button>
          {specHasChanges && (
            <button
              onClick={handleSpecReset}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {t('Reset')}
            </button>
          )}
          {specSaveSuccess && (
            <span className="text-xs text-green-500">{t('Saved')}</span>
          )}
        </div>
      </div>

      {/* ── Frequency Settings ── */}
      {hasFrequency && (
        <div className="space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('Schedule')}
          </h3>
          {subscriptions.map((sub, idx) => (
            <FrequencyEditor
              key={sub.id ?? idx}
              subscription={sub}
              app={app}
              onFrequencyChange={handleFrequencyChange}
              t={t}
            />
          ))}
        </div>
      )}

      {/* ── Runtime Settings (Model + AI Browser + Notifications) ── */}
      <div className="space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('Runtime')}
        </h3>

        {/* Model selector */}
        <AppModelSelector
          modelSourceId={app.userOverrides.modelSourceId}
          modelId={app.userOverrides.modelId}
          recommendedModel={app.spec.recommended_model}
          onChange={async (sourceId, modelId) => {
            await updateAppOverrides(appId, {
              modelSourceId: sourceId,
              modelId: modelId,
            })
          }}
        />

        {/* AI Browser toggle */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-sm text-foreground">{t('AI Browser')}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('Enable browser tools for web automation')}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={resolvePermission(app, 'ai-browser')}
            onClick={async () => {
              const isEnabled = resolvePermission(app, 'ai-browser')
              if (isEnabled) {
                await revokePermission(appId, 'ai-browser')
              } else {
                await grantPermission(appId, 'ai-browser')
              }
            }}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
              resolvePermission(app, 'ai-browser') ? 'bg-primary' : 'bg-muted'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow transform transition-transform mt-0.5 ${
                resolvePermission(app, 'ai-browser') ? 'translate-x-[18px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
        {/* Warn when user disabled a permission the spec declares */}
        {!resolvePermission(app, 'ai-browser') && app.spec.permissions?.includes('ai-browser') && (
          <p className="text-xs text-amber-500 flex items-center gap-1 -mt-2">
            <AlertTriangle className="w-3 h-3 flex-shrink-0" />
            {t('This app may require AI Browser to work properly')}
          </p>
        )}

        {/* Notification level */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Bell className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-sm text-foreground">{t('Notifications')}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {([
              { value: 'important', label: t('Important') },
              { value: 'all', label: t('All') },
              { value: 'none', label: t('None') },
            ] as const).map(opt => (
              <button
                key={opt.value}
                onClick={async () => {
                  await updateAppOverrides(appId, {
                    notificationLevel: opt.value === 'important' ? undefined : opt.value,
                  })
                }}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  (app.userOverrides.notificationLevel ?? 'important') === opt.value
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {(app.userOverrides.notificationLevel ?? 'important') === 'all'
              ? t('Notify on every execution result')
              : (app.userOverrides.notificationLevel ?? 'important') === 'none'
                ? t('No desktop notifications')
                : t('Notify on milestones, escalations, and outputs')}
          </p>
        </div>
      </div>

      {/* ── User Configuration Fields ── */}
      {hasConfig && (
        <div className="space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('Configuration')}
          </h3>
          <div className="space-y-4">
            {configSchema.map(def => (
              <ConfigField
                key={def.key}
                def={def}
                value={formValues[def.key]}
                onChange={handleFieldChange}
                t={t}
              />
            ))}
          </div>

          {/* Config Save / Reset */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleConfigSave}
              disabled={!configHasChanges || configSaving}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-40"
            >
              {configSaving
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Save className="w-3.5 h-3.5" />}
              {t('Save')}
            </button>
            {configHasChanges && (
              <button
                onClick={handleConfigReset}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {t('Reset')}
              </button>
            )}
            {configSaveSuccess && (
              <span className="text-xs text-green-500">{t('Saved')}</span>
            )}
          </div>
        </div>
      )}

      {/* ── Spec Info (read-only summary) ── */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <FileCode className="w-3.5 h-3.5" />
          {t('App Spec')}
        </h3>
        <div className="bg-secondary rounded-lg p-3 text-xs font-mono space-y-1">
          <div className="flex gap-2">
            <span className="text-muted-foreground w-20 flex-shrink-0">{t('Type')}</span>
            <span className="text-foreground">{t(appTypeLabel(app.spec.type))}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-20 flex-shrink-0">{t('Version')}</span>
            <span className="text-foreground">{app.spec.version}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-20 flex-shrink-0">{t('Spec')}</span>
            <span className="text-foreground">v{app.spec.spec_version}</span>
          </div>
          {subscriptions.length > 0 && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-20 flex-shrink-0">{t('Triggers')}</span>
              <span className="text-foreground">
                {subscriptions.map(s => s.source.type).join(', ')}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ============================================
// YAML Tab Content
// ============================================

interface YamlTabProps {
  app: InstalledApp
  appId: string
  t: (s: string, opts?: Record<string, unknown>) => string
}

function YamlTab({ app, appId, t }: YamlTabProps) {
  const { updateAppSpec, exportApp } = useAppsStore()

  const [yamlContent, setYamlContent] = useState(() => specToYaml(app.spec))
  const [originalYaml, setOriginalYaml] = useState(() => specToYaml(app.spec))
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  // Sync when app spec changes externally (e.g. after Settings tab save)
  useEffect(() => {
    const fresh = specToYaml(app.spec)
    setYamlContent(fresh)
    setOriginalYaml(fresh)
    setSaveSuccess(false)
    setError(null)
  }, [app.id, app.spec])

  const hasChanges = yamlContent !== originalYaml

  async function handleSave() {
    setError(null)

    // Parse YAML
    let parsed: Record<string, unknown>
    try {
      parsed = parseYaml(yamlContent) as Record<string, unknown>
    } catch (e) {
      setError(t('Invalid YAML syntax'))
      return
    }

    if (!parsed || typeof parsed !== 'object') {
      setError(t('YAML must be an object'))
      return
    }

    // Prevent type changes
    if (parsed.type && parsed.type !== app.spec.type) {
      setError(t('Cannot change app type'))
      return
    }

    setSaving(true)

    // Send the full parsed spec as the patch.
    // The backend applies JSON Merge Patch and re-validates with Zod.
    const ok = await updateAppSpec(appId, parsed)
    setSaving(false)

    if (ok) {
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
    } else {
      setError(t('Failed to save. The server rejected the spec — check for validation errors.'))
    }
  }

  function handleReset() {
    setYamlContent(originalYaml)
    setError(null)
    setSaveSuccess(false)
  }

  async function handleExport() {
    setExporting(true)
    await exportApp(appId)
    setExporting(false)
  }

  return (
    <div className="space-y-3 flex flex-col" style={{ minHeight: 0 }}>
      <p className="text-xs text-muted-foreground">
        {t('Edit the full app spec as YAML. Changes are validated by the server before saving.')}
      </p>

      <Suspense fallback={
        <div className="h-96 flex items-center justify-center bg-secondary rounded-lg border border-border">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      }>
        <div className="border border-border rounded-lg overflow-hidden" style={{ height: '60vh', minHeight: '320px' }}>
          <CodeMirrorEditor
            content={yamlContent}
            language="yaml"
            readOnly={false}
            onChange={setYamlContent}
          />
        </div>
      </Suspense>

      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={!hasChanges || saving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-40"
        >
          {saving
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Save className="w-3.5 h-3.5" />}
          {t('Save')}
        </button>
        {hasChanges && (
          <button
            onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            {t('Reset')}
          </button>
        )}
        {saveSuccess && (
          <span className="text-xs text-green-500">{t('Saved')}</span>
        )}

        <div className="flex-1" />

        <button
          onClick={handleExport}
          disabled={exporting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors disabled:opacity-40"
          title={t('Export as YAML file')}
        >
          {exporting
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Download className="w-3.5 h-3.5" />}
          {t('Export')}
        </button>
      </div>
    </div>
  )
}

// ============================================
// Main Component
// ============================================

interface AppConfigPanelProps {
  appId: string
  /** Space name to display in the identity section */
  spaceName?: string
}

export function AppConfigPanel({ appId, spaceName }: AppConfigPanelProps) {
  const { t } = useTranslation()
  const { apps, uninstallApp } = useAppsStore()
  const app = apps.find(a => a.id === appId)

  const [activeTab, setActiveTab] = useState<ConfigTab>('settings')
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false)

  if (!app) return null

  const { name, description } = resolveSpecI18n(app.spec, getCurrentLanguage())

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      {/* App identity (always visible) */}
      <div>
        <h2 className="text-base font-semibold text-foreground">{name}</h2>
        <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-muted-foreground">
            v{app.spec.version} · {app.spec.author}
            {spaceName && <span> · {spaceName}</span>}
          </span>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex items-center gap-0.5 bg-secondary rounded-lg p-0.5 w-fit">
        <button
          onClick={() => setActiveTab('settings')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors ${
            activeTab === 'settings'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Settings className="w-3.5 h-3.5" />
          {t('Settings')}
        </button>
        <button
          onClick={() => setActiveTab('yaml')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors ${
            activeTab === 'yaml'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Code className="w-3.5 h-3.5" />
          {t('YAML')}
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'settings' && (
        <SettingsTab app={app} appId={appId} t={t} />
      )}
      {activeTab === 'yaml' && (
        <YamlTab app={app} appId={appId} t={t} />
      )}

      {/* Danger Zone (always visible) */}
      <div className="space-y-2 pt-2 border-t border-border">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('Danger zone')}
        </h3>
        {showUninstallConfirm ? (
          <div className="p-3 border border-red-400/30 rounded-lg space-y-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-muted-foreground">
                {t('Are you sure you want to uninstall this app? You can reinstall it later.')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  await uninstallApp(appId)
                  setShowUninstallConfirm(false)
                }}
                className="px-3 py-1.5 text-sm text-red-400 hover:text-red-300 border border-red-400/30 hover:border-red-400/60 rounded-lg transition-colors"
              >
                {t('Confirm Uninstall')}
              </button>
              <button
                onClick={() => setShowUninstallConfirm(false)}
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground rounded-lg transition-colors"
              >
                {t('Cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowUninstallConfirm(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-400 hover:text-red-300 border border-red-400/30 hover:border-red-400/60 rounded-lg transition-colors"
          >
            <Unplug className="w-4 h-4" />
            {t('Uninstall')}
          </button>
        )}
      </div>
    </div>
  )
}
