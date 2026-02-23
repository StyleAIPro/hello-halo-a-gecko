/**
 * AppList
 *
 * Left sidebar of AppsPage. Groups installed apps by runtime status
 * and renders AppListItem rows. Shows install/store actions at the bottom.
 */

import { Plus } from 'lucide-react'
import type { InstalledApp } from '../../../shared/apps/app-types'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { AppListItem } from './AppListItem'
import { useTranslation } from '../../i18n'

interface AppListProps {
  onInstall: () => void
  /** Map from spaceId -> space name, for showing space labels on each app */
  spaceMap?: Record<string, string>
}

// ──────────────────────────────────────────────
// Grouping helpers
// ──────────────────────────────────────────────

type AppGroup = {
  label: string
  apps: InstalledApp[]
}

function groupApps(apps: InstalledApp[]): AppGroup[] {
  const running: InstalledApp[] = []
  const waitingUser: InstalledApp[] = []
  const paused: InstalledApp[] = []
  const installed: InstalledApp[] = []  // mcp / skill / extension
  const uninstalled: InstalledApp[] = []

  for (const app of apps) {
    if (app.status === 'uninstalled') {
      uninstalled.push(app)
      continue
    }
    const t = app.spec.type
    if (t === 'mcp' || t === 'skill' || t === 'extension') {
      installed.push(app)
    } else if (app.status === 'waiting_user') {
      waitingUser.push(app)
    } else if (app.status === 'paused') {
      paused.push(app)
    } else {
      // active (running/idle) + error
      running.push(app)
    }
  }

  const groups: AppGroup[] = []
  if (running.length > 0) groups.push({ label: 'Active', apps: running })
  if (waitingUser.length > 0) groups.push({ label: 'Waiting for you', apps: waitingUser })
  if (paused.length > 0) groups.push({ label: 'Paused', apps: paused })
  if (uninstalled.length > 0) groups.push({ label: 'Uninstalled', apps: uninstalled })
  if (installed.length > 0) groups.push({ label: 'Installed', apps: installed })
  return groups
}

// ──────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────

export function AppList({ onInstall, spaceMap }: AppListProps) {
  const { t } = useTranslation()
  const { apps } = useAppsStore()
  const { selectedAppId, selectApp } = useAppsPageStore()

  const groups = groupApps(apps)

  return (
    <div className="flex flex-col h-full">
      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto py-2 px-2 space-y-4">
        {groups.length === 0 && (
          <p className="text-xs text-muted-foreground px-2 py-4 text-center">
            {t('No digital humans yet')}
          </p>
        )}

        {groups.map(group => (
          <div key={group.label}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-1 mb-1">
              {t(group.label)}
              <span className="ml-1 font-normal normal-case tracking-normal">({group.apps.length})</span>
            </p>
            <div className="space-y-0.5">
              {group.apps.map(app => (
                <AppListItem
                  key={app.id}
                  app={app}
                  isSelected={selectedAppId === app.id}
                  spaceName={spaceMap?.[app.spaceId]}
                  onClick={() => {
                    // Route uninstalled apps to uninstalled-detail view
                    if (app.status === 'uninstalled') {
                      selectApp(app.id, 'uninstalled')
                    } else {
                      selectApp(app.id, app.spec.type)
                    }
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Bottom actions */}
      <div className="flex-shrink-0 border-t border-border p-2 space-y-1">
        <button
          onClick={onInstall}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-md transition-colors"
        >
          <Plus className="w-4 h-4" />
          {t('Create Digital Human')}
        </button>
      </div>
    </div>
  )
}
