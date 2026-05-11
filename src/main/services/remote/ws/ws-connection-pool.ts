/**
 * Remote WebSocket - Connection Pool
 *
 * Manages pooled WebSocket connections per server for reuse.
 */

import { createLogger } from '../../log';
import { RemoteWsClient } from './remote-ws-client';
import type { RemoteWsClientConfig } from './ws-types';
import sshTunnelService from '../../remote/ssh/ssh-tunnel.service';

const log = createLogger('remote-ws-pool');

interface PooledConnection {
  client: RemoteWsClient;
  refs: Set<string>;
  createdAt: number;
  config: RemoteWsClientConfig;
}

const connectionPool = new Map<string, PooledConnection>();
const POOL_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Acquire a pooled WebSocket connection for a server.
 */
export async function acquireConnection(
  serverId: string,
  config: RemoteWsClientConfig,
  callerId: string,
): Promise<RemoteWsClient> {
  const existing = connectionPool.get(serverId);

  if (existing) {
    if (existing.client.isConnected()) {
      if (Date.now() - existing.createdAt > POOL_MAX_AGE_MS) {
        log.info(
          `[${serverId}] Pooled connection is stale (${POOL_MAX_AGE_MS / 60000}min), recycling`,
        );
        existing.client.destroy();
        connectionPool.delete(serverId);
      } else {
        existing.refs.add(callerId);
        log.debug(
          `[${serverId}] Reusing pooled connection (refs: ${existing.refs.size}, callerId: ${callerId})`,
        );
        return existing.client;
      }
    } else if (existing.client.isReconnecting()) {
      // Defensive check: if SSH tunnel is down, the reconnecting client's
      // connection target is unreachable — skip waiting and create a fresh connection.
      // (Fix #1 already removes pool entry on tunnel death; this handles race conditions.)
      if (config.useSshTunnel && !sshTunnelService.isServerTunnelAlive(serverId)) {
        log.info(
          `[${serverId}] SSH tunnel is down, skipping reconnect wait — destroying stale connection`,
        );
        existing.client.destroy();
        connectionPool.delete(serverId);
      } else {
        log.info(
          `[${serverId}] Pooled connection is reconnecting, waiting up to 15s...`,
        );
        const reconnected = await existing.client.waitForReconnect(15000);
        if (reconnected && existing.client.isConnected()) {
          existing.createdAt = Date.now();
          existing.refs.add(callerId);
          log.info(`[${serverId}] Reconnected successfully, reusing connection`);
          return existing.client;
        }
        log.info(
          `[${serverId}] Reconnect did not succeed, creating new connection`,
        );
        existing.client.destroy();
        connectionPool.delete(serverId);
      }
    } else {
      log.info(`[${serverId}] Pooled connection is dead, removing`);
      existing.client.destroy();
      connectionPool.delete(serverId);
    }
  }

  const client = new RemoteWsClient(config);
  connectionPool.set(serverId, {
    client,
    refs: new Set([callerId]),
    createdAt: Date.now(),
    config,
  });

  log.info(`[${serverId}] Created new pooled connection for callerId: ${callerId}`);

  client.once('close', () => {
    const entry = connectionPool.get(serverId);
    if (entry && entry.client === client) {
      connectionPool.delete(serverId);
      // Also destroy the client to cancel any pending reconnect timer.
      // Prevents stale reconnect attempts from competing with future acquireConnection calls.
      client.destroy();
      log.info(`[${serverId}] Pooled connection closed, removed and destroyed`);
    }
  });

  client.once('reconnectFailed', () => {
    const entry = connectionPool.get(serverId);
    if (entry && entry.client === client) {
      connectionPool.delete(serverId);
      log.info(
        `[${serverId}] Pooled connection reconnect failed, removed from pool`,
      );
    }
  });

  await client.connect();
  return client;
}

/**
 * Release a pooled connection reference.
 */
export function releaseConnection(serverId: string, callerId: string): void {
  const entry = connectionPool.get(serverId);
  if (!entry) {
    return;
  }

  entry.refs.delete(callerId);
  log.debug(
    `[${serverId}] Released connection ref (remaining refs: ${entry.refs.size}, callerId: ${callerId})`,
  );
}

/**
 * Force-disconnect a pooled connection.
 */
export function removePooledConnection(serverId: string): void {
  const entry = connectionPool.get(serverId);
  if (entry) {
    entry.client.destroy();
    connectionPool.delete(serverId);
    log.info(`[${serverId}] Force-removed pooled connection`);
  }
}

/**
 * Get pool statistics for diagnostics.
 */
export function getPoolStats(): Array<{
  serverId: string;
  refs: number;
  age: number;
  isConnected: boolean;
}> {
  const stats: Array<{ serverId: string; refs: number; age: number; isConnected: boolean }> = [];
  for (const [serverId, entry] of Array.from(connectionPool)) {
    stats.push({
      serverId,
      refs: entry.refs.size,
      age: Date.now() - entry.createdAt,
      isConnected: entry.client.isConnected(),
    });
  }
  return stats;
}

/**
 * Disconnect all pooled connections (used by disconnectAllClients).
 */
export function disconnectAllPooledConnections(): void {
  for (const [serverId, entry] of Array.from(connectionPool)) {
    entry.client.destroy();
    connectionPool.delete(serverId);
  }
  log.info('All pooled connections disconnected');
}
