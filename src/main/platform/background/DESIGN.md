# platform/background -- Design Document

> Author: AI Engineer (background module)
> Date: 2026-02-21
> Status: Implemented

## 1. Module Scope

`platform/background` is the process-survival and browser-resource layer for Halo.
It provides three capabilities:

1. **Keep-Alive** -- Prevent the Electron process from exiting when the main window
   is closed, as long as at least one reason is registered.
2. **System Tray** -- Show a tray icon with a context menu (online/offline toggle,
   show window, quit).
3. **Daemon BrowserWindow** -- Provide a shared hidden BrowserWindow with stealth
   injection and domain-level session isolation for automation Apps.

The module has **zero business knowledge**. It does not know what an App is, what a
scheduler does, or anything about AI. It only manages process lifetime and browser
resources.

## 2. Key Design Decisions

### 2.1 Keep-Alive with Disposer Pattern + Safety Net

Each call to `registerKeepAliveReason(reason)` returns an unregister function.
Internally, reasons are tracked in a `Map<string, { registeredAt: number }>`.

**Crash safety**: If a caller crashes without calling the disposer, the reason
stays forever, keeping the process alive. To mitigate this:
- Each reason records its `registeredAt` timestamp.
- A configurable `MAX_KEEP_ALIVE_TTL` (default 24 hours) acts as an upper bound.
  Reasons older than this are automatically pruned.
- The pruning check runs lazily inside `shouldKeepAlive()`, not on a timer,
  to avoid unnecessary overhead.

This is strictly better than a simple `Set<string>` and protects against orphaned
reasons without requiring heartbeat pings from callers.

### 2.2 window-all-closed Integration

The existing `index.ts` has:
```typescript
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    shutdownServicesWithTimeout(...).finally(() => app.quit())
  }
})
```

On macOS, `window-all-closed` does nothing (standard macOS behavior).
On Windows/Linux, it quits immediately.

**Change**: After background is initialized, `window-all-closed` must check
`backgroundService.shouldKeepAlive()`. If true, do NOT quit. The process stays
alive via the tray icon. If false on non-macOS, quit as before.

On macOS, the `app.on('activate')` handler already recreates the window,
which is the correct behavior when the tray is active.

### 2.3 V1 Single Shared BrowserWindow + Task Queue

Architecture docs specify a single shared hidden BrowserWindow for V1 to save
memory (~50-100MB per window). Multiple callers queue for access.

Implementation:
- `getDaemonBrowserWindow(url)` is async. The URL is used to derive the partition.
- A promise-based queue ensures only one caller uses the window at a time.
- Callers MUST call `releaseDaemonBrowserWindow()` when done.
- A safety timeout (default 5 minutes) auto-releases if the caller hangs.
- The window is lazily created on first request and destroyed during shutdown.

### 2.4 Domain-Level Partition Extraction

Format: `persist:automation-{mainDomain}`

Extraction rules:
- `https://item.jd.com/xxx` -> `persist:automation-jd.com`
- `https://www.taobao.com/...` -> `persist:automation-taobao.com`
- `http://192.168.1.1:8080/...` -> `persist:automation-192.168.1.1`
- `https://co.uk` (two-part TLD) -> handled via a suffix list approach

For V1, we use a pragmatic approach: strip `www.` prefix, extract the hostname.
For multi-part TLDs (co.uk, com.cn, etc.), we maintain a small built-in list
of known two-part suffixes to extract the correct main domain. This covers
99%+ of real-world automation targets without pulling in a large dependency.

IP addresses (v4 and v6) are used as-is for the partition name.

### 2.5 Tray Icon

Existing assets found in `resources/tray/`:
- `trayTemplate.png` / `trayTemplate@2x.png` (macOS template images)
- `tray-16.png` / `tray-16@2x.png` / `tray-24.png` / `tray-24@2x.png`

macOS: Use `trayTemplate.png` (Electron auto-selects @2x). Template images
automatically adapt to light/dark menu bar.

Windows: Use `tray-16.png` as the base icon. Windows tray icons should be 16x16.

### 2.6 Online/Offline Status

A simple state machine:
- `online` (default): Automation Apps can run.
- `offline`: Automation Apps should pause.

The background service emits status change events via a callback pattern
(consistent with the project's `onXxxChange` convention). The `apps/runtime`
layer subscribes to this and pauses/resumes accordingly.

### 2.7 Stealth Injection

Reuse `injectStealthScripts` from `src/main/services/stealth/index.ts`.
The function takes a `WebContents` and:
1. Attaches CDP debugger 1.3
2. Calls `Page.addScriptToEvaluateOnNewDocument` with the pre-built stealth script
3. Falls back to event-based injection if CDP fails

This is called once when the daemon BrowserWindow is created. Because we use
`addScriptToEvaluateOnNewDocument`, it persists across navigations within the
same webContents -- no need to re-inject per navigation.

### 2.8 Shutdown Cleanup

During `app.on('before-quit')`:
1. Clear all keep-alive reasons (so shouldKeepAlive returns false).
2. If a daemon BrowserWindow exists, destroy it.
3. The tray is automatically cleaned up by Electron when the process exits.

The `shutdownBackground()` function is called from `cleanupExtendedServices()`.

## 3. Public API

```typescript
// platform/background/types.ts

type BackgroundStatus = 'online' | 'offline'
type StatusChangeHandler = (status: BackgroundStatus) => void
type Unsubscribe = () => void

interface BackgroundService {
  // Tray
  initTray(): void

  // Keep-alive
  shouldKeepAlive(): boolean
  registerKeepAliveReason(reason: string): Unsubscribe

  // Daemon browser
  getDaemonBrowserWindow(url: string): Promise<BrowserWindow>
  releaseDaemonBrowserWindow(): void

  // Online/offline
  getStatus(): BackgroundStatus
  goOnline(): void
  goOffline(): void
  onStatusChange(handler: StatusChangeHandler): Unsubscribe
}

// platform/background/index.ts
export function initBackground(): BackgroundService
export function shutdownBackground(): void
```

## 4. File Structure

```
src/main/platform/background/
  index.ts              -- initBackground(), shutdownBackground(), re-exports
  types.ts              -- BackgroundService interface and related types
  keep-alive.ts         -- KeepAliveManager (reason registration/pruning)
  tray.ts               -- TrayManager (icon, context menu, status display)
  daemon-browser.ts     -- DaemonBrowserManager (shared window, queue, partition)
  partition.ts          -- extractPartition(url) utility

tests/unit/platform/background/
  keep-alive.test.ts    -- KeepAliveManager tests
  partition.test.ts     -- extractPartition tests
  daemon-browser.test.ts -- DaemonBrowserManager queue logic tests
```

## 5. Integration Points

- `src/main/index.ts` -- Modify `window-all-closed` handler to check shouldKeepAlive()
- `src/main/bootstrap/extended.ts` -- Call `initBackground()` during extended init
- `src/main/services/stealth/index.ts` -- Consumed (not modified)
- `apps/runtime` (future) -- Will call registerKeepAliveReason, getDaemonBrowserWindow
