/**
 * SkillInfoCard
 *
 * Right-panel detail view for a Skill-type app.
 * Shows trigger command, description, and uninstall action.
 */

import { Terminal, Unplug } from 'lucide-react'
import { useAppsStore } from '../../stores/apps.store'
import { AppStatusDot } from './AppStatusDot'
import { useTranslation } from '../../i18n'

interface SkillInfoCardProps {
  appId: string
}

export function SkillInfoCard({ appId }: SkillInfoCardProps) {
  const { t } = useTranslation()
  const { apps, uninstallApp } = useAppsStore()
  const app = apps.find(a => a.id === appId)

  if (!app) return null

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">{app.spec.name}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">by {app.spec.author}</p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <AppStatusDot status={app.status} size="sm" />
          <span>{app.status === 'active' ? t('Enabled') : t(app.status)}</span>
        </div>
      </div>

      {/* Trigger */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Terminal className="w-3.5 h-3.5" />
          {t('How to use')}
        </h3>
        <div className="bg-secondary rounded-lg p-3 text-xs font-mono text-foreground">
          /{app.spec.name.toLowerCase().replace(/\s+/g, '-')} [arguments]
        </div>
        <p className="text-xs text-muted-foreground">
          {t('Invoke this skill by typing the command above in any conversation.')}
        </p>
      </div>

      {/* Description */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('Description')}</h3>
        <p className="text-sm text-foreground">{app.spec.description}</p>
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
