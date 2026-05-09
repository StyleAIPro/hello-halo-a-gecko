import { ipcMain } from 'electron';

/**
 * Wrap ipcMain.handle to auto-log every IPC call with channel name, duration, and success/failure.
 */
export function wrapIpcHandle(
  channel: string,
  handler: (...args: unknown[]) => Promise<unknown>,
): void {
  ipcMain.handle(channel, async (...args: unknown[]) => {
    const t0 = Date.now();
    try {
      const result = await handler(...args);
      const ms = Date.now() - t0;
      const ok = result != null && typeof result === 'object' && (result as Record<string, unknown>).success !== false;
      console.info(`[event] ${channel} -> ${ok ? 'ok' : 'fail'} ${ms}ms`);
      return result;
    } catch (err) {
      const ms = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      console.info(`[event] ${channel} -> error ${ms}ms: ${msg}`);
      return { success: false, error: msg };
    }
  });
}
