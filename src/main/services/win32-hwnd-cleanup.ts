/**
 * Win32 HWND Cleanup Utility
 *
 * Provides native Windows API calls to reliably clean up stale BrowserView HWNDs.
 *
 * Problem:
 *   Electron's BrowserView on Windows creates a native child HWND for each view.
 *   removeBrowserView() can silently fail due to DWM compositor timing, leaving
 *   a transparent HWND that intercepts all pointer events (WM_NCHITTEST).
 *
 *   The existing workarounds (invalidate(), blur/focus, size ±1px) only operate
 *   at the Chromium compositor level and cannot force the Windows DWM to rebuild
 *   its composition tree.
 *
 * Solution:
 *   Directly call Win32 APIs via koffi (pure-JS FFI, no native compilation needed):
 *   - DwmFlush(): Forces DWM to finish pending composition work (synchronous)
 *   - SetWindowPos(SWP_FRAMECHANGED): Forces DWM to rebuild the frame/composition
 *   - EnumChildWindows(): Enumerate child HWNDs to detect stale BrowserView windows
 *
 *   These are the same mechanisms that trigger when opening/closing a native
 *   dialog, which is why that action "accidentally" fixes the bug.
 */

import type { BrowserWindow } from 'electron';

let koffi: typeof import('koffi') | null = null;
let initialized = false;
let user32: any = null;
let dwmapi: any = null;
let SetWindowPos_: any = null;
let DwmFlush_: any = null;
let EnumChildWindows_: any = null;
let GetClassNameW_: any = null;
let DestroyWindow_: any = null;

// Win32 constants
const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_FRAMECHANGED = 0x0020;
const SWP_NOACTIVATE = 0x0010;
const GW_HWNDFIRST = 0;
const GW_HWNDLAST = 1;
const GW_STYLE = -16;
const WS_VISIBLE = 0x10000000;

/**
 * Lazy-initialize koffi and load Win32 libraries.
 * Returns false if not on Windows or initialization fails.
 */
function ensureInitialized(): boolean {
  if (initialized) return koffi !== null;
  initialized = true;

  if (process.platform !== 'win32') return false;

  try {
    // Dynamic import to avoid bundling issues
    koffi = require('koffi');
    if (!koffi) {
      console.warn('[Win32Cleanup] koffi not available');
      return false;
    }

    // Load Win32 libraries
    user32 = koffi.load('user32.dll');
    dwmapi = koffi.load('dwmapi.dll');

    // Declare function signatures
    SetWindowPos_ = user32.func(
      'bool __stdcall SetWindowPos(void* hWnd, void* hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)',
    );
    DwmFlush_ = dwmapi.func('int __stdcall DwmFlush(void)');
    EnumChildWindows_ = user32.func(
      'bool __stdcall EnumChildWindows(void* hWndParent, void* lpEnumFunc, uintptr_t lParam)',
    );
    GetClassNameW_ = user32.func(
      'int __stdcall GetClassNameW(void* hWnd, uint16* lpClassName, int nMaxCount)',
    );
    DestroyWindow_ = user32.func('bool __stdcall DestroyWindow(void* hWnd)');

    console.log('[Win32Cleanup] Initialized successfully');
    return true;
  } catch (error) {
    console.warn('[Win32Cleanup] Failed to initialize:', (error as Error).message);
    koffi = null;
    return false;
  }
}

/**
 * Get the native HWND handle from an Electron BrowserWindow.
 *
 * Electron stores the native HWND in the internal _hWnd or getNativeWindowHandle().
 * We need the raw pointer value to pass to Win32 APIs.
 */
function getHwnd(window: BrowserWindow): Buffer | null {
  try {
    return window.getNativeWindowHandle();
  } catch {
    return null;
  }
}

/**
 * Force DWM to flush pending composition work.
 *
 * This is the key operation: DwmFlush() blocks until the DWM has finished
 * all pending composition. After removeBrowserView + DwmFlush, the DWM
 * will have processed the HWND removal and rebuilt its hit-test tree.
 *
 * This is what happens internally when a native dialog opens/closes.
 */
export function dwmFlush(): boolean {
  if (!ensureInitialized() || !DwmFlush_) return false;

  try {
    const result = DwmFlush_();
    if (result !== 0) {
      // S_OK = 0, DWM_E_COMPOSITIONNOTRUNNING is acceptable
      console.log(`[Win32Cleanup] DwmFlush returned: ${result}`);
    }
    return true;
  } catch (error) {
    console.warn('[Win32Cleanup] DwmFlush failed:', (error as Error).message);
    return false;
  }
}

/**
 * Force a window frame recalculation via SetWindowPos with SWP_FRAMECHANGED.
 *
 * This forces the DWM to rebuild the entire composition tree for the window,
 * which clears any cached hit-test surfaces from removed child HWNDs.
 *
 * Unlike the ±1px size hack, this directly triggers the DWM rebuild path.
 */
export function forceFrameRecalc(window: BrowserWindow): boolean {
  if (!ensureInitialized() || !SetWindowPos_) return false;

  const hwnd = getHwnd(window);
  if (!hwnd) return false;

  try {
    // SetWindowPos with SWP_FRAMECHANGED forces WM_NCCALCSIZE processing
    // SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED
    const flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED;
    const hwndPtr = koffi!.address(hwnd);
    const result = SetWindowPos_(hwndPtr, null, 0, 0, 0, 0, flags);
    console.log(`[Win32Cleanup] SetWindowPos(SWP_FRAMECHANGED) result: ${result}`);
    return !!result;
  } catch (error) {
    console.warn('[Win32Cleanup] forceFrameRecalc failed:', (error as Error).message);
    return false;
  }
}

/**
 * Combined DWM flush + frame recalculation.
 *
 * This is the full sequence that replicates what happens when a native dialog
 * closes — DWM processes all pending changes and rebuilds the composition.
 */
export function forceDwmCleanup(window: BrowserWindow): boolean {
  const flushOk = dwmFlush();
  const frameOk = forceFrameRecalc(window);

  if (flushOk) {
    // After frame recalc, do a second DwmFlush to ensure the rebuild completed
    setTimeout(() => {
      dwmFlush();
    }, 50);
  }

  return flushOk || frameOk;
}

/**
 * Enumerate and log child HWNDs of a window (diagnostic).
 */
export function enumChildWindows(window: BrowserWindow): void {
  if (!ensureInitialized() || !EnumChildWindows_) return;

  const hwnd = getHwnd(window);
  if (!hwnd) return;

  const children: string[] = [];

  // We need a callback - use koffi's callback support
  try {
    const enumProc = koffi!.register((childHwnd: any, _lParam: any) => {
      try {
        const className = getClassName(childHwnd);
        children.push(`HWND:0x${childHwnd.toString(16)} class:"${className}"`);
      } catch {
        children.push(`HWND:0x${childHwnd.toString(16)}`);
      }
      return true; // continue enumeration
    }, koffi!.proto('bool __stdcall EnumChildProc(void* hWnd, uintptr_t lParam)'));

    const hwndPtr = koffi!.address(hwnd);
    EnumChildWindows_(hwndPtr, enumProc, 0);

    koffi!.unregister(enumProc);

    console.log(`[Win32Cleanup] Child windows (${children.length}):`, children);
  } catch (error) {
    console.warn('[Win32Cleanup] enumChildWindows failed:', (error as Error).message);
  }
}

/**
 * Get the window class name for a HWND.
 */
function getClassName(hwnd: any): string {
  if (!GetClassNameW_) return 'unknown';

  try {
    const buf = Buffer.alloc(512);
    const hwndPtr = koffi!.address(hwnd);
    GetClassNameW_(hwndPtr, buf, 256);
    // Convert from UTF-16LE
    return buf.toString('utf16le').replace(/\0/g, '');
  } catch {
    return 'unknown';
  }
}
