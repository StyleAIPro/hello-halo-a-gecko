import { readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import log from 'electron-log/main.js';

const LOG_RETENTION_DAYS = 30;

export async function cleanupOldLogs(logDir: string): Promise<void> {
  try {
    const files = await readdir(logDir);
    const now = Date.now();
    const retentionMs = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let deleted = 0;

    for (const file of files) {
      if (!file.startsWith('aico-bot-') || !file.endsWith('.log')) continue;
      const filePath = join(logDir, file);
      try {
        const fileStat = await stat(filePath);
        if (now - fileStat.mtimeMs > retentionMs) {
          await unlink(filePath);
          deleted++;
        }
      } catch {
        // skip files that can't be stat'd
      }
    }

    if (deleted > 0) {
      log.info(`[LogCleanup] Removed ${deleted} log files older than ${LOG_RETENTION_DAYS} days`);
    }
  } catch {
    // log directory may not exist yet on first run
  }
}
