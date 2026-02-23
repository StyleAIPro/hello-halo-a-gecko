/**
 * ActivityEntryCard
 *
 * Renders a single activity entry in the timeline.
 * Each entry has a left-side timeline node (color-coded dot)
 * connected by the parent's timeline rail, and right-side content.
 *
 * Supports all 6 entry types: run_complete, run_skipped, run_error,
 * milestone, escalation, output.
 */

import { CheckCircle2, SkipForward, XCircle, Bell, FileOutput, Clock, ChevronRight } from 'lucide-react'
import type { ActivityEntry } from '../../../shared/apps/app-types'
import { EscalationCard } from './EscalationCard'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useTranslation } from '../../i18n'

interface ActivityEntryCardProps {
  entry: ActivityEntry
  appId: string
  /** Whether this is the last entry (hides the rail tail) */
  isLast?: boolean
  /** Staggered animation delay in seconds (undefined = no animation) */
  animationDelay?: number
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function formatTs(ts: number): string {
  const d = new Date(ts)
  const date = d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `${date}  ${time}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}

// ──────────────────────────────────────────────
// Timeline node color per entry type
// ──────────────────────────────────────────────

function nodeColorClass(type: ActivityEntry['type']): string {
  switch (type) {
    case 'run_complete': return 'bg-green-500'
    case 'run_skipped':  return 'bg-muted-foreground/40'
    case 'run_error':    return 'bg-red-500'
    case 'milestone':    return 'bg-blue-400'
    case 'escalation':   return 'bg-orange-400'
    case 'output':       return 'bg-purple-400'
    default:             return 'bg-muted-foreground/40'
  }
}

// ──────────────────────────────────────────────
// Type-specific header elements
// ──────────────────────────────────────────────

function EntryIcon({ type }: { type: ActivityEntry['type'] }) {
  switch (type) {
    case 'run_complete':
      return <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
    case 'run_skipped':
      return <SkipForward className="w-3.5 h-3.5 text-muted-foreground" />
    case 'run_error':
      return <XCircle className="w-3.5 h-3.5 text-red-500" />
    case 'milestone':
      return <Bell className="w-3.5 h-3.5 text-blue-400" />
    case 'escalation':
      return <Clock className="w-3.5 h-3.5 text-orange-400" />
    case 'output':
      return <FileOutput className="w-3.5 h-3.5 text-purple-400" />
    default:
      return null
  }
}

function entryLabel(type: ActivityEntry['type']): string {
  switch (type) {
    case 'run_complete': return 'Completed'
    case 'run_skipped': return 'Skipped'
    case 'run_error': return 'Failed'
    case 'milestone': return 'Milestone'
    case 'escalation': return 'Waiting for you'
    case 'output': return 'Output'
    default: return type
  }
}

/** Whether this entry type supports "View process" drill-down */
function hasSessionLink(entry: ActivityEntry): boolean {
  return (entry.type === 'run_complete' || entry.type === 'run_error') && !!entry.sessionKey
}

// ──────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────

export function ActivityEntryCard({ entry, appId, isLast, animationDelay }: ActivityEntryCardProps) {
  const { t } = useTranslation()
  const openSessionDetail = useAppsPageStore(s => s.openSessionDetail)
  const { content } = entry
  const durationMs = content.durationMs
  const canViewProcess = hasSessionLink(entry)

  const handleViewProcess = () => {
    if (entry.sessionKey) {
      openSessionDetail(appId, entry.runId, entry.sessionKey)
    }
  }

  return (
    <div
      className={`relative flex gap-3 ${isLast ? 'pb-2' : 'pb-4'}${animationDelay != null ? ' activity-entry-in' : ''}`}
      style={animationDelay != null ? { animationDelay: `${animationDelay}s` } : undefined}
    >
      {/* Timeline node */}
      <div className="relative z-10 flex-shrink-0 mt-1">
        <div className="w-[19px] h-[19px] rounded-full flex items-center justify-center bg-background">
          <div className={`w-2 h-2 rounded-full ${nodeColorClass(entry.type)}`} />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Meta row: timestamp + type indicator + optional "View process" link */}
        <div className="flex items-center gap-2 mb-1">
          <span className="font-mono text-[11px] text-muted-foreground/80 tabular-nums">{formatTs(entry.ts)}</span>
          <EntryIcon type={entry.type} />
          <span className="text-xs font-medium text-muted-foreground">{t(entryLabel(entry.type))}</span>
          {durationMs != null && (
            <span className="font-mono text-[11px] text-muted-foreground/60">{formatDuration(durationMs)}</span>
          )}
          {/* "View process" link — right-aligned */}
          {canViewProcess && (
            <button
              onClick={handleViewProcess}
              className="ml-auto flex items-center gap-0.5 text-xs text-primary/70 hover:text-primary transition-colors"
            >
              {t('View process')}
              <ChevronRight className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Content */}
        {entry.type === 'escalation' ? (
          <EscalationCard entry={entry} appId={appId} />
        ) : (
          <div className="space-y-1.5">
            <MarkdownRenderer content={content.summary} className="text-sm" />

            {/* Structured data table (if present) */}
            {content.data != null && typeof content.data === 'object' && (
              <pre className="text-xs bg-secondary rounded-md p-2 overflow-x-auto text-muted-foreground">
                {JSON.stringify(content.data, null, 2)}
              </pre>
            )}

            {/* Output download link */}
            {entry.type === 'output' && content.outputUrl && (
              <a
                href={content.outputUrl}
                download
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <FileOutput className="w-3 h-3" />
                {t('Download')}
              </a>
            )}

            {/* Error details for run_error */}
            {entry.type === 'run_error' && content.error && (
              <p className="text-xs text-red-400">{content.error}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
