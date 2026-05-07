/**
 * Browser Menu Service - Context menu construction for browser views and canvas tabs
 *
 * Extracted from ipc/browser.ts to keep IPC handlers thin.
 * All menu-building logic lives here; handlers just call and popup.
 */

import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { browserViewManager } from './browser-view.service';

// ──────────────────────────────────────────────
// Browser context menu
// ──────────────────────────────────────────────

export interface BrowserMenuOptions {
  viewId: string;
  url?: string;
  zoomLevel: number;
}

/**
 * Build the browser context menu (zoom submenu + dev tools)
 */
export function buildBrowserContextMenu(
  options: BrowserMenuOptions,
  mainWindow: BrowserWindow | null,
): Menu {
  const { viewId, zoomLevel } = options;

  const zoomSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Zoom In',
      accelerator: 'CmdOrCtrl+Plus',
      enabled: zoomLevel < 200,
      click: () => {
        const newZoom = Math.min(200, zoomLevel + 10);
        browserViewManager.setZoom(viewId, newZoom / 100);
        mainWindow?.webContents.send('browser:zoom-changed', { viewId, zoomLevel: newZoom });
      },
    },
    {
      label: 'Zoom Out',
      accelerator: 'CmdOrCtrl+-',
      enabled: zoomLevel > 50,
      click: () => {
        const newZoom = Math.max(50, zoomLevel - 10);
        browserViewManager.setZoom(viewId, newZoom / 100);
        mainWindow?.webContents.send('browser:zoom-changed', { viewId, zoomLevel: newZoom });
      },
    },
    {
      label: `Reset (${zoomLevel}%)`,
      accelerator: 'CmdOrCtrl+0',
      enabled: zoomLevel !== 100,
      click: () => {
        browserViewManager.setZoom(viewId, 1);
        mainWindow?.webContents.send('browser:zoom-changed', { viewId, zoomLevel: 100 });
      },
    },
  ];

  const template: MenuItemConstructorOptions[] = [
    { label: 'Zoom', submenu: zoomSubmenu },
    { type: 'separator' },
    {
      label: 'Developer Tools',
      accelerator: 'F12',
      click: () => browserViewManager.toggleDevTools(viewId),
    },
  ];

  return Menu.buildFromTemplate(template);
}

// ──────────────────────────────────────────────
// Canvas tab context menu
// ──────────────────────────────────────────────

export interface CanvasTabMenuOptions {
  tabId: string;
  tabIndex: number;
  tabTitle: string;
  tabPath?: string;
  tabCount: number;
  hasTabsToRight: boolean;
}

/**
 * Build the canvas tab context menu (close / copy path / refresh)
 */
export function buildCanvasTabContextMenu(
  options: CanvasTabMenuOptions,
  mainWindow: BrowserWindow | null,
): Menu {
  const { tabId, tabIndex, tabPath, tabCount, hasTabsToRight } = options;
  const hasOtherTabs = tabCount > 1;

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Close',
      accelerator: 'CmdOrCtrl+W',
      click: () => {
        mainWindow?.webContents.send('canvas:tab-action', { action: 'close', tabId });
      },
    },
  ];

  if (hasOtherTabs) {
    template.push({
      label: 'Close Others',
      click: () => {
        mainWindow?.webContents.send('canvas:tab-action', { action: 'closeOthers', tabId });
      },
    });
  }

  if (hasTabsToRight) {
    template.push({
      label: 'Close to the Right',
      click: () => {
        mainWindow?.webContents.send('canvas:tab-action', {
          action: 'closeToRight',
          tabId,
          tabIndex,
        });
      },
    });
  }

  if (tabPath) {
    template.push(
      { type: 'separator' },
      {
        label: 'Copy Path',
        click: () => {
          mainWindow?.webContents.send('canvas:tab-action', { action: 'copyPath', tabPath });
        },
      },
    );
  }

  if (tabPath) {
    template.push({
      label: 'Refresh',
      click: () => {
        mainWindow?.webContents.send('canvas:tab-action', { action: 'refresh', tabId });
      },
    });
  }

  return Menu.buildFromTemplate(template);
}
