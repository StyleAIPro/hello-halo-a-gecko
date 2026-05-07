/**
 * Browser Module - BrowserView management, overlay, context menus
 */

export { browserViewManager, type BrowserViewState } from './browser-view.service';

export {
  buildBrowserContextMenu,
  buildCanvasTabContextMenu,
  type BrowserMenuOptions,
  type CanvasTabMenuOptions,
} from './browser-menu.service';

export { overlayManager, type OverlayState } from './overlay.service';

export { forceDwmCleanup, dwmFlush } from './win32-hwnd-cleanup';
