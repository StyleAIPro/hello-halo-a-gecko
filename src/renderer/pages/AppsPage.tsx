/**
 * Apps Page
 *
 * Top-level page for the Apps system. Accessible from SpacePage header.
 * Layout: Header + tab bar + split pane (app list sidebar | detail area).
 *
 * Session Detail drill-down:
 * When viewing a run's execution trace, a breadcrumb bar replaces the
 * AutomationHeader. Clicking the app name in the breadcrumb returns to
 * the Activity Thread without losing left-sidebar selection.
 */

import { useEffect, useMemo } from 'react'
import { useAppStore } from '../stores/app.store'
import { useSpaceStore } from '../stores/space.store'
import { useAppsStore } from '../stores/apps.store'
import { useAppsPageStore } from '../stores/apps-page.store'
import { Header } from '../components/layout/Header'
import { AppList } from '../components/apps/AppList'
import { AutomationHeader } from '../components/apps/AutomationHeader'
import { ActivityThread } from '../components/apps/ActivityThread'
import { SessionDetailView } from '../components/apps/SessionDetailView'
import { AppChatView } from '../components/apps/AppChatView'
import { AppConfigPanel } from '../components/apps/AppConfigPanel'
import { McpStatusCard } from '../components/apps/McpStatusCard'
import { SkillInfoCard } from '../components/apps/SkillInfoCard'
import { EmptyState } from '../components/apps/EmptyState'
import { AppInstallDialog } from '../components/apps/AppInstallDialog'
import { UninstalledDetailView } from '../components/apps/UninstalledDetailView'
import { StoreView } from '../components/store/StoreView'
import { useTranslation, getCurrentLanguage } from '../i18n'
import { resolveSpecI18n } from '../utils/spec-i18n'
import { ChevronLeft, ChevronRight, Settings } from 'lucide-react'

export function AppsPage() {
  const { t } = useTranslation()
  const { setView, previousView } = useAppStore()
  const currentSpace = useSpaceStore(state => state.currentSpace)
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const spaces = useSpaceStore(state => state.spaces)
  const { apps, loadApps } = useAppsStore()
  const {
    currentTab,
    setCurrentTab,
    selectedAppId,
    detailView,
    initialAppId,
    showInstallDialog,
    selectApp,
    openActivityThread,
    setInitialAppId,
    setShowInstallDialog,
  } = useAppsPageStore()

  // Load all apps globally (across all spaces) on mount
  useEffect(() => {
    loadApps()
  }, [loadApps])

  // Build spaceId -> space name map for display
  // Always populate from both haloSpace and dedicated spaces
  const spaceMap = useMemo(() => {
    const map: Record<string, string> = {}
    if (haloSpace) map[haloSpace.id] = haloSpace.name
    for (const s of spaces) {
      map[s.id] = s.name
    }
    return map
  }, [spaces, haloSpace])

  // Auto-select initial app (from notification/badge navigation)
  useEffect(() => {
    if (initialAppId && apps.length > 0) {
      const app = apps.find(a => a.id === initialAppId)
      if (app) {
        selectApp(app.id, app.status === 'uninstalled' ? 'uninstalled' : app.spec.type)
        setInitialAppId(null)
      }
    }
  }, [apps, initialAppId, selectApp, setInitialAppId])

  // Auto-select first app if nothing selected
  useEffect(() => {
    if (!selectedAppId && apps.length > 0) {
      // Prefer apps waiting for user, skip uninstalled for auto-select
      const activeApps = apps.filter(a => a.status !== 'uninstalled')
      const waitingApp = activeApps.find(a => a.status === 'waiting_user')
      const firstApp = waitingApp ?? activeApps[0] ?? apps[0]
      selectApp(firstApp.id, firstApp.status === 'uninstalled' ? 'uninstalled' : firstApp.spec.type)
    }
  }, [apps, selectedAppId, selectApp])

  // Resolve the selected app (for breadcrumb and detail panel)
  const selectedApp = useMemo(
    () => apps.find(a => a.id === selectedAppId),
    [apps, selectedAppId]
  )

  // Locale-resolved display name for breadcrumbs
  const selectedAppName = useMemo(
    () => selectedApp ? resolveSpecI18n(selectedApp.spec, getCurrentLanguage()).name : undefined,
    [selectedApp]
  )

  const isSessionDetail = detailView?.type === 'session-detail'
  const isAppChat = detailView?.type === 'app-chat'
  const isAppConfig = detailView?.type === 'app-config'
  const isUninstalledDetail = detailView?.type === 'uninstalled-detail'

  // Render the right-side detail panel
  const renderDetail = () => {
    if (!detailView) {
      return <EmptyState hasApps={apps.length > 0} onInstall={() => setShowInstallDialog(true)} />
    }

    switch (detailView.type) {
      case 'activity-thread':
        return <ActivityThread appId={detailView.appId} />
      case 'session-detail':
        return (
          <SessionDetailView
            appId={detailView.appId}
            runId={detailView.runId}
          />
        )
      case 'app-chat':
        return (
          <AppChatView
            appId={detailView.appId}
            spaceId={detailView.spaceId}
          />
        )
      case 'app-config':
        return <AppConfigPanel appId={detailView.appId} spaceName={spaceMap[selectedApp?.spaceId ?? '']} />
      case 'mcp-status':
        return <McpStatusCard appId={detailView.appId} />
      case 'skill-info':
        return <SkillInfoCard appId={detailView.appId} />
      case 'uninstalled-detail':
        return <UninstalledDetailView appId={detailView.appId} spaceName={spaceMap[selectedApp?.spaceId ?? '']} />
      default:
        return <EmptyState hasApps={apps.length > 0} onInstall={() => setShowInstallDialog(true)} />
    }
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <Header
        left={
          <button
            onClick={() => setView(currentSpace ? 'space' : (previousView || 'home'))}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            {currentSpace?.name ?? t('Back')}
          </button>
        }
        right={
          <button
            onClick={() => setView('settings')}
            className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
            title={t('Settings')}
          >
            <Settings className="w-5 h-5" />
          </button>
        }
      />

      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-border flex-shrink-0">
        <button
          onClick={() => setCurrentTab('my-digital-humans')}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            currentTab === 'my-digital-humans'
              ? 'bg-secondary text-foreground font-medium'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
          }`}
        >
          {t('My Digital Humans')}
        </button>
        <button
          disabled
          className="px-3 py-1.5 text-sm rounded-md text-muted-foreground/50 cursor-not-allowed"
          title={t('Coming soon')}
        >
          {t('My Apps')}
        </button>
        <button
          onClick={() => setCurrentTab('store')}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            currentTab === 'store'
              ? 'bg-secondary text-foreground font-medium'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
          }`}
        >
          {t('App Store')}
        </button>
      </div>

      {/* Content area: My Digital Humans or Store */}
      {currentTab === 'my-digital-humans' ? (
        /* Split layout: left sidebar + right detail */
        <div className="flex-1 flex overflow-hidden">
          {/* Left: App list (fixed 240px width) */}
          <div className="w-60 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
            <AppList onInstall={() => setShowInstallDialog(true)} spaceMap={spaceMap} />
          </div>

          {/* Right: Detail panel */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Session detail breadcrumb — replaces AutomationHeader when drilling down */}
            {isSessionDetail && selectedApp && (
              <SessionBreadcrumb
                appName={selectedAppName ?? ''}
                runId={(detailView as { runId: string }).runId}
                onBack={() => openActivityThread(selectedApp.id)}
              />
            )}

            {/* App chat breadcrumb */}
            {isAppChat && selectedApp && (
              <SessionBreadcrumb
                appName={selectedAppName ?? ''}
                label={t('Chat')}
                onBack={() => openActivityThread(selectedApp.id)}
              />
            )}

            {/* App config breadcrumb */}
            {isAppConfig && selectedApp && (
              <SessionBreadcrumb
                appName={selectedAppName ?? ''}
                label={t('Settings')}
                onBack={() => openActivityThread(selectedApp.id)}
              />
            )}

            {/* App header bar — for automation apps (activity thread only) */}
            {!isSessionDetail && !isAppChat && !isAppConfig && !isUninstalledDetail && selectedAppId && detailView?.type === 'activity-thread' && (
              <AutomationHeader appId={selectedAppId} spaceName={spaceMap[selectedApp?.spaceId ?? '']} />
            )}

            {/* Detail content — app-chat manages its own scroll + flex layout */}
            <div className={`flex-1 ${isAppChat ? 'overflow-hidden' : 'overflow-y-auto'}`}>
              {renderDetail()}
            </div>
          </div>
        </div>
      ) : (
        <StoreView />
      )}

      {/* Install dialog */}
      {showInstallDialog && (
        <AppInstallDialog
          onClose={() => setShowInstallDialog(false)}
        />
      )}
    </div>
  )
}

// ──────────────────────────────────────────────
// Breadcrumb sub-component
// ──────────────────────────────────────────────

interface SessionBreadcrumbProps {
  appName: string
  runId?: string
  label?: string
  onBack: () => void
}

function SessionBreadcrumb({ appName, runId, label, onBack }: SessionBreadcrumbProps) {
  const { t } = useTranslation()
  // Show abbreviated run ID (first 8 chars)
  const shortRunId = runId ? (runId.length > 8 ? runId.slice(0, 8) : runId) : ''
  const displayLabel = label || (shortRunId ? `${t('Run')} ${shortRunId}` : '')

  return (
    <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-border bg-muted/30 flex-shrink-0">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-primary hover:text-primary/80 transition-colors font-medium"
      >
        <ChevronLeft className="w-3.5 h-3.5" />
        {appName}
      </button>
      {displayLabel && (
        <>
          <ChevronRight className="w-3 h-3 text-muted-foreground/50" />
          <span className="text-sm text-muted-foreground">
            {displayLabel}
          </span>
        </>
      )}
    </div>
  )
}
