import { wrapIpcHandle } from './ipc-logger';
/**
 * Store IPC Handlers
 *
 * Exposes the Store (App Registry) operations to the renderer process.
 *
 * Channels:
 *   store:list-apps       List apps from the store with optional filtering
 *   store:get-app-detail  Get detailed info about a store app by slug
 *   store:install         Install an app from the store into a space
 *   store:refresh         Refresh the registry index from remote sources
 *   store:check-updates   Check for available updates for installed apps
 *   store:get-registries  Get the list of configured registry sources
 *   store:add-registry    Add a new registry source
 *   store:remove-registry Remove a registry source
 *   store:toggle-registry Enable or disable a registry source
 */

import { ipcMain } from 'electron';
import * as storeController from '../controllers/store.controller';

export function registerStoreHandlers(): void {
  // ── store:list-apps ────────────────────────────────────────────────────
  wrapIpcHandle(
    'store:list-apps',
    async (
      _event,
      query?: { search?: string; category?: string; type?: string; tags?: string[] },
    ) => {
      return storeController.listStoreApps(query);
    },
  );

  // ── store:get-app-detail ───────────────────────────────────────────────
  wrapIpcHandle('store:get-app-detail', async (_event, slug: string) => {
    return storeController.getStoreAppDetail(slug);
  });

  // ── store:install ──────────────────────────────────────────────────────
  wrapIpcHandle(
    'store:install',
    async (
      _event,
      input: { slug: string; spaceId: string; userConfig?: Record<string, unknown> },
    ) => {
      return storeController.installStoreApp(input.slug, input.spaceId, input.userConfig);
    },
  );

  // ── store:refresh ──────────────────────────────────────────────────────
  wrapIpcHandle('store:refresh', async () => {
    return storeController.refreshStoreIndex();
  });

  // ── store:check-updates ────────────────────────────────────────────────
  wrapIpcHandle('store:check-updates', async () => {
    return storeController.checkStoreUpdates();
  });

  // ── store:get-registries ───────────────────────────────────────────────
  wrapIpcHandle('store:get-registries', async () => {
    return storeController.getStoreRegistries();
  });

  // ── store:add-registry ─────────────────────────────────────────────────
  wrapIpcHandle('store:add-registry', async (_event, input: { name: string; url: string }) => {
    return storeController.addStoreRegistry(input);
  });

  // ── store:remove-registry ──────────────────────────────────────────────
  wrapIpcHandle('store:remove-registry', async (_event, registryId: string) => {
    return storeController.removeStoreRegistry(registryId);
  });

  // ── store:toggle-registry ──────────────────────────────────────────────
  wrapIpcHandle(
    'store:toggle-registry',
    async (_event, input: { registryId: string; enabled: boolean }) => {
      return storeController.toggleStoreRegistry(input.registryId, input.enabled);
    },
  );

  console.log('[StoreIPC] Store handlers registered (9 channels)');
}
