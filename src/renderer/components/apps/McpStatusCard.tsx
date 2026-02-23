/**
 * McpStatusCard
 *
 * Right-panel detail view for an MCP-type app.
 * Shows connection info, provided tools, and uninstall action.
 */

import { Wrench, Unplug } from 'lucide-react'
import { useAppsStore } from '../../stores/apps.store'
import { AppStatusDot } from './AppStatusDot'
import { useTranslation } from '../../i18n'

interface McpStatusCardProps {
  appId: string
}

export function McpStatusCard({ appId }: McpStatusCardProps) {
  const { t } = useTranslation()
  const { apps, uninstallApp } = useAppsStore()
  const app = apps.find(a => a.id === appId)

  if (!app) return null

  const mcpServer = app.spec.mcp_server

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">{app.spec.name}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">{app.spec.description}</p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <AppStatusDot status={app.status} size="sm" />
          <span>{app.status === 'active' ? t('Connected') : t(app.status)}</span>
        </div>
      </div>

      {/* Connection info */}
      {mcpServer && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('Connection')}</h3>
          <div className="bg-secondary rounded-lg p-3 text-xs font-mono space-y-1">
            <div className="flex gap-2">
              <span className="text-muted-foreground w-20 flex-shrink-0">{t('Command')}</span>
              <span className="text-foreground truncate">{mcpServer.command}</span>
            </div>
            {mcpServer.args && mcpServer.args.length > 0 && (
              <div className="flex gap-2">
                <span className="text-muted-foreground w-20 flex-shrink-0">{t('Args')}</span>
                <span className="text-foreground truncate">{mcpServer.args.join(' ')}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tools (from spec) */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Wrench className="w-3.5 h-3.5" />
          {t('Tools provided by this server')}
        </h3>
        <p className="text-xs text-muted-foreground italic">
          {t('Tool list is available after the MCP server connects.')}
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2">
        <button
          onClick={() => uninstallApp(appId)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-400 hover:text-red-300 border border-red-400/30 hover:border-red-400/60 rounded-lg transition-colors"
        >
          <Unplug className="w-4 h-4" />
          {t('Uninstall')}
        </button>
      </div>
    </div>
  )
}
