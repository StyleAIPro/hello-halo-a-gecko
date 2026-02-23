/**
 * AppInstallDialog
 *
 * Modal dialog for creating / installing an App.
 * Two modes:
 *   - Visual (default): structured form for the common case (type=automation)
 *   - YAML: full CodeMirror editor with a complete example template
 */

import { useState, useMemo, useCallback, lazy, Suspense } from 'react'
import { X, Loader2, Sparkles } from 'lucide-react'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { useAppsStore } from '../../stores/apps.store'
import { useSpaceStore } from '../../stores/space.store'
import { useTranslation } from '../../i18n'
import type { AppSpec } from '../../../shared/apps/spec-types'
import { AppModelSelector } from './AppModelSelector'

// Lazy-load CodeMirrorEditor to keep initial bundle small
const CodeMirrorEditor = lazy(() =>
  import('../canvas/viewers/CodeMirrorEditor').then(m => ({ default: m.CodeMirrorEditor }))
)

// ============================================
// Constants
// ============================================

type InstallMode = 'visual' | 'yaml'

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

const DEFAULT_YAML_TEMPLATE = `\
# ============================================
# Halo Digital Human Spec - Complete Example
# ============================================
# This template shows ALL available fields.
# Delete or modify sections as needed.

spec_version: "1.0"
name: "HN Daily Digest"
version: "1.0"
author: me
description: "Fetch Hacker News top stories and send a daily summary"
type: automation

# -- Core Instruction --
# The system_prompt is the "soul" of your app.
# It tells the AI what to do on each run.
system_prompt: |
  You are an HN information assistant. On each trigger:
  1. Open https://news.ycombinator.com and get today's Top 10 stories
  2. For each story, write a concise Chinese summary (2-3 sentences)
  3. Format as a clean digest with title, link, and summary
  4. Report completion via report_to_user(type="run_complete")

  If you encounter any issues, use
  report_to_user(type="escalation") to ask the user for help.

# -- Schedule --
# Use "every" for intervals or "cron" for cron expressions.
subscriptions:
  - id: daily-check
    source:
      type: schedule
      config:
        every: "1d"
        # cron: "0 8 * * *"    # Alternative: daily at 8am
    frequency:
      default: "1d"
      min: "1h"
      max: "1d"

# -- User Configuration --
# Fields shown to the user during install and in settings.
config_schema:
  - key: email
    label: "Notification Email"
    type: email
    required: false
    placeholder: "you@example.com"
    description: "Optional email for digest delivery"
  - key: story_count
    label: "Number of Stories"
    type: number
    default: 10
    description: "How many top stories to include"

# -- Dependencies --
# MCP servers and skills this app needs.
requires:
  mcps:
    - id: ai-browser
      reason: "Browse Hacker News to fetch stories"

# -- Memory --
# What the AI should remember across runs.
memory_schema:
  seen_stories:
    type: array
    description: "Story IDs already included in past digests"
  last_digest_date:
    type: date
    description: "Date of the last successful digest"

# -- Filters (zero LLM cost) --
# filters:
#   - field: story_score
#     op: gt
#     value: 50

# -- Output --
output:
  notify: true
  format: "HN Digest: {story_count} stories"

# -- Escalation --
escalation:
  enabled: true
  timeout_hours: 24

# -- Permissions --
permissions:
  - browser.navigate
  - notification.send
`

// ============================================
// Helpers
// ============================================

interface VisualFormState {
  name: string
  description: string
  author: string
  systemPrompt: string
  frequency: string
}

const INITIAL_FORM: VisualFormState = {
  name: '',
  description: '',
  author: '',
  systemPrompt: '',
  frequency: '1h',
}

/** Build an AppSpec object from the visual form state */
function buildSpecFromForm(form: VisualFormState): AppSpec {
  return {
    spec_version: '1.0',
    name: form.name.trim(),
    version: '1.0',
    author: form.author.trim(),
    description: form.description.trim(),
    type: 'automation',
    system_prompt: form.systemPrompt.trim(),
    subscriptions: [
      {
        source: {
          type: 'schedule' as const,
          config: {
            every: form.frequency,
          },
        },
      },
    ],
  }
}

/** Try to extract a frequency string from a parsed YAML object */
function extractFrequency(parsed: Record<string, unknown>): string | null {
  try {
    const subs = parsed.subscriptions as Array<Record<string, unknown>> | undefined
    if (!subs || subs.length === 0) return null
    const source = subs[0]?.source as Record<string, unknown> | undefined
    if (!source) return null
    const config = source.config as Record<string, unknown> | undefined
    return (config?.every as string) ?? null
  } catch {
    return null
  }
}

/** Check if a frequency value is in the presets */
function isValidPreset(freq: string): boolean {
  return FREQUENCY_PRESETS.some(p => p.value === freq)
}

// ============================================
// Component
// ============================================

interface AppInstallDialogProps {
  onClose: () => void
}

export function AppInstallDialog({ onClose }: AppInstallDialogProps) {
  const { t } = useTranslation()
  const { installApp, loadApps, updateAppOverrides } = useAppsStore()

  // Get all spaces
  const currentSpace = useSpaceStore(state => state.currentSpace)
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const spaces = useSpaceStore(state => state.spaces)

  // Combine all available spaces (haloSpace + dedicated spaces)
  const allSpaces = useMemo(() => {
    const result: Array<{ id: string; name: string; icon: string }> = []
    if (haloSpace) result.push(haloSpace)
    result.push(...spaces)
    return result
  }, [haloSpace, spaces])

  const [mode, setMode] = useState<InstallMode>('visual')
  const [form, setForm] = useState<VisualFormState>({ ...INITIAL_FORM })
  const [yamlContent, setYamlContent] = useState(DEFAULT_YAML_TEMPLATE)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Per-app model override (optional, applied after install)
  const [modelSourceId, setModelSourceId] = useState<string | undefined>(undefined)
  const [modelId, setModelId] = useState<string | undefined>(undefined)

  // Default space: currentSpace if set, else first available
  const [selectedSpaceId, setSelectedSpaceId] = useState(
    currentSpace?.id ?? allSpaces[0]?.id ?? ''
  )

  // ── Form field updater ──
  const updateField = useCallback(<K extends keyof VisualFormState>(key: K, value: VisualFormState[K]) => {
    setForm(prev => ({ ...prev, [key]: value }))
    setError(null)
  }, [])

  // ── Mode switching ──
  const handleSwitchToYaml = useCallback(() => {
    setError(null)
    // If form has content, serialize it to YAML
    if (form.name || form.systemPrompt) {
      const spec = buildSpecFromForm(form)
      setYamlContent(stringifyYaml(spec, { lineWidth: 0 }))
    } else {
      setYamlContent(DEFAULT_YAML_TEMPLATE)
    }
    setMode('yaml')
  }, [form])

  const handleSwitchToVisual = useCallback(() => {
    setError(null)
    try {
      const parsed = parseYaml(yamlContent) as Record<string, unknown> | null
      if (parsed && typeof parsed === 'object') {
        const freq = extractFrequency(parsed)
        setForm({
          name: String(parsed.name ?? ''),
          description: String(parsed.description ?? ''),
          author: String(parsed.author ?? ''),
          systemPrompt: String(parsed.system_prompt ?? ''),
          frequency: (freq && isValidPreset(freq)) ? freq : '1h',
        })
      }
    } catch {
      setError(t('Could not parse YAML. Some fields may be empty.'))
    }
    setMode('visual')
  }, [yamlContent, t])

  // ── Install handler (both modes) ──
  async function handleInstall() {
    setError(null)
    setLoading(true)

    try {
      let specObj: AppSpec

      if (mode === 'visual') {
        if (!form.name.trim()) {
          setError(t('App name is required'))
          setLoading(false)
          return
        }
        if (!form.description.trim()) {
          setError(t('Description is required'))
          setLoading(false)
          return
        }
        if (!form.author.trim()) {
          setError(t('Author is required'))
          setLoading(false)
          return
        }
        if (!form.systemPrompt.trim()) {
          setError(t('System prompt is required'))
          setLoading(false)
          return
        }
        specObj = buildSpecFromForm(form)
      } else {
        // YAML mode
        try {
          specObj = parseYaml(yamlContent) as AppSpec
        } catch {
          setError(t('Invalid YAML format. Please check your spec.'))
          setLoading(false)
          return
        }
        if (!specObj || typeof specObj !== 'object') {
          setError(t('YAML must be an object'))
          setLoading(false)
          return
        }
      }

      const appId = await installApp(selectedSpaceId, specObj)
      if (appId) {
        // Apply per-app model override if user selected one
        if (modelSourceId) {
          await updateAppOverrides(appId, { modelSourceId, modelId })
        }
        await loadApps() // Global reload
        onClose()
      } else {
        setError(t('Installation failed. Check the spec and try again.'))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Installation failed'))
    } finally {
      setLoading(false)
    }
  }

  // ── Can install? ──
  const canInstall = mode === 'yaml'
    ? yamlContent.trim().length > 0
    : (form.name.trim().length > 0 && form.systemPrompt.trim().length > 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="relative w-full max-w-2xl mx-4 bg-background border border-border rounded-xl shadow-xl flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">{t('Create Digital Human')}</h2>

            {/* Mode toggle */}
            <div className="flex items-center gap-0.5 bg-secondary rounded-lg p-0.5">
              <button
                onClick={() => mode !== 'visual' && handleSwitchToVisual()}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  mode === 'visual'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('Visual')}
              </button>
              <button
                onClick={() => mode !== 'yaml' && handleSwitchToYaml()}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  mode === 'yaml'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('YAML')}
              </button>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground rounded-md transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          {mode === 'visual' ? (
            <>
              <p className="text-xs text-muted-foreground">
                {t('Create a new digital human using the visual form, or switch to YAML for full control.')}
              </p>

              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/10">
                <Sparkles className="w-3.5 h-3.5 text-primary mt-0.5 flex-shrink-0" />
                <p className="text-xs text-muted-foreground">
                  {t('You can also tell AI to create one for you through natural language in any space chat.')}
                </p>
              </div>

              {/* App Name */}
              <div className="space-y-1.5">
                <label className="text-sm text-foreground">
                  {t('App Name')} <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => updateField('name', e.target.value)}
                  placeholder={t('My Digital Human')}
                  className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
                />
              </div>

              {/* Description */}
              <div className="space-y-1.5">
                <label className="text-sm text-foreground">
                  {t('Description')} <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={form.description}
                  onChange={e => updateField('description', e.target.value)}
                  placeholder={t('What does this app do?')}
                  className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
                />
              </div>

              {/* Author */}
              <div className="space-y-1.5">
                <label className="text-sm text-foreground">
                  {t('Author')} <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={form.author}
                  onChange={e => updateField('author', e.target.value)}
                  placeholder={t('Your name')}
                  className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
                />
              </div>

              {/* System Prompt */}
              <div className="space-y-1.5">
                <label className="text-sm text-foreground">
                  {t('System Prompt')} <span className="text-red-400">*</span>
                </label>
                <textarea
                  value={form.systemPrompt}
                  onChange={e => updateField('systemPrompt', e.target.value)}
                  placeholder={t('Describe what this app should do on each scheduled run. This is the core instruction that drives the AI.')}
                  rows={6}
                  className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg resize-none focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
                  spellCheck={false}
                />
              </div>

              {/* Schedule Frequency */}
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('Schedule')}
                </h3>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-foreground">{t('Run every')}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {FREQUENCY_PRESETS.map(preset => (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => updateField('frequency', preset.value)}
                      className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                        form.frequency === preset.value
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            /* YAML mode */
            <>
              <p className="text-xs text-muted-foreground">
                {t('Edit the YAML spec directly. This template includes all available fields for a digital human.')}
              </p>
              <Suspense fallback={
                <div className="h-80 flex items-center justify-center bg-secondary rounded-lg border border-border">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              }>
                <div className="h-80 border border-border rounded-lg overflow-hidden">
                  <CodeMirrorEditor
                    content={yamlContent}
                    language="yaml"
                    readOnly={false}
                    onChange={setYamlContent}
                  />
                </div>
              </Suspense>
            </>
          )}

          {/* Model selector — shown in both visual and YAML modes */}
          <AppModelSelector
            modelSourceId={modelSourceId}
            modelId={modelId}
            onChange={(srcId, mdlId) => {
              setModelSourceId(srcId)
              setModelId(mdlId)
            }}
          />

          {/* Space selector — shown in both visual and YAML modes */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('Install to')}
            </h3>
            {allSpaces.length <= 1 ? (
              // Single space — show as text
              <p className="text-sm text-foreground">
                {allSpaces[0]?.name ?? t('No spaces available')}
              </p>
            ) : (
              // Multiple spaces — show dropdown
              <select
                value={selectedSpaceId}
                onChange={e => setSelectedSpaceId(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
              >
                {allSpaces.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
          </div>

          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={handleInstall}
            disabled={loading || !canInstall}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {t('Create Digital Human')}
          </button>
        </div>
      </div>
    </div>
  )
}
