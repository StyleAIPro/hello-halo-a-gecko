/**
 * Cluster Manager Types
 *
 * Types for managing NPU server clusters in Hyper Space.
 */

/** Server online status */
export type ServerStatus = 'online' | 'offline' | 'busy' | 'error';

/** NPU server capabilities */
export interface ServerCapabilities {
  /** NPU model, e.g. "A100", "H100", "910B" */
  npuType: string;
  /** GPU memory in GB */
  memory: number;
  /** Supported compute types */
  computeType: string[];
}

/** Server connection info */
export interface ServerConnection {
  type: 'websocket' | 'ssh';
  host: string;
  port: number;
  sshTunnel?: {
    host: string;
    port: number;
    user: string;
  };
  lastHeartbeat: number;
  authToken?: string;
}

/** Server current load */
export interface ServerLoad {
  runningTasks: number;
  gpuUtilization?: number;
  memoryUsed?: number;
}

/** A registered NPU server */
export interface NpuServer {
  id: string;
  name: string;
  status: ServerStatus;
  capabilities: ServerCapabilities;
  connection: ServerConnection;
  load: ServerLoad;
  registeredAt: number;
}

/** Request to acquire workers from cluster */
export interface AcquireWorkersRequest {
  /** Selector expression, e.g. "capabilities.npuType=A100 & capabilities.computeType~training" */
  selector: string;
  /** Number of workers needed (0 = all matching) */
  count: number;
  /** Routing strategy */
  strategy: 'least-loaded' | 'round-robin' | 'capability';
}

/** Cluster event types */
export type ClusterEvent =
  | { type: 'server:registered'; serverId: string }
  | { type: 'server:online'; serverId: string }
  | { type: 'server:offline'; serverId: string }
  | { type: 'server:busy'; serverId: string }
  | { type: 'server:error'; serverId: string; error: string }
  | { type: 'server:heartbeat'; serverId: string; load: ServerLoad };