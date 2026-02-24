/**
 * UninstalledDetailView
 *
 * Detail panel shown when an uninstalled (soft-deleted) app is selected.
 * Displays app info, uninstall date, and actions to reinstall or permanently delete.
 */

import { useState } from 'react'
import { RotateCcw, Trash2, AlertTriangle } from 'lucide-react'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { appTypeLabel } from './appTypeUtils'

interface UninstalledDetailViewProps {
  appId: string
  /** Space name to display */
  spaceName?: string
}

export function UninstalledDetailView({ appId, spaceName }: UninstalledDetailViewProps) {
  const { t } = useTranslation()
  const { apps, reinstallApp, deleteApp } = useAppsStore()
  const { selectApp, clearSelection } = useAppsPageStore()
  const app = apps.find(a => a.id === appId)

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isReinstalling, setIsReinstalling] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  if (!app) return null

  const { name, description } = resolveSpecI18n(app.spec, getCurrentLanguage())

  // Format the uninstalled date
  const uninstalledDate = app.uninstalledAt
    ? new Date(app.uninstalledAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null

  const handleReinstall = async () => {
    setIsReinstalling(true)
    const success = await reinstallApp(appId)
    setIsReinstalling(false)
    if (success) {
      // Navigate to the app's activity thread after reinstall
      selectApp(appId, app.spec.type)
    }
  }

  const handleDelete = async () => {
    setIsDeleting(true)
    const success = await deleteApp(appId)
    setIsDeleting(false)
    if (success) {
      clearSelection()
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-lg mx-auto space-y-6">
        {/* App identity */}
        <div className="text-center">
          <h2 className="text-lg font-semibold text-foreground">{name}</h2>
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
          <div className="flex items-center justify-center gap-2 mt-2">
            <span className="text-xs text-muted-foreground">
              v{app.spec.version} · {app.spec.author}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wide">
              {t(appTypeLabel(app.spec.type))}
            </span>
          </div>
          {spaceName && (
            <p className="text-xs text-muted-foreground/70 mt-1">{spaceName}</p>
          )}
        </div>

        {/* Status banner */}
        <div className="bg-muted/50 border border-border rounded-lg p-4 text-center space-y-1">
          <p className="text-sm font-medium text-muted-foreground">
            {t('This app has been uninstalled')}
          </p>
          {uninstalledDate && (
            <p className="text-xs text-muted-foreground/70">
              {t('Uninstalled on {{date}}', { date: uninstalledDate })}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="space-y-3">
          {/* Reinstall button */}
          <button
            onClick={handleReinstall}
            disabled={isReinstalling}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-foreground bg-primary/10 hover:bg-primary/20 border border-primary/20 rounded-lg transition-colors disabled:opacity-50"
          >
            <RotateCcw className={`w-4 h-4 ${isReinstalling ? 'animate-spin' : ''}`} />
            {isReinstalling ? t('Reinstalling...') : t('Reinstall App')}
          </button>

          {/* Delete permanently */}
          {showDeleteConfirm ? (
            <div className="p-3 border border-red-400/30 rounded-lg space-y-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-muted-foreground">
                  {t('This will permanently delete the app and all its data. This action cannot be undone.')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="px-3 py-1.5 text-sm text-red-400 hover:text-red-300 border border-red-400/30 hover:border-red-400/60 rounded-lg transition-colors disabled:opacity-50"
                >
                  {isDeleting ? t('Deleting...') : t('Yes, Delete Permanently')}
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground rounded-lg transition-colors"
                >
                  {t('Cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm text-red-400 hover:text-red-300 border border-red-400/30 hover:border-red-400/60 rounded-lg transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              {t('Delete Permanently')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
