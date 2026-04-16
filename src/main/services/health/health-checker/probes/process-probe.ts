/**
 * Process Probe - Process health check
 *
 * Checks:
 * - Orphan processes from previous instances
 * - Current process registry state
 */

import type { ProcessProbeResult } from '../../types';
import { getOrphanProcesses, getCurrentProcesses, cleanupOrphans } from '../../process-guardian';

/**
 * Check process health and cleanup orphans
 */
export async function runProcessProbe(): Promise<ProcessProbeResult> {
  try {
    // Get orphan processes before cleanup
    const orphansBefore = getOrphanProcesses();
    const currentProcesses = getCurrentProcesses();

    // Perform cleanup
    const cleanupResult = await cleanupOrphans();

    // Determine health status
    const healthy = cleanupResult.failed === 0;
    const severity = orphansBefore.length > 0 ? 'warning' : 'info';

    let message = 'No orphan processes found';
    if (orphansBefore.length > 0) {
      message = `Cleaned up ${cleanupResult.cleaned} orphan processes`;
      if (cleanupResult.failed > 0) {
        message += `, ${cleanupResult.failed} failed to clean`;
      }
    }

    return {
      name: 'process',
      healthy,
      severity,
      message,
      timestamp: Date.now(),
      data: {
        orphansFound: orphansBefore.map((p) => ({
          pid: p.pid ?? 0,
          type: p.type,
          instanceId: p.instanceId,
        })),
        currentProcesses,
        zombiesKilled: cleanupResult.cleaned,
      },
    };
  } catch (error) {
    return {
      name: 'process',
      healthy: true, // Assume healthy on error
      severity: 'warning',
      message: `Process check failed: ${(error as Error).message}`,
      timestamp: Date.now(),
      data: {
        orphansFound: [],
        currentProcesses: [],
        zombiesKilled: 0,
      },
    };
  }
}
