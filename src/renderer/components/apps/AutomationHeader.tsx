/**
 * AutomationHeader
 *
 * Top bar in the right detail panel of AppsPage.
 * Shows app name, type badge, status, and action buttons
 * appropriate to the current app state.
 */

import { Play, Pause, RotateCcw, Settings } from 'lucide-react'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { AppStatusDot } from './AppStatusDot'
import { useTranslation } from '../../i18n'
import { appTypeLabel } from './appTypeUtils'

interface AutomationHeaderProps {
  appId: string
  /** Space name to display in the header subtitle */
  spaceName?: string
}

// Friendly label for AutomationAppState.status
function statusLabel(s: string): string {
  switch (s) {
    case 'running': return 'Running'
    case 'idle': return 'Idle'
    case 'waiting_user': return 'Waiting for you'
    case 'paused': return 'Paused'
    case 'error': return 'Error'
    default: return s
  }
}

export function AutomationHeader({ appId, spaceName }: AutomationHeaderProps) {
  const { t } = useTranslation()
  const { apps, appStates, pauseApp, resumeApp, triggerApp } = useAppsStore()
  const { openAppConfig } = useAppsPageStore()
  const app = apps.find(a => a.id === appId)
  const runtimeState = appStates[appId]

  if (!app) return null

  const status = app.status
  const runtimeStatus = runtimeState?.status
  const effectiveStatus = runtimeStatus ?? (status === 'active' ? 'idle' : status)
  const appType = app.spec.type
  const isAutomation = appType === 'automation'

  const isWaiting = status === 'waiting_user'
  const isPaused = status === 'paused'
  const isRunning = effectiveStatus === 'running'

  // Format next run time
  let nextRunLabel: string | null = null
  if (isAutomation && runtimeState?.nextRunAtMs) {
    const diff = runtimeState.nextRunAtMs - Date.now()
    if (diff > 0) {
      const mins = Math.floor(diff / 60_000)
      const hrs = Math.floor(mins / 60)
      nextRunLabel = hrs > 0
        ? t('Next run in {{count}}h', { count: hrs })
        : t('Next run in {{count}}m', { count: mins })
    }
  }

  // Subscription frequency label (effective: user override > frequency.default > source config)
  const sub = app.spec.subscriptions?.[0]
  let freqLabel: string | null = null
  if (sub) {
    const subId = sub.id ?? '0'
    const userOverride = app.userOverrides?.frequency?.[subId]
    if (userOverride) {
      freqLabel = userOverride
    } else if (sub.frequency?.default) {
      freqLabel = sub.frequency.default
    } else if (sub.source.type === 'schedule') {
      freqLabel = sub.source.config.every ?? sub.source.config.cron ?? null
    }
  }

  return (
    <div className="flex-shrink-0 border-b border-border px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        {/* Left: app info */}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground truncate">{app.spec.name}</h2>
            <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wide">
              {t(appTypeLabel(appType))}
            </span>
          </div>

          {spaceName && (
            <p className="text-[11px] text-muted-foreground/70 truncate">{spaceName}</p>
          )}

          {isAutomation && (
            <div className="flex items-center gap-2 mt-0.5">
              <AppStatusDot status={status} runtimeStatus={runtimeStatus} size="sm" />
              <span className="text-xs text-muted-foreground">
                {t(statusLabel(effectiveStatus))}
                {freqLabel && <span className="ml-1">· {freqLabel}</span>}
                {nextRunLabel && <span className="ml-1">· {nextRunLabel}</span>}
              </span>
            </div>
          )}
        </div>

        {/* Right: action buttons */}
        {isAutomation && (
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Trigger now — available when active or error, not when paused/waiting */}
            {!isPaused && !isWaiting && (
              <button
                onClick={() => triggerApp(appId)}
                disabled={isRunning}
                title={t('Run now')}
                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors disabled:opacity-40"
              >
                <Play className="w-4 h-4" />
              </button>
            )}

            {/* Retry — when error */}
            {status === 'error' && (
              <button
                onClick={() => triggerApp(appId)}
                title={t('Retry now')}
                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            )}

            {/* Pause / Resume */}
            {isPaused ? (
              <button
                onClick={() => resumeApp(appId)}
                title={t('Resume')}
                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
              >
                <Play className="w-4 h-4" />
              </button>
            ) : (
              !isWaiting && (
                <button
                  onClick={() => pauseApp(appId)}
                  title={t('Pause')}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
                >
                  <Pause className="w-4 h-4" />
                </button>
              )
            )}

            {/* Settings */}
            <button
              onClick={() => openAppConfig(appId)}
              title={t('Settings')}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
