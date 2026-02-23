/**
 * EmptyState
 *
 * Shown in the right detail pane when no app is selected,
 * or when there are no installed apps.
 */

import { Blocks, Plus } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface EmptyStateProps {
  hasApps: boolean
  onInstall: () => void
}

export function EmptyState({ hasApps, onInstall }: EmptyStateProps) {
  const { t } = useTranslation()

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center">
        <Blocks className="w-6 h-6 text-muted-foreground" />
      </div>

      {hasApps ? (
        <>
          <div>
            <p className="text-sm font-medium text-foreground">{t('Select a digital human to view details')}</p>
            <p className="text-xs text-muted-foreground mt-1">{t('Choose a digital human from the list on the left')}</p>
          </div>
        </>
      ) : (
        <>
          <div>
            <p className="text-sm font-medium text-foreground">{t('No digital humans yet')}</p>
            <p className="text-xs text-muted-foreground mt-1">{t('Create your first digital human from a conversation')}</p>
          </div>
          <button
            onClick={onInstall}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t('Create Digital Human')}
          </button>
        </>
      )}
    </div>
  )
}
