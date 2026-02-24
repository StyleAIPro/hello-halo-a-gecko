/**
 * Store Header
 *
 * Search input and category filter chips for the store.
 * Provides real-time filtering as user types or selects categories.
 */

import { useCallback, useEffect, useRef } from 'react'
import { Search, RefreshCw } from 'lucide-react'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { STORE_CATEGORY_META } from '../../../shared/store/store-types'
import { useTranslation } from '../../i18n'

export function StoreHeader() {
  const { t } = useTranslation()
  const storeSearchQuery = useAppsPageStore(state => state.storeSearchQuery)
  const storeCategory = useAppsPageStore(state => state.storeCategory)
  const storeLoading = useAppsPageStore(state => state.storeLoading)
  const setStoreSearch = useAppsPageStore(state => state.setStoreSearch)
  const setStoreCategory = useAppsPageStore(state => state.setStoreCategory)
  const loadStoreApps = useAppsPageStore(state => state.loadStoreApps)
  const refreshStore = useAppsPageStore(state => state.refreshStore)

  // Debounce timer ref for search
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounced search: triggers loadStoreApps 300ms after typing stops
  const handleSearchChange = useCallback((value: string) => {
    setStoreSearch(value)
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    debounceRef.current = setTimeout(() => {
      loadStoreApps({ search: value || undefined, category: useAppsPageStore.getState().storeCategory ?? undefined })
    }, 300)
  }, [setStoreSearch, loadStoreApps])

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  // Category click triggers immediate filter
  const handleCategoryClick = useCallback((categoryId: string | null) => {
    setStoreCategory(categoryId)
    loadStoreApps({
      search: useAppsPageStore.getState().storeSearchQuery || undefined,
      category: categoryId ?? undefined,
    })
  }, [setStoreCategory, loadStoreApps])

  return (
    <div className="flex flex-col gap-3 px-4 py-3 border-b border-border flex-shrink-0">
      {/* Search + Refresh row */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={storeSearchQuery}
            onChange={e => handleSearchChange(e.target.value)}
            placeholder={t('Search apps...')}
            className="w-full pl-9 pr-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
          />
        </div>
        <button
          onClick={refreshStore}
          disabled={storeLoading}
          className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-lg transition-colors disabled:opacity-50"
          title={t('Refresh')}
        >
          <RefreshCw className={`w-4 h-4 ${storeLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Category chips */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
        <button
          onClick={() => handleCategoryClick(null)}
          className={`flex-shrink-0 px-2.5 py-1 text-xs rounded-md transition-colors ${
            storeCategory === null
              ? 'bg-secondary text-foreground font-medium'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
          }`}
        >
          {t('All')}
        </button>
        {STORE_CATEGORY_META.map(cat => (
          <button
            key={cat.id}
            onClick={() => handleCategoryClick(cat.id)}
            className={`flex-shrink-0 px-2.5 py-1 text-xs rounded-md transition-colors ${
              storeCategory === cat.id
                ? 'bg-secondary text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
            }`}
          >
            {cat.icon} {t(cat.labelKey)}
          </button>
        ))}
      </div>
    </div>
  )
}
