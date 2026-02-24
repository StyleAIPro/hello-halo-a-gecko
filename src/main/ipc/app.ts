/**
 * App Management IPC Handlers
 *
 * Exposes the AppManager and AppRuntime services to the renderer process.
 * All handlers lazily resolve the singleton instances at call time, so they
 * can be registered before the async platform init completes.
 *
 * Channels:
 *   app:install            Install an App into a space
 *   app:uninstall          Uninstall an App (soft-delete)
 *   app:reinstall          Reinstall a previously uninstalled App
 *   app:delete             Permanently delete an uninstalled App
 *   app:list               List all installed Apps (optionally filtered)
 *   app:get                Get a single installed App by ID
 *   app:pause              Pause an active App
 *   app:resume             Resume a paused App
 *   app:trigger            Manually trigger a run
 *   app:get-state          Get real-time automation state
 *   app:get-activity       Get activity log entries for an App
 *   app:respond-escalation Respond to a pending user escalation
 *   app:update-config      Update App user configuration
 *   app:update-frequency   Update subscription frequency override
 *   app:update-spec        Update App spec (JSON Merge Patch)
 *   app:chat-send          Send a chat message to an App's AI agent
 *   app:chat-stop          Stop an active app chat generation
 *   app:chat-status        Get app chat status (generating + conversationId)
 *   app:chat-messages      Load persisted chat messages for an app
 *   app:chat-session-state Get session state for recovery after refresh
 *   app:export-spec        Export an app's spec as a YAML string
 *   app:import-spec        Install an app from a YAML spec string
 */

import { ipcMain } from 'electron'
import { getAppManager } from '../apps/manager'
import {
  getAppRuntime,
  sendAppChatMessage,
  stopAppChat,
  isAppChatGenerating,
  loadAppChatMessages,
  getAppChatSessionState,
  getAppChatConversationId,
} from '../apps/runtime'
import type { AppSpec } from '../apps/spec'
import type { AppListFilter, UninstallOptions } from '../apps/manager'
import type { ActivityQueryOptions, EscalationResponse, AppChatRequest } from '../apps/runtime'
import { readSessionMessages } from '../apps/runtime/session-store'
import { getSpace } from '../services/space.service'
import { getMainWindow } from '../services/window.service'
import { broadcastToAll } from '../http/websocket'
import * as appController from '../controllers/app.controller'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the AppManager singleton or return an error response.
 * The manager initializes asynchronously; callers should handle not-ready state.
 */
function requireManager() {
  const manager = getAppManager()
  if (!manager) {
    return { success: false as const, error: 'App Manager is not yet initialized. Please try again shortly.' }
  }
  return { success: true as const, manager }
}

/**
 * Resolve the AppRuntime singleton or return an error response.
 */
function requireRuntime() {
  const runtime = getAppRuntime()
  if (!runtime) {
    return { success: false as const, error: 'App Runtime is not yet initialized. Please try again shortly.' }
  }
  return { success: true as const, runtime }
}

// ---------------------------------------------------------------------------
// Handler Registration
// ---------------------------------------------------------------------------

export function registerAppHandlers(): void {
  // ── app:install ──────────────────────────────────────────────────────────
  ipcMain.handle(
    'app:install',
    async (_event, input: { spaceId: string; spec: AppSpec; userConfig?: Record<string, unknown> }) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        const appId = await r.manager.install(input.spaceId, input.spec, input.userConfig)

        // Auto-activate in the runtime if runtime is ready
        const runtime = getAppRuntime()
        let activationWarning: string | undefined
        if (runtime) {
          try {
            await runtime.activate(appId)
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            console.warn(`[AppIPC] app:install -- runtime activate failed: ${errMsg}`)
            activationWarning = errMsg
          }
        }

        console.log(`[AppIPC] app:install: appId=${appId}, space=${input.spaceId}`)
        return { success: true, data: { appId, activationWarning } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:install error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:uninstall ────────────────────────────────────────────────────────
  ipcMain.handle(
    'app:uninstall',
    async (_event, input: { appId: string; options?: UninstallOptions }) => {
      try {
        const r = requireManager()
        if (!r.success) return r

        // Deactivate in runtime first (removes scheduler jobs + event subs)
        const runtime = getAppRuntime()
        if (runtime) {
          await runtime.deactivate(input.appId).catch(err => {
            console.warn(`[AppIPC] app:uninstall -- runtime deactivate failed (non-fatal): ${err}`)
          })
        }

        await r.manager.uninstall(input.appId, input.options)
        console.log(`[AppIPC] app:uninstall: appId=${input.appId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:uninstall error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:reinstall ──────────────────────────────────────────────────────
  ipcMain.handle(
    'app:reinstall',
    async (_event, input: { appId: string }) => {
      try {
        const r = requireManager()
        if (!r.success) return r

        r.manager.reinstall(input.appId)

        // Re-activate in runtime
        const runtime = getAppRuntime()
        let activationWarning: string | undefined
        if (runtime) {
          try {
            await runtime.activate(input.appId)
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            console.warn(`[AppIPC] app:reinstall -- runtime activate failed: ${errMsg}`)
            activationWarning = errMsg
          }
        }

        console.log(`[AppIPC] app:reinstall: appId=${input.appId}`)
        return { success: true, data: { activationWarning } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:reinstall error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:delete ─────────────────────────────────────────────────────────
  ipcMain.handle(
    'app:delete',
    async (_event, input: { appId: string }) => {
      try {
        const r = requireManager()
        if (!r.success) return r

        await r.manager.deleteApp(input.appId)
        broadcastToAll('app:deleted', { appId: input.appId })
        console.log(`[AppIPC] app:delete: appId=${input.appId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:delete error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:list ─────────────────────────────────────────────────────────────
  ipcMain.handle(
    'app:list',
    async (_event, filter?: AppListFilter) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        const apps = r.manager.listApps(filter)
        return { success: true, data: apps }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:list error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:get ──────────────────────────────────────────────────────────────
  ipcMain.handle(
    'app:get',
    async (_event, appId: string) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        const app = r.manager.getApp(appId)
        return { success: true, data: app }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:get error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:pause ────────────────────────────────────────────────────────────
  ipcMain.handle(
    'app:pause',
    async (_event, appId: string) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.pause(appId)

        // Deactivate in runtime (stops scheduler + event subscriptions)
        const runtime = getAppRuntime()
        if (runtime) {
          await runtime.deactivate(appId).catch(err => {
            console.warn(`[AppIPC] app:pause -- runtime deactivate failed (non-fatal): ${err}`)
          })
        }

        console.log(`[AppIPC] app:pause: appId=${appId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:pause error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:resume ───────────────────────────────────────────────────────────
  ipcMain.handle(
    'app:resume',
    async (_event, appId: string) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.resume(appId)

        // Re-activate in runtime
        const runtime = getAppRuntime()
        let activationWarning: string | undefined
        if (runtime) {
          try {
            await runtime.activate(appId)
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            console.warn(`[AppIPC] app:resume -- runtime activate failed: ${errMsg}`)
            activationWarning = errMsg
          }
        }

        console.log(`[AppIPC] app:resume: appId=${appId}`)
        return { success: true, data: { activationWarning } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:resume error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:trigger ──────────────────────────────────────────────────────────
  ipcMain.handle(
    'app:trigger',
    async (_event, appId: string) => {
      try {
        const r = requireRuntime()
        if (!r.success) return r
        const result = await r.runtime.triggerManually(appId)
        console.log(`[AppIPC] app:trigger: appId=${appId}, outcome=${result.outcome}`)
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:trigger error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:get-state ────────────────────────────────────────────────────────
  ipcMain.handle(
    'app:get-state',
    async (_event, appId: string) => {
      try {
        const r = requireRuntime()
        if (!r.success) return r
        const state = r.runtime.getAppState(appId)
        return { success: true, data: state }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:get-state error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:get-activity ─────────────────────────────────────────────────────
  ipcMain.handle(
    'app:get-activity',
    async (_event, input: { appId: string; options?: ActivityQueryOptions }) => {
      try {
        const r = requireRuntime()
        if (!r.success) return r
        const entries = r.runtime.getActivityEntries(input.appId, input.options)
        return { success: true, data: entries }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:get-activity error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:respond-escalation ───────────────────────────────────────────────
  ipcMain.handle(
    'app:respond-escalation',
    async (_event, input: { appId: string; escalationId: string; response: EscalationResponse }) => {
      try {
        const r = requireRuntime()
        if (!r.success) return r
        await r.runtime.respondToEscalation(input.appId, input.escalationId, input.response)
        console.log(`[AppIPC] app:respond-escalation: appId=${input.appId}, escalationId=${input.escalationId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:respond-escalation error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:update-config ────────────────────────────────────────────────────
  ipcMain.handle(
    'app:update-config',
    async (_event, input: { appId: string; config: Record<string, unknown> }) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.updateConfig(input.appId, input.config)
        console.log(`[AppIPC] app:update-config: appId=${input.appId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:update-config error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:update-frequency ─────────────────────────────────────────────────
  ipcMain.handle(
    'app:update-frequency',
    async (_event, input: { appId: string; subscriptionId: string; frequency: string }) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.updateFrequency(input.appId, input.subscriptionId, input.frequency)
        console.log(`[AppIPC] app:update-frequency: appId=${input.appId}, sub=${input.subscriptionId}`)

        // Hot-sync scheduler job so the new frequency takes effect immediately
        // without interrupting any running execution
        const runtime = getAppRuntime()
        if (runtime) {
          runtime.syncAppSchedule(input.appId)
        }

        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:update-frequency error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:update-overrides ────────────────────────────────────────────────
  ipcMain.handle(
    'app:update-overrides',
    async (_event, input: { appId: string; overrides: Record<string, unknown> }) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.updateOverrides(input.appId, input.overrides)
        console.log(`[AppIPC] app:update-overrides: appId=${input.appId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:update-overrides error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:update-spec ──────────────────────────────────────────────────────
  ipcMain.handle(
    'app:update-spec',
    async (_event, input: { appId: string; specPatch: Record<string, unknown> }) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.updateSpec(input.appId, input.specPatch)

        // Reactivate runtime if subscriptions changed
        if (input.specPatch.subscriptions) {
          const runtime = getAppRuntime()
          const app = r.manager.getApp(input.appId)
          if (runtime && app?.status === 'active') {
            await runtime.deactivate(input.appId).catch(() => {})
            await runtime.activate(input.appId).catch(err => {
              console.warn(`[AppIPC] app:update-spec -- reactivation failed (non-fatal): ${err}`)
            })
          }
        }

        console.log(`[AppIPC] app:update-spec: appId=${input.appId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:update-spec error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:grant-permission ──────────────────────────────────────────────────
  ipcMain.handle(
    'app:grant-permission',
    async (_event, input: { appId: string; permission: string }) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.grantPermission(input.appId, input.permission)
        console.log(`[AppIPC] app:grant-permission: appId=${input.appId}, permission=${input.permission}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:grant-permission error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:revoke-permission ─────────────────────────────────────────────────
  ipcMain.handle(
    'app:revoke-permission',
    async (_event, input: { appId: string; permission: string }) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.revokePermission(input.appId, input.permission)
        console.log(`[AppIPC] app:revoke-permission: appId=${input.appId}, permission=${input.permission}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:revoke-permission error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:get-session ──────────────────────────────────────────────────────
  ipcMain.handle(
    'app:get-session',
    async (_event, input: { appId: string; runId: string }) => {
      try {
        const r = requireManager()
        if (!r.success) return r

        const app = r.manager.getApp(input.appId)
        if (!app) {
          return { success: false, error: `App not found: ${input.appId}` }
        }

        const space = getSpace(app.spaceId)
        if (!space?.path) {
          return { success: false, error: `Space not found for app: ${input.appId}` }
        }

        const messages = readSessionMessages(space.path, input.appId, input.runId)
        return { success: true, data: messages }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:get-session error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:chat-send ─────────────────────────────────────────────────────
  ipcMain.handle(
    'app:chat-send',
    async (_event, request: AppChatRequest) => {
      try {
        // Fire-and-forget: streaming events are pushed to renderer via agent:* channels.
        // We don't await the full completion here because the renderer listens for
        // real-time events (agent:message, agent:thought, etc.) keyed by conversationId.
        sendAppChatMessage(getMainWindow(), request).catch((error: unknown) => {
          const err = error as Error
          console.error(`[AppIPC] app:chat-send background error:`, err.message)
        })
        console.log(`[AppIPC] app:chat-send: appId=${request.appId}`)
        return {
          success: true,
          data: { conversationId: getAppChatConversationId(request.appId) }
        }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:chat-send error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:chat-stop ──────────────────────────────────────────────────────
  ipcMain.handle(
    'app:chat-stop',
    async (_event, appId: string) => {
      try {
        await stopAppChat(appId)
        console.log(`[AppIPC] app:chat-stop: appId=${appId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:chat-stop error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:chat-status ────────────────────────────────────────────────────
  ipcMain.handle(
    'app:chat-status',
    async (_event, appId: string) => {
      try {
        return {
          success: true,
          data: {
            isGenerating: isAppChatGenerating(appId),
            conversationId: getAppChatConversationId(appId),
          }
        }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:chat-status error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:chat-messages ──────────────────────────────────────────────────
  ipcMain.handle(
    'app:chat-messages',
    async (_event, input: { appId: string; spaceId: string }) => {
      try {
        const space = getSpace(input.spaceId)
        if (!space?.path) {
          return { success: true, data: [] }
        }
        const messages = loadAppChatMessages(space.path, input.appId)
        return { success: true, data: messages }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:chat-messages error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:chat-session-state ─────────────────────────────────────────────
  ipcMain.handle(
    'app:chat-session-state',
    async (_event, appId: string) => {
      try {
        const state = getAppChatSessionState(appId)
        return { success: true, data: state }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:chat-session-state error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:export-spec ────────────────────────────────────────────────────
  ipcMain.handle(
    'app:export-spec',
    async (_event, appId: string) => {
      try {
        const result = appController.exportSpec(appId)
        if (result.success) {
          console.log(`[AppIPC] app:export-spec: appId=${appId}`)
        }
        return result
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:export-spec error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ── app:import-spec ────────────────────────────────────────────────────
  ipcMain.handle(
    'app:import-spec',
    async (_event, input: { spaceId: string; yamlContent: string; userConfig?: Record<string, unknown> }) => {
      try {
        const result = await appController.importSpec(input)
        if (result.success) {
          console.log(`[AppIPC] app:import-spec: appId=${(result.data as any)?.appId}, space=${input.spaceId}`)
        }
        return result
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:import-spec error:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  console.log('[AppIPC] App management handlers registered (23 channels)')
}
