/**
 * Remote WebSocket - Connection Pool
 *
 * Manages pooled WebSocket connections per server for reuse.
 */

import { createLogger } from '../../utils/logger';
import { RemoteWsClient } from './remote-ws-client';
import type { RemoteWsClientConfig } from './ws-types';

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
      log.info(`[${serverId}] Pooled connection closed, removed from pool`);
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
