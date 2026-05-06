/**
 * File Watcher Module - Artifact scanning, caching, and file system monitoring
 */

export {
  getArtifact,
  watchArtifacts,
  initArtifactWatcher,
  subscribeToArtifactChanges,
  readArtifactContent,
  getArtifactDownloadInfo,
  detectFileType,
  saveArtifactContent,
  type Artifact,
  type ArtifactChangeEvent,
  type ArtifactContent,
  type CanvasContentType,
  type FileTypeInfo,
} from './artifact.service';

export {
  initSpaceCache,
  ensureSpaceCache,
  destroySpaceCache,
  listArtifacts,
  listArtifactsTree,
  loadDirectoryChildren,
  onArtifactChange,
  getCacheStats,
  refreshCache,
  cleanupAllCaches,
  type CachedTreeNode,
} from './artifact-cache.service';

export {
  initSpaceWatcher,
  destroySpaceWatcher,
  scanTreeViaWorker,
  scanFlatViaWorker,
  refreshIgnoreRules,
  addFsEventsHandler,
  setFsEventsHandler,
  setSpaceReadyHandler,
  setSpaceErrorHandler,
  shutdown,
} from './watcher-host.service';
