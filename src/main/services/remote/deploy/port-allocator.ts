/**
 * Port Allocator Module
 * Provides deterministic port allocation for per-PC remote proxy isolation.
 */

import * as crypto from 'crypto';
import type { SSHManager } from '../ssh/ssh-manager';

const PORT_RANGE_START = 30000;
const PORT_RANGE_END = 40000;
const PORT_RANGE_SIZE = PORT_RANGE_END - PORT_RANGE_START + 1; // 10001

/**
 * Calculate the preferred port for a given clientId.
 * Deterministic: same clientId always returns the same port.
 */
export function calculatePreferredPort(clientId: string): number {
  const hash = crypto.createHash('sha256').update(clientId).digest();
  const hashInt = hash.readUInt32BE(0);
  return PORT_RANGE_START + (hashInt % PORT_RANGE_SIZE);
}

/**
 * Check if a port is free on the remote server.
 */
async function isPortFree(sshManager: SSHManager, port: number): Promise<boolean> {
  const result = await sshManager.executeCommandFull(`ss -tln | grep ':${port} ' || echo "FREE"`);
  return result.stdout.includes('FREE');
}

/**
 * Check if a port is owned by a specific clientId's proxy process.
 */
async function isPortOwnedByClient(
  sshManager: SSHManager,
  port: number,
  clientId: string,
): Promise<boolean> {
  const deployPath = `/opt/claude-deployment-${clientId}`;
  const result = await sshManager.executeCommandFull(
    `pgrep -f "node.*${deployPath}" >/dev/null 2>&1 && echo "OURS" || echo "NOT_OURS"`,
  );
  if (result.stdout.includes('OURS')) {
    const portCheck = await sshManager.executeCommandFull(
      `ss -tln | grep ':${port} ' || echo "NOT_LISTENING"`,
    );
    return !portCheck.stdout.includes('NOT_LISTENING');
  }
  return false;
}

/**
 * Resolve the actual port to use, with collision detection.
 * Checks if the preferred port is available on the remote server.
 * If occupied by a different clientId's proxy, increment and retry.
 *
 * @param sshManager - Connected SSH manager for the remote server
 * @param clientId - This PC's client identifier
 * @returns The allocated port number
 */
export async function resolvePort(sshManager: SSHManager, clientId: string): Promise<number> {
  let port = calculatePreferredPort(clientId);
  const maxAttempts = 20;
  const totalTimeoutMs = 120_000; // 2 minutes total for port resolution
  const startTime = Date.now();

  for (let i = 0; i < maxAttempts; i++) {
    // Guard against accumulated timeout across all attempts
    const elapsed = Date.now() - startTime;
    if (elapsed >= totalTimeoutMs) {
      throw new Error(
        `Port allocation timed out after ${Math.round(elapsed / 1000)}s (${i}/${maxAttempts} attempts)`,
      );
    }

    // Check if this port is already owned by our clientId
    const ownedByUs = await isPortOwnedByClient(sshManager, port, clientId);
    if (ownedByUs) {
      return port;
    }

    // Check if port is free
    const isFree = await isPortFree(sshManager, port);
    if (isFree) {
      return port;
    }

    // Port is occupied by something else, try next
    console.warn(`[PortAllocator] Port ${port} is occupied, trying ${port + 1}`);
    port = PORT_RANGE_START + ((port - PORT_RANGE_START + 1) % PORT_RANGE_SIZE);
  }

  throw new Error(`Failed to find available port in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}
