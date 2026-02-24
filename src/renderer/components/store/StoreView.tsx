/**
 * Store View
 *
 * Main container for the App Store tab. Handles layout coordination
 * between the header (search/filter), grid/detail views, and install dialog.
 */

import { useEffect, useRef } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { StoreHeader } from './StoreHeader'
import { StoreGrid } from './StoreGrid'
import { StoreDetail } from './StoreDetail'
import { useTranslation } from '../../i18n'

export function StoreView() {
  const { t } = useTranslation()
  const storeLoading = useAppsPageStore(state => state.storeLoading)
  const storeError = useAppsPageStore(state => state.storeError)
  const storeSelectedSlug = useAppsPageStore(state => state.storeSelectedSlug)
  const storeApps = useAppsPageStore(state => state.storeApps)
  const loadStoreApps = useAppsPageStore(state => state.loadStoreApps)
  const checkUpdates = useAppsPageStore(state => state.checkUpdates)
  const didInitRef = useRef(false)

  // Load store apps and update badges on mount.
  useEffect(() => {
    if (didInitRef.current) return
    didInitRef.current = true

    if (storeApps.length === 0) {
      void loadStoreApps()
    }
    void checkUpdates()
  }, [storeApps.length, loadStoreApps, checkUpdates])

  // Error state
  if (storeError && !storeLoading && storeApps.length === 0) {
    return (
      <div className="flex-1 flex flex-col">
        <StoreHeader />
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="w-12 h-12 rounded-xl bg-red-500/10 flex items-center justify-center">
            <AlertCircle className="w-6 h-6 text-red-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              {t('Failed to load store')}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {storeError}
            </p>
          </div>
          <button
            onClick={() => loadStoreApps()}
            className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            {t('Retry')}
          </button>
        </div>
      </div>
    )
  }

  // Loading state (initial load only)
  if (storeLoading && storeApps.length === 0) {
    return (
      <div className="flex-1 flex flex-col">
        <StoreHeader />
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  // Detail view
  if (storeSelectedSlug) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <StoreDetail />
      </div>
    )
  }

  // Grid view
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <StoreHeader />
      <div className="flex-1 overflow-y-auto">
        <StoreGrid />
      </div>
    </div>
  )
}
