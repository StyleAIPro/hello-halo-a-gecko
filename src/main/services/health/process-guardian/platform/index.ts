/**
 * Platform Process Operations - Factory
 *
 * Provides platform-specific process operations based on the current OS.
 */

import type { PlatformProcessOps } from '../../types';
import { DarwinProcessOps } from './darwin';
import { Win32ProcessOps } from './win32';
import { LinuxProcessOps } from './linux';

// Cached instance
let platformOps: PlatformProcessOps | null = null;

/**
 * Get platform-specific process operations
 *
 * Returns a cached singleton instance for the current platform.
 */
export function getPlatformOps(): PlatformProcessOps {
  if (platformOps) {
    return platformOps;
  }

  switch (process.platform) {
    case 'darwin':
      platformOps = new DarwinProcessOps();
      break;
    case 'win32':
      platformOps = new Win32ProcessOps();
      break;
    case 'linux':
    default:
      // Default to Linux/POSIX for other platforms
      platformOps = new LinuxProcessOps();
      break;
  }

  console.log(`[Health] Using ${process.platform} platform operations`);
  return platformOps;
}

// Export platform classes for direct use if needed
export { DarwinProcessOps } from './darwin';
export { Win32ProcessOps } from './win32';
export { LinuxProcessOps } from './linux';
