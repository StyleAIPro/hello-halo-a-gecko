/**
 * Store Module
 *
 * Registry service for discovering, browsing, and installing apps
 * from remote registries (GitHub-based or custom).
 *
 * Initialization: Called from bootstrap/extended.ts after platform+apps init.
 * Shutdown: Called during app cleanup.
 */

export {
  initRegistryService,
  shutdownRegistryService,
  // Re-export key functions for controller use
  refreshIndex,
  listApps,
  getAppDetail,
  installFromStore,
  checkUpdates,
  getRegistries,
  addRegistry,
  removeRegistry,
  toggleRegistry,
} from './registry.service'
