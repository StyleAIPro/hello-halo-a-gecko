/**
 * ActivityThread
 *
 * Right-panel detail view for automation apps.
 * Renders a reverse-chronological timeline feed of ActivityEntry items,
 * with infinite scroll (load more on scroll-to-bottom).
 *
 * Visual structure:
 *   Left: vertical timeline rail with color-coded node dots
 *   Right: entry content cards with staggered fade-in animation
 *
 * When the app is actively running, shows a live "Working..." card at the top
 * with a glowing node and ambient gradient.
 */

import { useEffect, useRef, useCallback } from 'react'
import { Loader2, ChevronRight } from 'lucide-react'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { ActivityEntryCard } from './ActivityEntryCard'
import { useTranslation } from '../../i18n'

interface ActivityThreadProps {
  appId: string
}

export function ActivityThread({ appId }: ActivityThreadProps) {
  const { t } = useTranslation()
  const {
    apps,
    appStates,
    activityEntries,
    activityHasMore,
    loadActivity,
    loadMoreActivity,
    loadAppState,
  } = useAppsStore()
  const openSessionDetail = useAppsPageStore(s => s.openSessionDetail)

  const app = apps.find(a => a.id === appId)
  const entries = activityEntries[appId] ?? []
  const hasMore = activityHasMore[appId] ?? false
  const runtimeState = appStates[appId]

  // Whether the app is currently executing a run
  const isRunning = runtimeState?.status === 'running'
  const runningRunId = runtimeState?.runningRunId
  const runningSessionKey = runtimeState?.runningSessionKey
  const runningAtMs = runtimeState?.runningAtMs

  // Track whether we've loaded for this appId
  const loadedRef = useRef<string | null>(null)

  useEffect(() => {
    if (loadedRef.current !== appId) {
      loadedRef.current = appId
      loadActivity(appId)
      loadAppState(appId)
    }
  }, [appId, loadActivity, loadAppState])

  // Infinite scroll: observe the sentinel div at the bottom
  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadingMoreRef = useRef(false)

  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (entries[0]?.isIntersecting && hasMore && !loadingMoreRef.current) {
        loadingMoreRef.current = true
        loadMoreActivity(appId).finally(() => {
          loadingMoreRef.current = false
        })
      }
    },
    [appId, hasMore, loadMoreActivity]
  )

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(handleIntersect, { threshold: 0.1 })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [handleIntersect])

  if (!app) return null

  const hasEntries = entries.length > 0 || isRunning

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="flex-1 px-4 py-2">
        {!hasEntries ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-sm text-muted-foreground">{t('No activity yet')}</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              {t('Activity will appear here after the app runs')}
            </p>
          </div>
        ) : (
          <div className="relative">
            {/* Timeline rail — vertical line behind all nodes */}
            <div
              className="timeline-rail absolute left-[9px] top-3 bottom-0 pointer-events-none"
              aria-hidden
            />

            {/* Live running card — shown at top when a run is in progress */}
            {isRunning && runningRunId && (
              <div className="relative flex gap-3 pb-4 activity-entry-in">
                {/* Timeline node — glowing green */}
                <div className="relative z-10 flex-shrink-0 mt-3">
                  <div className="w-[19px] h-[19px] rounded-full flex items-center justify-center bg-background">
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500 timeline-node-running" />
                  </div>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0 activity-running-card px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground/80 tabular-nums">
                      {runningAtMs ? new Date(runningAtMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''}
                    </span>
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                    </span>
                    <span className="text-xs font-medium text-foreground/80">{t('Working...')}</span>

                    {/* View process link */}
                    <button
                      onClick={() => openSessionDetail(appId, runningRunId, runningSessionKey || `app-run-${runningRunId.slice(0, 8)}`)}
                      className="ml-auto flex items-center gap-0.5 text-xs text-primary/70 hover:text-primary transition-colors"
                    >
                      {t('View process')}
                      <ChevronRight className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Activity entries */}
            {entries.map((entry, index) => (
              <ActivityEntryCard
                key={entry.id}
                entry={entry}
                appId={appId}
                isLast={index === entries.length - 1 && !hasMore}
                animationDelay={index < 10 ? index * 0.04 : undefined}
              />
            ))}

            {/* Infinite scroll sentinel */}
            <div ref={sentinelRef} className="py-2 flex justify-center">
              {hasMore && (
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground ml-5" />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
