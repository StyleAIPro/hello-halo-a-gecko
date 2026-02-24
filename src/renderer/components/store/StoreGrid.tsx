/**
 * Store Grid
 *
 * Responsive grid layout of StoreCard components.
 * Handles empty/loading states for the grid area.
 */

import { useAppsPageStore } from '../../stores/apps-page.store'
import { StoreCard } from './StoreCard'
import { useTranslation } from '../../i18n'
import { Package } from 'lucide-react'

export function StoreGrid() {
  const { t } = useTranslation()
  const storeApps = useAppsPageStore(state => state.storeApps)
  const selectStoreApp = useAppsPageStore(state => state.selectStoreApp)

  if (storeApps.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center">
          <Package className="w-6 h-6 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">
            {t('No apps found')}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {t('Try adjusting your search or filters')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
      {storeApps.map(entry => (
        <StoreCard
          key={entry.slug}
          entry={entry}
          onClick={() => selectStoreApp(entry.slug)}
        />
      ))}
    </div>
  )
}
