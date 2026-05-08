/**
 * Cluster Manager
 *
 * Manages NPU server lifecycle: registration, heartbeat, load tracking, persistence.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getSpacesDir } from '../../config.service';
import { createLogger } from '../../log';
import { eventBus } from '../event-bus';
import { serverRouter } from './server-router';
import type {
  NpuServer,
  ServerStatus,
  ServerLoad,
  ServerCapabilities,
  AcquireWorkersRequest,
  ClusterEvent,
} from '../../../../shared/types/cluster';

const log = createLogger('cluster-manager');

const HEARTBEAT_INTERVAL = 30_000;
const OFFLINE_THRESHOLD = 3;
const CLEANUP_INTERVAL = 5 * 60_000;

class ClusterManager {
  private static instance: ClusterManager | null = null;

  private servers: Map<string, NpuServer> = new Map();
  private missedHeartbeats: Map<string, number> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  private constructor() {
    this.startHeartbeatCheck();
    this.startCleanup();
    log.info('Cluster Manager initialized');
  }

  static getInstance(): ClusterManager {
    if (!ClusterManager.instance) {
      ClusterManager.instance = new ClusterManager();
    }
    return ClusterManager.instance;
  }

  registerServer(params: {
    name: string;
    host: string;
    port: number;
    capabilities: ServerCapabilities;
    authToken?: string;
    sshTunnel?: { host: string; port: number; user: string };
  }): NpuServer {
    const server: NpuServer = {
      id: uuidv4(),
      name: params.name,
      status: 'online',
      capabilities: params.capabilities,
      connection: {
        type: params.sshTunnel ? 'ssh' : 'websocket',
        host: params.host,
        port: params.port,
        sshTunnel: params.sshTunnel,
        lastHeartbeat: Date.now(),
        authToken: params.authToken,
      },
      load: { runningTasks: 0 },
      registeredAt: Date.now(),
    };

    this.servers.set(server.id, server);
    this.missedHeartbeats.set(server.id, 0);
    this.emitEvent({ type: 'server:registered', serverId: server.id });
    log.info(`Registered server: ${server.name} (${server.id})`);

    return server;
  }

  unregisterServer(serverId: string): boolean {
    const removed = this.servers.delete(serverId);
    this.missedHeartbeats.delete(serverId);
    if (removed) {
      this.emitEvent({ type: 'server:offline', serverId });
      log.info(`Unregistered server: ${serverId}`);
    }
    return removed;
  }

  processHeartbeat(serverId: string, load?: Partial<ServerLoad>): void {
    const server = this.servers.get(serverId);
    if (!server) {
      log.warn(`Heartbeat from unknown server: ${serverId}`);
      return;
    }

    server.connection.lastHeartbeat = Date.now();
    this.missedHeartbeats.set(serverId, 0);

    if (load) {
      server.load = { ...server.load, ...load };
    }

    if (server.status === 'offline' || server.status === 'error') {
      server.status = server.load.runningTasks > 0 ? 'busy' : 'online';
      this.emitEvent({ type: 'server:online', serverId });
    }

    this.emitEvent({ type: 'server:heartbeat', serverId, load: server.load });
  }

  getServer(serverId: string): NpuServer | undefined {
    return this.servers.get(serverId);
  }

  getAllServers(): NpuServer[] {
    return Array.from(this.servers.values());
  }

  getServersByStatus(status: ServerStatus): NpuServer[] {
    return this.getAllServers().filter((s) => s.status === status);
  }

  acquireWorkers(request: AcquireWorkersRequest): NpuServer[] {
    return serverRouter.selectWorkers(this.getAllServers(), request);
  }

  updateTaskCount(serverId: string, delta: number): void {
    const server = this.servers.get(serverId);
    if (!server) return;
    server.load.runningTasks = Math.max(0, server.load.runningTasks + delta);
    server.status = server.load.runningTasks > 0 ? 'busy' : 'online';
  }

  save(spaceId: string): void {
    const dir = join(getSpacesDir(), spaceId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const filePath = join(dir, 'cluster.json');
    const data = Array.from(this.servers.values());
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    log.debug(`Saved cluster state: ${data.length} servers`);
  }

  load(spaceId: string): void {
    const filePath = join(getSpacesDir(), spaceId, 'cluster.json');
    if (!existsSync(filePath)) return;

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const data: NpuServer[] = JSON.parse(raw);
      for (const server of data) {
        server.status = 'offline';
        this.servers.set(server.id, server);
        this.missedHeartbeats.set(server.id, 0);
      }
      log.info(`Loaded ${data.length} servers from disk`);
    } catch (err) {
      log.error('Failed to load cluster state:', err);
    }
  }

  private startHeartbeatCheck(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [serverId, server] of Array.from(this.servers)) {
        const missed = this.missedHeartbeats.get(serverId) || 0;
        const elapsed = now - server.connection.lastHeartbeat;

        if (elapsed > HEARTBEAT_INTERVAL * (missed + 1)) {
          const newMissed = missed + 1;
          this.missedHeartbeats.set(serverId, newMissed);

          if (newMissed >= OFFLINE_THRESHOLD) {
            server.status = 'offline';
            this.emitEvent({ type: 'server:offline', serverId });
            log.warn(`Server offline (3 missed heartbeats): ${server.name}`);
          }
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [serverId, server] of Array.from(this.servers)) {
        if (server.status === 'error' && now - server.connection.lastHeartbeat > CLEANUP_INTERVAL) {
          server.status = 'offline';
          this.emitEvent({ type: 'server:offline', serverId });
        }
      }
    }, CLEANUP_INTERVAL);
  }

  private emitEvent(event: ClusterEvent): void {
    eventBus.emitClusterEvent(event);
  }

  destroy(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    ClusterManager.instance = null;
  }
}

export const clusterManager = ClusterManager.getInstance();