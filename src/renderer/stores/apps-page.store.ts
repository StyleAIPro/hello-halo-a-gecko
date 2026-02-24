/**
 * Apps Page Navigation Store
 *
 * Manages UI-level state within the AppsPage:
 * - Which app is selected
 * - Which detail panel is showing
 * - Install dialog visibility
 * - Store tab browsing state
 *
 * Intentionally separate from apps.store.ts (data) so that
 * page navigation changes don't cause unnecessary data re-fetches.
 */

import { create } from 'zustand'
import { api } from '../api'
import type { RegistryEntry, StoreAppDetail, UpdateInfo, StoreQuery } from '../../shared/store/store-types'

let storeListRequestSeq = 0
let storeDetailRequestSeq = 0

// ============================================
// Types
// ============================================

export type AppsDetailViewType = 'activity-thread' | 'session-detail' | 'app-chat' | 'app-config' | 'mcp-status' | 'skill-info' | 'uninstalled-detail'

export type AppsDetailView =
  | { type: 'activity-thread'; appId: string }
  | { type: 'session-detail'; appId: string; runId: string; sessionKey: string }
  | { type: 'app-chat'; appId: string; spaceId: string }
  | { type: 'app-config'; appId: string }
  | { type: 'mcp-status'; appId: string }
  | { type: 'skill-info'; appId: string }
  | { type: 'uninstalled-detail'; appId: string }
  | null

export type AppsPageTab = 'my-digital-humans' | 'store'

// ============================================
// State Interface
// ============================================

interface AppsPageState {
  selectedAppId: string | null
  detailView: AppsDetailView
  /** Set externally (from badge/notification) before navigating to AppsPage */
  initialAppId: string | null
  showInstallDialog: boolean

  // ── Tab State ──────────────────────────────
  currentTab: AppsPageTab

  // ── Store Tab State ────────────────────────
  storeApps: RegistryEntry[]
  storeLoading: boolean
  storeError: string | null
  storeSearchQuery: string
  storeCategory: string | null
  storeSelectedSlug: string | null
  storeSelectedDetail: StoreAppDetail | null
  storeDetailLoading: boolean

  // ── Update Info ────────────────────────────
  availableUpdates: UpdateInfo[]

  // Actions
  selectApp: (appId: string, appType?: string) => void
  clearSelection: () => void
  openActivityThread: (appId: string) => void
  openSessionDetail: (appId: string, runId: string, sessionKey: string) => void
  openAppChat: (appId: string, spaceId: string) => void
  openAppConfig: (appId: string) => void
  setInitialAppId: (appId: string | null) => void
  setShowInstallDialog: (show: boolean) => void
  reset: () => void

  // ── Store Actions ──────────────────────────
  setCurrentTab: (tab: AppsPageTab) => void
  loadStoreApps: (query?: StoreQuery) => Promise<void>
  setStoreSearch: (query: string) => void
  setStoreCategory: (category: string | null) => void
  selectStoreApp: (slug: string) => Promise<void>
  clearStoreSelection: () => void
  installFromStore: (slug: string, spaceId: string, userConfig?: Record<string, unknown>) => Promise<string | null>
  refreshStore: () => Promise<void>
  checkUpdates: () => Promise<void>
}

// ============================================
// Store
// ============================================

export const useAppsPageStore = create<AppsPageState>((set, get) => ({
  selectedAppId: null,
  detailView: null,
  initialAppId: null,
  showInstallDialog: false,

  // ── Tab State ──────────────────────────────
  currentTab: 'my-digital-humans',

  // ── Store Tab State ────────────────────────
  storeApps: [],
  storeLoading: false,
  storeError: null,
  storeSearchQuery: '',
  storeCategory: null,
  storeSelectedSlug: null,
  storeSelectedDetail: null,
  storeDetailLoading: false,

  // ── Update Info ────────────────────────────
  availableUpdates: [],

  selectApp: (appId, appType) => {
    let detailView: AppsDetailView = { type: 'activity-thread', appId }
    if (appType === 'mcp') detailView = { type: 'mcp-status', appId }
    if (appType === 'skill') detailView = { type: 'skill-info', appId }
    if (appType === 'uninstalled') detailView = { type: 'uninstalled-detail', appId }
    set({ selectedAppId: appId, detailView })
  },

  clearSelection: () => set({ selectedAppId: null, detailView: null }),

  openActivityThread: (appId) =>
    set({ selectedAppId: appId, detailView: { type: 'activity-thread', appId } }),

  openSessionDetail: (appId, runId, sessionKey) =>
    set({ selectedAppId: appId, detailView: { type: 'session-detail', appId, runId, sessionKey } }),

  openAppChat: (appId, spaceId) =>
    set({ selectedAppId: appId, detailView: { type: 'app-chat', appId, spaceId } }),

  openAppConfig: (appId) =>
    set({ selectedAppId: appId, detailView: { type: 'app-config', appId } }),

  setInitialAppId: (appId) => set({ initialAppId: appId }),

  setShowInstallDialog: (show) => set({ showInstallDialog: show }),

  reset: () => set({
    selectedAppId: null,
    detailView: null,
    initialAppId: null,
    showInstallDialog: false,
    currentTab: 'my-digital-humans',
    storeApps: [],
    storeLoading: false,
    storeError: null,
    storeSearchQuery: '',
    storeCategory: null,
    storeSelectedSlug: null,
    storeSelectedDetail: null,
    storeDetailLoading: false,
    availableUpdates: [],
  }),

  // ── Store Actions ──────────────────────────

  setCurrentTab: (tab) => set({ currentTab: tab }),

  loadStoreApps: async (query) => {
    const requestId = ++storeListRequestSeq
    set({ storeLoading: true, storeError: null })
    try {
      const res = await api.storeListApps(query ?? {
        search: get().storeSearchQuery || undefined,
        category: get().storeCategory ?? undefined,
      })
      if (requestId !== storeListRequestSeq) return

      if (res.success && res.data) {
        set({ storeApps: res.data as RegistryEntry[] })
      } else {
        set({ storeError: (res.error as string) || 'Failed to load store apps' })
      }
    } catch (err) {
      if (requestId !== storeListRequestSeq) return
      console.error('[AppsPageStore] loadStoreApps error:', err)
      set({ storeError: 'Failed to load store apps' })
    } finally {
      if (requestId === storeListRequestSeq) {
        set({ storeLoading: false })
      }
    }
  },

  setStoreSearch: (query) => set({ storeSearchQuery: query }),

  setStoreCategory: (category) => set({ storeCategory: category }),

  selectStoreApp: async (slug) => {
    const requestId = ++storeDetailRequestSeq
    set({ storeSelectedSlug: slug, storeDetailLoading: true, storeSelectedDetail: null })
    try {
      const res = await api.storeGetAppDetail(slug)
      if (requestId !== storeDetailRequestSeq) return

      if (res.success && res.data) {
        set({ storeSelectedDetail: res.data as StoreAppDetail })
      } else {
        console.error('[AppsPageStore] selectStoreApp failed:', res.error)
        // Clear selection on error so user is returned to grid
        set({ storeSelectedSlug: null, storeError: (res.error as string) || 'Failed to load app detail' })
      }
    } catch (err) {
      if (requestId !== storeDetailRequestSeq) return
      console.error('[AppsPageStore] selectStoreApp error:', err)
      set({ storeSelectedSlug: null, storeError: 'Failed to load app detail' })
    } finally {
      if (requestId === storeDetailRequestSeq) {
        set({ storeDetailLoading: false })
      }
    }
  },

  clearStoreSelection: () => set({
    storeSelectedSlug: null,
    storeSelectedDetail: null,
    storeDetailLoading: false,
    storeError: null,
  }),

  installFromStore: async (slug, spaceId, userConfig) => {
    try {
      const res = await api.storeInstall(slug, spaceId, userConfig)
      if (res.success && (res.data as { appId?: string })?.appId) {
        set({ storeError: null })
        return (res.data as { appId: string }).appId
      }
      set({ storeError: (res.error as string) || 'Installation failed' })
      return null
    } catch (err) {
      console.error('[AppsPageStore] installFromStore error:', err)
      set({ storeError: 'Installation failed' })
      return null
    }
  },

  refreshStore: async () => {
    try {
      const res = await api.storeRefresh()
      if (!res.success) {
        set({ storeError: (res.error as string) || 'Failed to refresh store index' })
        return
      }
      // Reload store apps after refresh
      await get().loadStoreApps()
      await get().checkUpdates()
    } catch (err) {
      console.error('[AppsPageStore] refreshStore error:', err)
      set({ storeError: 'Failed to refresh store index' })
    }
  },

  checkUpdates: async () => {
    try {
      const res = await api.storeCheckUpdates()
      if (res.success && res.data) {
        set({ availableUpdates: res.data as UpdateInfo[] })
      } else if (!res.success) {
        console.warn('[AppsPageStore] checkUpdates failed:', res.error)
      }
    } catch (err) {
      console.error('[AppsPageStore] checkUpdates error:', err)
    }
  },
}))
