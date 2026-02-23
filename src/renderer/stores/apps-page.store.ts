/**
 * Apps Page Navigation Store
 *
 * Manages UI-level state within the AppsPage:
 * - Which app is selected
 * - Which detail panel is showing
 * - Install dialog visibility
 *
 * Intentionally separate from apps.store.ts (data) so that
 * page navigation changes don't cause unnecessary data re-fetches.
 */

import { create } from 'zustand'

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

// ============================================
// State Interface
// ============================================

interface AppsPageState {
  selectedAppId: string | null
  detailView: AppsDetailView
  /** Set externally (from badge/notification) before navigating to AppsPage */
  initialAppId: string | null
  showInstallDialog: boolean

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
}

// ============================================
// Store
// ============================================

export const useAppsPageStore = create<AppsPageState>((set) => ({
  selectedAppId: null,
  detailView: null,
  initialAppId: null,
  showInstallDialog: false,

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
  }),
}))
