import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Clean up log files older than maxAgeDays.
 * Called after extended services init — does not block startup.
 */
export async function cleanupOldLogs(logDir: string, maxAgeDays = 30): Promise<void> {
  let files: string[];
  try {
    files = await readdir(logDir);
  } catch {
    return;
  }

  const now = Date.now();
  const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;

  for (const file of files) {
    if (!file.startsWith('main-') || !file.endsWith('.log')) continue;
    try {
      const filePath = join(logDir, file);
      const fileStat = await stat(filePath);
      if (now - fileStat.mtimeMs > maxAge) {
        await unlink(filePath);
      }
    } catch {
      // Skip files that can't be stat'd or deleted
    }
  }
}
