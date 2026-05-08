# Hyper Space Pipeline Engine 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Hyper Space 构建 Pipeline Engine 驱动的多 Agent 协同系统，支持 20+ NPU 服务器集群的 DAG 编排、高效通信、自动化管理和实时可视化。

**架构：** 四层架构——Interaction Layer 对话/模板入口生成 PipelineSpec，Pipeline Engine 解析 DAG 调度阶段执行，Cluster Manager 管理服务器注册/健康/路由，Agent Layer 通过 Event Bus 通信。在现有 Leader-Worker 模式上增量升级。

**技术栈：** TypeScript、Electron IPC、WebSocket、EventEmitter、Zustand、React

**设计规格：** `docs/superpowers/specs/2026-05-07-hyper-space-pipeline-engine-design.md`

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/shared/types/pipeline.ts` | PipelineSpec / PipelineStage / StageEdge 等类型定义 |
| `src/shared/types/cluster.ts` | NpuServer / ServerCapabilities / ServerStatus 等类型定义 |
| `src/main/services/agent/event-bus.ts` | 内存事件总线，替代文件 Mailbox |
| `src/main/services/agent/cluster/cluster-manager.ts` | 服务器注册、心跳、负载管理、拓扑持久化 |
| `src/main/services/agent/cluster/server-router.ts` | 基于 selector + strategy 的任务路由 |
| `src/main/services/agent/pipeline/pipeline-engine.ts` | DAG 解析、阶段调度、依赖管理、迭代循环 |
| `src/main/services/agent/pipeline/pipeline-execution.ts` | 单次 Pipeline 执行的状态机 |
| `src/renderer/stores/hyper-space.store.ts` | Pipeline + 集群 Zustand 状态管理 |
| `src/renderer/pages/hyper-space/pipeline-dashboard.tsx` | Pipeline 进度 + 阶段状态组件 |
| `src/renderer/pages/hyper-space/cluster-grid.tsx` | 服务器状态网格组件 |
| `src/renderer/pages/hyper-space/agent-log-panel.tsx` | 实时日志面板组件 |

### 修改文件

| 文件 | 改动内容 |
|------|---------|
| `src/main/services/agent/hyper-space-mcp.ts` | 新增 `report_result` / `report_status` / `broadcast` 工具 |
| `src/main/services/agent/orchestrator.ts` | 任务分发改为可选调用 Pipeline Engine；Event Bus 集成 |
| `src/main/services/agent/mailbox.ts` | 添加 `@deprecated` 标注，内部转发到 Event Bus |
| `src/preload/index.ts` | 新增 Hyper Space IPC 通道 |
| `src/renderer/api/transport.ts` | 新增 methodMap 条目 |
| `src/renderer/api/index.ts` | 新增 `api.hyperSpace.*` |

---

## Phase 1: Event Bus + Cluster Manager

### 任务 1：定义共享类型

**文件：**
- 创建：`src/shared/types/pipeline.ts`
- 创建：`src/shared/types/cluster.ts`

- [ ] **步骤 1：创建 pipeline.ts 类型定义**

在 `src/shared/types/pipeline.ts` 中定义所有 Pipeline 相关类型：

```typescript
/**
 * Pipeline Engine Types
 *
 * Types for DAG-based task orchestration across NPU server clusters.
 */

/** Stage execution mode */
export type StageMode = 'parallel' | 'sequential' | 'fan-out' | 'reduce';

/** Edge condition for stage transitions */
export type EdgeCondition =
  | 'on-success'
  | 'on-failure'
  | 'on-all-complete'
  | 'on-any-complete';

/** Pipeline-level status */
export type PipelineStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Stage-level status */
export type StageStatus = 'pending' | 'scheduling' | 'running' | 'completed' | 'failed' | 'skipped';

/** Task-level status (single agent task) */
export type PipelineTaskStatus = 'pending' | 'dispatched' | 'running' | 'completed' | 'failed' | 'retrying';

/** A single stage in the pipeline DAG */
export interface PipelineStage {
  id: string;
  name: string;
  mode: StageMode;
  /** Server selector expression, e.g. "npu-type:A100" or "all" */
  targetSelector?: string;
  /** Max parallel tasks (0 = unlimited) */
  maxConcurrency?: number;
  /** Task prompt template sent to each agent */
  taskPrompt: string;
  retryPolicy?: {
    maxRetries: number;
    retryOn: 'failure' | 'timeout' | 'any';
  };
  /** Per-task timeout in seconds */
  timeout?: number;
}

/** Directed edge between stages */
export interface StageEdge {
  from: string;
  to: string;
  condition?: EdgeCondition;
}

/** Communication policy for worker-to-worker messaging */
export interface CommunicationPolicy {
  workerToWorker: boolean;
  /** If set, only allow messaging to listed agent IDs */
  allowedTargets?: string[];
}

/** A complete pipeline specification */
export interface PipelineSpec {
  id: string;
  name: string;
  /** Template variables filled at runtime */
  variables: Record<string, unknown>;
  stages: PipelineStage[];
  edges: StageEdge[];
  communicationPolicy?: CommunicationPolicy;
}

/** A single task dispatched to one agent */
export interface PipelineTask {
  id: string;
  pipelineId: string;
  stageId: string;
  agentId: string;
  prompt: string;
  status: PipelineTaskStatus;
  result?: string;
  error?: string;
  retryCount: number;
  startedAt?: number;
  completedAt?: number;
}

/** Runtime state of a pipeline execution */
export interface PipelineState {
  spec: PipelineSpec;
  status: PipelineStatus;
  stages: Map<string, StageStatus>;
  tasks: Map<string, PipelineTask>;
  /** For iterative loops: which iteration round we're on */
  iterationCount: number;
  /** Track which edges have been traversed (to detect loops) */
  traversedEdges: Set<string>;
  startedAt?: number;
  completedAt?: number;
}

/** Event emitted by Pipeline Engine */
export type PipelineEvent =
  | { type: 'pipeline:started'; pipelineId: string }
  | { type: 'pipeline:completed'; pipelineId: string }
  | { type: 'pipeline:failed'; pipelineId: string; error: string }
  | { type: 'stage:started'; pipelineId: string; stageId: string }
  | { type: 'stage:completed'; pipelineId: string; stageId: string }
  | { type: 'stage:failed'; pipelineId: string; stageId: string; error: string }
  | { type: 'task:dispatched'; pipelineId: string; stageId: string; taskId: string; agentId: string }
  | { type: 'task:completed'; pipelineId: string; stageId: string; taskId: string; result?: string }
  | { type: 'task:failed'; pipelineId: string; stageId: string; taskId: string; error: string }
  | { type: 'task:retrying'; pipelineId: string; stageId: string; taskId: string; retryCount: number };
```

- [ ] **步骤 2：创建 cluster.ts 类型定义**

在 `src/shared/types/cluster.ts` 中定义：

```typescript
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
```

- [ ] **步骤 3：验证类型检查通过**

运行：`npm run typecheck`
预期：PASS（新文件无导入依赖）

- [ ] **步骤 4：Commit**

```bash
git add src/shared/types/pipeline.ts src/shared/types/cluster.ts
git commit -m "feat(hyper-space): add pipeline and cluster shared types"
```

---

### 任务 2：实现 Event Bus

**文件：**
- 创建：`src/main/services/agent/event-bus.ts`

Event Bus 替代文件 Mailbox，提供内存中低延迟的 Agent 间通信。所有消息经过主进程中继。

- [ ] **步骤 1：实现 EventBus 类**

在 `src/main/services/agent/event-bus.ts` 中：

```typescript
/**
 * Hyper Space Event Bus
 *
 * In-memory event bus for inter-agent communication.
 * Replaces the file-based Mailbox system with low-latency EventEmitter.
 *
 * Three communication modes:
 * 1. Agent → Leader: report_result, report_status
 * 2. Agent → Agent: send_message (relayed through main process)
 * 3. Leader → Agents: broadcast
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger';
import type { PipelineEvent } from '../../../shared/types/pipeline';
import type { ClusterEvent } from '../../../shared/types/cluster';

const log = createLogger('event-bus');

// ============================================
// Event Bus Message Types
// ============================================

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  timestamp: number;
  inReplyTo?: string;
}

export interface TaskResultReport {
  stageId: string;
  taskId: string;
  agentId: string;
  status: 'completed' | 'failed';
  result?: string;
  error?: string;
  artifacts?: string[];
}

export interface AgentStatusReport {
  agentId: string;
  progress: number;
  gpuUtilization?: number;
  metrics?: Record<string, unknown>;
  logTail?: string;
}

export interface BroadcastPayload {
  from: string;
  targetSelector: string;
  message: string;
  excludeSender?: boolean;
}

// ============================================
// Event Bus Service
// ============================================

type BusEvent =
  | { kind: 'message'; data: AgentMessage }
  | { kind: 'task-result'; data: TaskResultReport }
  | { kind: 'agent-status'; data: AgentStatusReport }
  | { kind: 'broadcast'; data: BroadcastPayload }
  | { kind: 'pipeline'; data: PipelineEvent }
  | { kind: 'cluster'; data: ClusterEvent };

class HyperSpaceEventBus extends EventEmitter {
  private static instance: HyperSpaceEventBus | null = null;

  /** Pending messages per agent (for agents that are temporarily offline) */
  private pendingMessages: Map<string, AgentMessage[]> = new Map();

  private constructor() {
    super();
    this.setMaxListeners(100); // Support many concurrent agents
    log.info('Event Bus initialized');
  }

  static getInstance(): HyperSpaceEventBus {
    if (!HyperSpaceEventBus.instance) {
      HyperSpaceEventBus.instance = new HyperSpaceEventBus();
    }
    return HyperSpaceEventBus.instance;
  }

  // ---- Message methods ----

  /** Send a direct message from one agent to another */
  sendMessage(from: string, to: string, subject: string, body: string, inReplyTo?: string): AgentMessage {
    const message: AgentMessage = {
      id: uuidv4(),
      from,
      to,
      subject,
      body,
      timestamp: Date.now(),
      inReplyTo,
    };

    this.emit('message', message);
    log.debug(`Message: ${from} → ${to} [${subject}]`);
    return message;
  }

  /** Broadcast a message to multiple agents */
  broadcast(payload: BroadcastPayload): void {
    this.emit('broadcast', payload);
    log.debug(`Broadcast from ${payload.from}: ${payload.message.substring(0, 80)}`);
  }

  /** Report task completion (Agent → Leader / Pipeline Engine) */
  reportTaskResult(report: TaskResultReport): void {
    this.emit('task-result', report);
    log.debug(`Task result: ${report.agentId} task=${report.taskId} status=${report.status}`);
  }

  /** Report agent status (periodic heartbeat) */
  reportAgentStatus(report: AgentStatusReport): void {
    this.emit('agent-status', report);
  }

  /** Emit pipeline engine events */
  emitPipelineEvent(event: PipelineEvent): void {
    this.emit('pipeline', event);
  }

  /** Emit cluster manager events */
  emitClusterEvent(event: ClusterEvent): void {
    this.emit('cluster', event);
  }

  // ---- Pending messages ----

  /** Store messages for offline agents */
  storePending(agentId: string, message: AgentMessage): void {
    const queue = this.pendingMessages.get(agentId) || [];
    queue.push(message);
    this.pendingMessages.set(agentId, queue);
  }

  /** Drain pending messages for an agent that came back online */
  drainPending(agentId: string): AgentMessage[] {
    const messages = this.pendingMessages.get(agentId) || [];
    this.pendingMessages.delete(agentId);
    return messages;
  }
}

export const eventBus = HyperSpaceEventBus.getInstance();
```

- [ ] **步骤 2：验证类型检查通过**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/main/services/agent/event-bus.ts
git commit -m "feat(hyper-space): add in-memory event bus for agent communication"
```

---

### 任务 3：实现 Cluster Manager

**文件：**
- 创建：`src/main/services/agent/cluster/cluster-manager.ts`
- 创建：`src/main/services/agent/cluster/server-router.ts`

- [ ] **步骤 1：实现 ServerRouter**

在 `src/main/services/agent/cluster/server-router.ts` 中：

```typescript
/**
 * Server Router
 *
 * Routes tasks to NPU servers based on selector expressions and load.
 */

import { createLogger } from '../../../utils/logger';
import type { NpuServer, AcquireWorkersRequest } from '../../../../shared/types/cluster';

const log = createLogger('server-router');

/**
 * Parse a selector expression like "capabilities.npuType=A100 & capabilities.computeType~training"
 * Returns a filter function that matches against NpuServer.
 */
function parseSelector(selector: string): (server: NpuServer) => boolean {
  if (selector === 'all' || !selector) {
    return () => true;
  }

  const clauses = selector.split('&').map((c) => c.trim());
  return (server: NpuServer) => {
    return clauses.every((clause) => {
      const eqIdx = clause.indexOf('=');
      const tildeIdx = clause.indexOf('~');
      if (eqIdx === -1 && tildeIdx === -1) return true;

      const sepIdx = tildeIdx !== -1 ? tildeIdx : eqIdx;
      const isContains = tildeIdx !== -1;
      const fieldPath = clause.substring(0, sepIdx).trim();
      const value = clause.substring(sepIdx + 1).trim();

      const fieldValue = getNestedValue(server, fieldPath);
      if (fieldValue === undefined) return false;

      if (isContains) {
        return Array.isArray(fieldValue)
          ? fieldValue.some((v) => String(v).toLowerCase() === value.toLowerCase())
          : String(fieldValue).toLowerCase().includes(value.toLowerCase());
      }
      return String(fieldValue) === value;
    });
  };
}

function getNestedValue(obj: unknown, path: string): unknown {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export class ServerRouter {
  /**
   * Select workers from available servers based on request criteria.
   */
  selectWorkers(
    servers: NpuServer[],
    request: AcquireWorkersRequest,
  ): NpuServer[] {
    // Step 1: Filter by selector
    const filter = parseSelector(request.selector);
    let candidates = servers
      .filter((s) => s.status === 'online' || s.status === 'busy')
      .filter(filter);

    // Step 2: Sort by strategy
    switch (request.strategy) {
      case 'least-loaded':
        candidates.sort((a, b) => a.load.runningTasks - b.load.runningTasks);
        break;
      case 'capability':
        // Prefer servers with more compute types
        candidates.sort(
          (a, b) => b.capabilities.computeType.length - a.capabilities.computeType.length,
        );
        break;
      case 'round-robin':
        // No specific sort — randomize for variety
        candidates.sort(() => Math.random() - 0.5);
        break;
    }

    // Step 3: Limit count
    const count = request.count > 0 ? request.count : candidates.length;
    return candidates.slice(0, count);
  }
}

export const serverRouter = new ServerRouter();
```

- [ ] **步骤 2：实现 ClusterManager**

在 `src/main/services/agent/cluster/cluster-manager.ts` 中：

```typescript
/**
 * Cluster Manager
 *
 * Manages NPU server lifecycle: registration, heartbeat, load tracking, persistence.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getSpacesDir } from '../../config.service';
import { createLogger } from '../../../utils/logger';
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

const HEARTBEAT_INTERVAL = 30_000;     // 30 seconds
const OFFLINE_THRESHOLD = 3;           // 3 missed heartbeats
const CLEANUP_INTERVAL = 5 * 60_000;   // 5 minutes

class ClusterManager {
  private static instance: ClusterManager | null = null;

  /** Registered servers indexed by ID */
  private servers: Map<string, NpuServer> = new Map();

  /** Missed heartbeat counters */
  private missedHeartbeats: Map<string, number> = new Map();

  /** Heartbeat check timer */
  private heartbeatTimer: NodeJS.Timeout | null = null;

  /** Cleanup timer */
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

  // ---- Registration ----

  /** Register a new NPU server */
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

  /** Remove a server */
  unregisterServer(serverId: string): boolean {
    const removed = this.servers.delete(serverId);
    this.missedHeartbeats.delete(serverId);
    if (removed) {
      this.emitEvent({ type: 'server:offline', serverId });
      log.info(`Unregistered server: ${serverId}`);
    }
    return removed;
  }

  // ---- Heartbeat ----

  /** Process a heartbeat from an agent */
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

    // Update status
    const prevStatus = server.status;
    if (server.status === 'offline' || server.status === 'error') {
      server.status = server.load.runningTasks > 0 ? 'busy' : 'online';
      this.emitEvent({ type: 'server:online', serverId });
    }

    this.emitEvent({ type: 'server:heartbeat', serverId, load: server.load });
  }

  // ---- Query ----

  /** Get a server by ID */
  getServer(serverId: string): NpuServer | undefined {
    return this.servers.get(serverId);
  }

  /** Get all servers */
  getAllServers(): NpuServer[] {
    return Array.from(this.servers.values());
  }

  /** Get servers by status */
  getServersByStatus(status: ServerStatus): NpuServer[] {
    return this.getAllServers().filter((s) => s.status === status);
  }

  /** Acquire workers for a pipeline stage */
  acquireWorkers(request: AcquireWorkersRequest): NpuServer[] {
    return serverRouter.selectWorkers(this.getAllServers(), request);
  }

  /** Update server task count (when task is dispatched/completed) */
  updateTaskCount(serverId: string, delta: number): void {
    const server = this.servers.get(serverId);
    if (!server) return;
    server.load.runningTasks = Math.max(0, server.load.runningTasks + delta);
    server.status = server.load.runningTasks > 0 ? 'busy' : 'online';
  }

  // ---- Persistence ----

  /** Save cluster state to disk */
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

  /** Load cluster state from disk */
  load(spaceId: string): void {
    const filePath = join(getSpacesDir(), spaceId, 'cluster.json');
    if (!existsSync(filePath)) return;

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const data: NpuServer[] = JSON.parse(raw);
      for (const server of data) {
        server.status = 'offline'; // Reset to offline until heartbeat confirms
        this.servers.set(server.id, server);
        this.missedHeartbeats.set(server.id, 0);
      }
      log.info(`Loaded ${data.length} servers from disk`);
    } catch (err) {
      log.error('Failed to load cluster state:', err);
    }
  }

  // ---- Background tasks ----

  private startHeartbeatCheck(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [serverId, server] of this.servers) {
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
      // Reset error servers after 5 minutes if no active heartbeat
      const now = Date.now();
      for (const [serverId, server] of this.servers) {
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

  /** Clean up timers (for testing / shutdown) */
  destroy(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    ClusterManager.instance = null;
  }
}

export const clusterManager = ClusterManager.getInstance();
```

- [ ] **步骤 3：验证类型检查通过**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/main/services/agent/cluster/cluster-manager.ts src/main/services/agent/cluster/server-router.ts
git commit -m "feat(hyper-space): add cluster manager with registration, heartbeat, and routing"
```

---

### 任务 4：改造 hyper-space-mcp.ts — 新增 Pipeline 工具

**文件：**
- 修改：`src/main/services/agent/hyper-space-mcp.ts`（在现有文件末尾、`createHyperSpaceMcpServer` 之前新增工具工厂函数，并注册到 buildLeaderTools / buildWorkerTools）

- [ ] **步骤 1：新增 report_result 工具**

在 `hyper-space-mcp.ts` 的 Worker Tool Factories 区域（约 line 290 后）添加：

```typescript
/**
 * Create report_result tool
 * Enhanced version of announce_completion for Pipeline Engine integration.
 * Reports structured task results including artifacts and metrics.
 */
function createReportResultTool(spaceId: string, conversationId: string) {
  return tool(
    'report_result',
    'Report the result of your assigned pipeline task. ' +
      'Use this when you have completed (or failed) your task to submit results, metrics, and artifact paths. ' +
      'This replaces announce_completion for pipeline-based workflows.',
    {
      stageId: z.string().describe('The pipeline stage ID this task belongs to'),
      taskId: z.string().describe('Your assigned task ID'),
      status: z.enum(['completed', 'failed']).describe('Task completion status'),
      result: z.string().optional().describe('Result summary or output data'),
      error: z.string().optional().describe('Error message if failed'),
      artifacts: z
        .array(z.string())
        .optional()
        .describe('Paths to output artifacts (model files, logs, etc.)'),
    },
    async (params: {
      stageId: string;
      taskId: string;
      status: 'completed' | 'failed';
      result?: string;
      error?: string;
      artifacts?: string[];
    }) => {
      try {
        const { eventBus } = await import('./event-bus');
        eventBus.reportTaskResult({
          stageId: params.stageId,
          taskId: params.taskId,
          agentId: conversationId, // Will be resolved by orchestrator
          status: params.status,
          result: params.result,
          error: params.error,
          artifacts: params.artifacts,
        });

        // Also update legacy orchestrator announcement for backward compat
        const task = agentOrchestrator.getTask(params.taskId);
        if (task) {
          const announcement: SubagentAnnouncement = {
            type: 'agent:announce',
            taskId: params.taskId,
            agentId: task.agentId,
            status: params.status,
            result: params.result,
            summary: params.result ? params.result.substring(0, 200) : undefined,
            timestamp: Date.now(),
          };
          await agentOrchestrator.sendAnnouncement(announcement);
        }

        return textResult(
          `Result reported successfully.\nStage: ${params.stageId}\nTask: ${params.taskId}\nStatus: ${params.status}`,
        );
      } catch (e) {
        return textResult(`Error reporting result: ${(e as Error).message}`, true);
      }
    },
  );
}
```

- [ ] **步骤 2：新增 report_status 工具**

紧跟 report_result 之后添加：

```typescript
/**
 * Create report_status tool
 * Periodic status reporting from agents (progress, GPU utilization, metrics).
 */
function createReportStatusTool(spaceId: string, conversationId: string) {
  return tool(
    'report_status',
    'Report your current execution status including progress, resource utilization, and metrics. ' +
      'Call this periodically during long-running tasks (e.g., model training) to provide real-time updates.',
    {
      progress: z.number().min(0).max(1).describe('Task progress from 0 to 1'),
      gpuUtilization: z.number().optional().describe('GPU utilization percentage (0-100)'),
      metrics: z.record(z.unknown()).optional().describe('Custom metrics (e.g., { loss: 0.05, epoch: 3 })'),
      logTail: z.string().optional().describe('Last few lines of log output'),
    },
    async (params: {
      progress: number;
      gpuUtilization?: number;
      metrics?: Record<string, unknown>;
      logTail?: string;
    }) => {
      try {
        const { eventBus } = await import('./event-bus');
        eventBus.reportAgentStatus({
          agentId: conversationId,
          progress: params.progress,
          gpuUtilization: params.gpuUtilization,
          metrics: params.metrics,
          logTail: params.logTail,
        });
        return textResult('Status reported.');
      } catch (e) {
        return textResult(`Error reporting status: ${(e as Error).message}`, true);
      }
    },
  );
}
```

- [ ] **步骤 3：注册新工具到 buildWorkerTools 和 buildLeaderTools**

在 `buildWorkerTools` 函数（约 line 898）的返回数组中，在 `createAnnounceCompletionTool` 之后添加：

```typescript
// Pipeline tools (enhanced reporting)
createReportResultTool(spaceId, conversationId),
createReportStatusTool(spaceId, conversationId),
```

在 `buildLeaderTools` 函数（约 line 874）的返回数组中也添加：

```typescript
// Pipeline monitoring tools
createReportStatusTool(spaceId, conversationId),
```

- [ ] **步骤 4：验证构建通过**

运行：`npm run typecheck && npm run build`
预期：PASS

- [ ] **步骤 5：Re-read 确认改动未被覆盖**

读取 `hyper-space-mcp.ts` 确认新增工具函数和注册代码存在。

- [ ] **步骤 6：Commit**

```bash
git add src/main/services/agent/hyper-space-mcp.ts
git commit -m "feat(hyper-space): add report_result and report_status MCP tools for pipeline integration"
```

---

## Phase 2: Pipeline Engine

### 任务 5：实现 Pipeline Execution（单次执行状态机）

**文件：**
- 创建：`src/main/services/agent/pipeline/pipeline-execution.ts`

- [ ] **步骤 1：实现 PipelineExecution 类**

```typescript
/**
 * Pipeline Execution
 *
 * Manages the state machine of a single pipeline run.
 * Tracks stages, tasks, and handles retry/iteration logic.
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../../utils/logger';
import { eventBus } from '../event-bus';
import type {
  PipelineSpec,
  PipelineState,
  PipelineStatus,
  PipelineTask,
  PipelineTaskStatus,
  PipelineEvent,
  StageStatus,
  StageEdge,
} from '../../../../shared/types/pipeline';

const log = createLogger('pipeline-execution');

export class PipelineExecution {
  readonly id: string;
  readonly spec: PipelineSpec;
  private state: PipelineState;

  constructor(spec: PipelineSpec) {
    this.id = spec.id;
    this.spec = spec;

    // Initialize stage statuses
    const stages = new Map<string, StageStatus>();
    for (const stage of spec.stages) {
      stages.set(stage.id, 'pending');
    }

    this.state = {
      spec,
      status: 'pending',
      stages,
      tasks: new Map(),
      iterationCount: 0,
      traversedEdges: new Set(),
    };
  }

  // ---- State queries ----

  getStatus(): PipelineStatus {
    return this.state.status;
  }

  getStageStatus(stageId: string): StageStatus | undefined {
    return this.state.stages.get(stageId);
  }

  getTask(taskId: string): PipelineTask | undefined {
    return this.state.tasks.get(taskId);
  }

  getAllTasks(stageId?: string): PipelineTask[] {
    const tasks = Array.from(this.state.tasks.values());
    return stageId ? tasks.filter((t) => t.stageId === stageId) : tasks;
  }

  /** Get the stage IDs that are ready to run (all incoming edges satisfied) */
  getReadyStages(): string[] {
    const ready: string[] = [];

    for (const stage of this.spec.stages) {
      const status = this.state.stages.get(stage.id);
      if (status !== 'pending') continue;

      // Check all incoming edges
      const incomingEdges = this.spec.edges.filter((e) => e.to === stage.id);
      if (incomingEdges.length === 0) {
        // No dependencies — it's a root stage
        ready.push(stage.id);
        continue;
      }

      const allSatisfied = incomingEdges.every((edge) => this.isEdgeSatisfied(edge));
      if (allSatisfied) {
        ready.push(stage.id);
      }
    }

    return ready;
  }

  // ---- State transitions ----

  /** Start the pipeline */
  start(): void {
    this.state.status = 'running';
    this.state.startedAt = Date.now();
    this.emit({ type: 'pipeline:started', pipelineId: this.id });
    log.info(`Pipeline started: ${this.spec.name} (${this.id})`);
  }

  /** Mark a stage as running */
  startStage(stageId: string): void {
    this.state.stages.set(stageId, 'running');
    this.emit({ type: 'stage:started', pipelineId: this.id, stageId });
    log.info(`Stage started: ${stageId}`);
  }

  /** Create a task for dispatching to an agent */
  createTask(stageId: string, agentId: string, prompt: string): PipelineTask {
    const task: PipelineTask = {
      id: uuidv4(),
      pipelineId: this.id,
      stageId,
      agentId,
      prompt,
      status: 'dispatched',
      retryCount: 0,
    };
    this.state.tasks.set(task.id, task);
    this.emit({
      type: 'task:dispatched',
      pipelineId: this.id,
      stageId,
      taskId: task.id,
      agentId,
    });
    return task;
  }

  /** Mark a task as running */
  startTask(taskId: string): void {
    const task = this.state.tasks.get(taskId);
    if (!task) return;
    task.status = 'running';
    task.startedAt = Date.now();
  }

  /** Mark a task as completed */
  completeTask(taskId: string, result?: string): void {
    const task = this.state.tasks.get(taskId);
    if (!task) return;
    task.status = 'completed';
    task.result = result;
    task.completedAt = Date.now();
    this.emit({
      type: 'task:completed',
      pipelineId: this.id,
      stageId: task.stageId,
      taskId,
      result,
    });

    this.checkStageCompletion(task.stageId);
  }

  /** Mark a task as failed */
  failTask(taskId: string, error: string): void {
    const task = this.state.tasks.get(taskId);
    if (!task) return;

    // Check retry policy
    const stage = this.spec.stages.find((s) => s.id === task.stageId);
    const maxRetries = stage?.retryPolicy?.maxRetries ?? 0;

    if (task.retryCount < maxRetries) {
      task.retryCount++;
      task.status = 'retrying';
      this.emit({
        type: 'task:retrying',
        pipelineId: this.id,
        stageId: task.stageId,
        taskId,
        retryCount: task.retryCount,
      });
      log.info(`Task retrying (${task.retryCount}/${maxRetries}): ${taskId}`);
      return;
    }

    task.status = 'failed';
    task.error = error;
    task.completedAt = Date.now();
    this.emit({
      type: 'task:failed',
      pipelineId: this.id,
      stageId: task.stageId,
      taskId,
      error,
    });

    this.checkStageCompletion(task.stageId);
  }

  /** Cancel the entire pipeline */
  cancel(): void {
    this.state.status = 'cancelled';
    this.state.completedAt = Date.now();
    this.emit({ type: 'pipeline:failed', pipelineId: this.id, error: 'Cancelled' });
  }

  // ---- Internal ----

  private checkStageCompletion(stageId: string): void {
    const stageTasks = this.getAllTasks(stageId);
    const stage = this.spec.stages.find((s) => s.id === stageId);
    if (!stage) return;

    const allDone = stageTasks.every(
      (t) => t.status === 'completed' || t.status === 'failed',
    );
    if (!allDone) return;

    const anyFailed = stageTasks.some((t) => t.status === 'failed');
    const stageStatus: StageStatus = anyFailed ? 'failed' : 'completed';
    this.state.stages.set(stageId, stageStatus);
    this.emit({
      type: stageStatus === 'completed' ? 'stage:completed' : 'stage:failed',
      pipelineId: this.id,
      stageId,
      ...(stageStatus === 'failed' ? { error: 'One or more tasks failed' } : {}),
    });

    // Mark outgoing edges as traversed
    const outgoingEdges = this.spec.edges.filter((e) => e.from === stageId);
    for (const edge of outgoingEdges) {
      const condition = edge.condition ?? 'on-all-complete';
      let shouldTraverse = false;

      switch (condition) {
        case 'on-all-complete':
          shouldTraverse = stageStatus === 'completed';
          break;
        case 'on-success':
          shouldTraverse = stageStatus === 'completed';
          break;
        case 'on-failure':
          shouldTraverse = stageStatus === 'failed';
          break;
        case 'on-any-complete':
          shouldTraverse = true;
          break;
      }

      if (shouldTraverse) {
        this.state.traversedEdges.add(`${edge.from}->${edge.to}`);

        // Check for loop-back edges (iteration)
        if (this.spec.stages.findIndex((s) => s.id === edge.to) <=
            this.spec.stages.findIndex((s) => s.id === edge.from)) {
          this.state.iterationCount++;
          log.info(`Iteration ${this.state.iterationCount}: ${edge.from} → ${edge.to}`);
          // Reset downstream stages for re-execution
          this.resetStagesFrom(edge.to);
        }
      }
    }

    // Check if pipeline is complete
    this.checkPipelineCompletion();
  }

  private resetStagesFrom(stageId: string): void {
    const stageIdx = this.spec.stages.findIndex((s) => s.id === stageId);
    for (let i = stageIdx; i < this.spec.stages.length; i++) {
      const id = this.spec.stages[i].id;
      this.state.stages.set(id, 'pending');
      // Remove tasks for this stage
      for (const [taskId, task] of this.state.tasks) {
        if (task.stageId === id) {
          this.state.tasks.delete(taskId);
        }
      }
    }
  }

  private checkPipelineCompletion(): void {
    const allStagesDone = Array.from(this.state.stages.values()).every(
      (s) => s === 'completed' || s === 'failed' || s === 'skipped',
    );

    if (!allStagesDone) return;

    const anyFailed = Array.from(this.state.stages.values()).some((s) => s === 'failed');
    this.state.status = anyFailed ? 'failed' : 'completed';
    this.state.completedAt = Date.now();
    this.emit({
      type: anyFailed ? 'pipeline:failed' : 'pipeline:completed',
      pipelineId: this.id,
      ...(anyFailed ? { error: 'One or more stages failed' } : {}),
    });
    log.info(`Pipeline ${this.state.status}: ${this.spec.name}`);
  }

  private isEdgeSatisfied(edge: StageEdge): boolean {
    const fromStatus = this.state.stages.get(edge.from);
    if (!fromStatus) return false;

    const traversed = this.state.traversedEdges.has(`${edge.from}->${edge.to}`);

    switch (edge.condition ?? 'on-all-complete') {
      case 'on-all-complete':
        return fromStatus === 'completed' || fromStatus === 'failed';
      case 'on-success':
        return fromStatus === 'completed';
      case 'on-failure':
        return fromStatus === 'failed';
      case 'on-any-complete':
        return traversed || fromStatus === 'completed' || fromStatus === 'failed';
      default:
        return false;
    }
  }

  private emit(event: PipelineEvent): void {
    eventBus.emitPipelineEvent(event);
  }
}
```

- [ ] **步骤 2：验证类型检查通过**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/main/services/agent/pipeline/pipeline-execution.ts
git commit -m "feat(hyper-space): add pipeline execution state machine"
```

---

### 任务 6：实现 Pipeline Engine（核心调度器）

**文件：**
- 创建：`src/main/services/agent/pipeline/pipeline-engine.ts`

- [ ] **步骤 1：实现 PipelineEngine 类**

```typescript
/**
 * Pipeline Engine
 *
 * Core DAG orchestrator. Accepts PipelineSpec, creates PipelineExecution,
 * schedules stages, dispatches tasks via Cluster Manager, and processes results.
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../../utils/logger';
import { eventBus } from '../event-bus';
import { clusterManager } from '../cluster/cluster-manager';
import { PipelineExecution } from './pipeline-execution';
import type {
  PipelineSpec,
  PipelineStage,
  PipelineTask,
  TaskResultReport,
  PipelineEvent,
} from '../../../../shared/types/pipeline';
import type { AcquireWorkersRequest } from '../../../../shared/types/cluster';

const log = createLogger('pipeline-engine');

class PipelineEngine {
  private static instance: PipelineEngine | null = null;

  /** Active executions indexed by pipeline ID */
  private executions: Map<string, PipelineExecution> = new Map();

  /** Reverse map: taskId → pipelineId, for routing task results */
  private taskPipelineMap: Map<string, string> = new Map();

  private constructor() {
    this.setupListeners();
    log.info('Pipeline Engine initialized');
  }

  static getInstance(): PipelineEngine {
    if (!PipelineEngine.instance) {
      PipelineEngine.instance = new PipelineEngine();
    }
    return PipelineEngine.instance;
  }

  // ---- Public API ----

  /** Start a new pipeline execution */
  async startPipeline(spec: PipelineSpec): Promise<string> {
    const pipelineId = spec.id || uuidv4();
    spec.id = pipelineId;

    const execution = new PipelineExecution(spec);
    this.executions.set(pipelineId, execution);

    execution.start();
    await this.scheduleReadyStages(execution);

    return pipelineId;
  }

  /** Get execution by pipeline ID */
  getExecution(pipelineId: string): PipelineExecution | undefined {
    return this.executions.get(pipelineId);
  }

  /** Cancel a running pipeline */
  cancelPipeline(pipelineId: string): void {
    const execution = this.executions.get(pipelineId);
    if (execution) {
      execution.cancel();
      this.executions.delete(pipelineId);
    }
  }

  // ---- Scheduling ----

  /** Schedule all stages that are ready to run */
  private async scheduleReadyStages(execution: PipelineExecution): Promise<void> {
    const readyStageIds = execution.getReadyStages();

    for (const stageId of readyStageIds) {
      await this.scheduleStage(execution, stageId);
    }
  }

  /** Schedule a single stage */
  private async scheduleStage(execution: PipelineExecution, stageId: string): Promise<void> {
    const spec = execution.spec;
    const stage = spec.stages.find((s) => s.id === stageId);
    if (!stage) return;

    execution.startStage(stageId);

    // Resolve the task prompt (fill template variables)
    const prompt = this.resolvePrompt(stage.taskPrompt, spec.variables);

    // Acquire workers from cluster
    const request: AcquireWorkersRequest = {
      selector: stage.targetSelector || 'all',
      count: stage.mode === 'reduce' || stage.mode === 'sequential' ? 1 : 0,
      strategy: 'least-loaded',
    };
    const workers = clusterManager.acquireWorkers(request);

    if (workers.length === 0) {
      log.error(`No available workers for stage ${stageId}`);
      // Create a single failed task to mark the stage as failed
      const task = execution.createTask(stageId, 'none', prompt);
      execution.failTask(task.id, 'No available workers');
      return;
    }

    // Apply maxConcurrency limit
    const targetCount = stage.maxConcurrency
      ? Math.min(workers.length, stage.maxConcurrency)
      : workers.length;

    // Create tasks for each worker
    for (let i = 0; i < targetCount; i++) {
      const worker = workers[i];
      const task = execution.createTask(stageId, worker.id, prompt);
      this.taskPipelineMap.set(task.id, execution.id);

      // Update cluster load
      clusterManager.updateTaskCount(worker.id, 1);

      // Dispatch task to agent (via orchestrator or direct WS)
      await this.dispatchTask(task, worker, execution);
    }
  }

  /** Dispatch a task to a specific agent */
  private async dispatchTask(
    task: PipelineTask,
    worker: import('../../../../shared/types/cluster').NpuServer,
    execution: PipelineExecution,
  ): Promise<void> {
    execution.startTask(task.id);
    log.info(`Dispatched task ${task.id} to ${worker.name} (${worker.id})`);

    // TODO: Integrate with orchestrator.dispatchTask or RemoteWsClient
    // For now, the task is marked as dispatched and will be updated
    // when report_result comes through the Event Bus.
  }

  // ---- Event handling ----

  private setupListeners(): void {
    // Listen for task result reports from agents
    eventBus.on('task-result', (report: TaskResultReport) => {
      this.handleTaskResult(report);
    });

    // Listen for pipeline events (for logging)
    eventBus.on('pipeline', (event: PipelineEvent) => {
      if (event.type === 'pipeline:completed' || event.type === 'pipeline:failed') {
        const execution = this.executions.get(event.pipelineId);
        if (execution) {
          this.executions.delete(event.pipelineId);
          // Clean up taskPipelineMap
          for (const task of execution.getAllTasks()) {
            this.taskPipelineMap.delete(task.id);
          }
        }
      }
    });
  }

  private handleTaskResult(report: TaskResultReport): void {
    const pipelineId = this.taskPipelineMap.get(report.taskId);
    if (!pipelineId) return;

    const execution = this.executions.get(pipelineId);
    if (!execution) return;

    // Update cluster load
    const worker = clusterManager.getServer(report.agentId);
    if (worker) {
      clusterManager.updateTaskCount(report.agentId, -1);
    }

    if (report.status === 'completed') {
      execution.completeTask(report.taskId, report.result);
    } else {
      execution.failTask(report.taskId, report.error || 'Unknown error');
    }

    // After task result, check if new stages are ready
    if (execution.getStatus() === 'running') {
      this.scheduleReadyStages(execution);
    }
  }

  // ---- Helpers ----

  /** Resolve {{variable}} placeholders in prompt templates */
  private resolvePrompt(template: string, variables: Record<string, unknown>): string {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
      result = result.replaceAll(`{{${key}}}`, String(value));
    }
    return result;
  }
}

export const pipelineEngine = PipelineEngine.getInstance();
```

- [ ] **步骤 2：验证类型检查通过**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/main/services/agent/pipeline/pipeline-engine.ts
git commit -m "feat(hyper-space): add pipeline engine with DAG scheduling"
```

---

### 任务 7：集成 Pipeline Engine 到 Orchestrator

**文件：**
- 修改：`src/main/services/agent/orchestrator.ts`

- [ ] **步骤 1：在 orchestrator.ts 中集成 Event Bus**

在 `orchestrator.ts` 的 import 区域（约 line 36-37）后添加：

```typescript
import { eventBus } from './event-bus';
```

在 `createTeam` 方法中（约 line 230-231），将 `mailboxService.initialize(...)` 调用保留但添加注释：

```typescript
// Initialize mailbox system (legacy, will be replaced by event bus)
mailboxService.initialize(params.spaceId, teamId, allAgentIds);
```

- [ ] **步骤 2：添加 Pipeline 启动入口方法**

在 `AgentOrchestrator` 类中添加新方法（在 `executeOnSingleAgent` 方法之后）：

```typescript
/**
 * Start a pipeline execution for a Hyper Space.
 * This is the new entry point for cluster-scale operations.
 */
async startPipeline(
  spaceId: string,
  spec: import('../../../shared/types/pipeline').PipelineSpec,
): Promise<string> {
  const { pipelineEngine } = await import('./pipeline/pipeline-engine');
  const pipelineId = await pipelineEngine.startPipeline(spec);
  log.info(`Pipeline started: ${spec.name} (${pipelineId}) for space ${spaceId}`);
  return pipelineId;
}
```

- [ ] **步骤 3：验证构建通过**

运行：`npm run typecheck && npm run build`
预期：PASS

- [ ] **步骤 4：Re-read 确认改动未被覆盖**

- [ ] **步骤 5：Commit**

```bash
git add src/main/services/agent/orchestrator.ts
git commit -m "feat(hyper-space): integrate pipeline engine and event bus into orchestrator"
```

---

## Phase 3: Interaction Layer + IPC

### 任务 8：新增 IPC 通道和 Renderer API

**文件：**
- 修改：`src/preload/index.ts`
- 修改：`src/renderer/api/transport.ts`
- 修改：`src/renderer/api/index.ts`

- [ ] **步骤 1：在 preload/index.ts 中新增 IPC 通道**

搜索现有的 Hyper Space 相关 IPC 注册位置，在其附近添加：

```typescript
// Pipeline Engine
ipcRenderer.invoke('hyper-space:start-pipeline', spaceId, spec),
ipcRenderer.invoke('hyper-space:cancel-pipeline', pipelineId),
ipcRenderer.invoke('hyper-space:get-pipeline-state', pipelineId),

// Cluster Manager
ipcRenderer.invoke('hyper-space:register-server', spaceId, params),
ipcRenderer.invoke('hyper-space:unregister-server', serverId),
ipcRenderer.invoke('hyper-space:get-servers', spaceId),
ipcRenderer.invoke('hyper-space:save-cluster', spaceId),
ipcRenderer.invoke('hyper-space:load-cluster', spaceId),

// Event listeners for pipeline and cluster events
ipcRenderer.on('hyper-space:pipeline-event', callback),
ipcRenderer.on('hyper-space:cluster-event', callback),
ipcRenderer.on('hyper-space:agent-status', callback),
```

具体实现需要参照现有 preload 中其他 IPC 通道的模式（返回带类型的安全函数）。

- [ ] **步骤 2：在 api/transport.ts 中添加 methodMap 条目**

在 `methodMap` 中添加：

```typescript
'hyper-space:pipeline-event': 'hyperSpace:onPipelineEvent',
'hyper-space:cluster-event': 'hyperSpace:onClusterEvent',
'hyper-space:agent-status': 'hyperSpace:onAgentStatus',
```

- [ ] **步骤 3：在 api/index.ts 中导出 api.hyperSpace**

```typescript
export const hyperSpace = {
  // Pipeline
  startPipeline: (spaceId: string, spec: PipelineSpec) =>
    ipc<PipelineState>('hyper-space:start-pipeline', spaceId, spec),
  cancelPipeline: (pipelineId: string) =>
    ipc<void>('hyper-space:cancel-pipeline', pipelineId),
  getPipelineState: (pipelineId: string) =>
    ipc<PipelineState>('hyper-space:get-pipeline-state', pipelineId),

  // Cluster
  registerServer: (spaceId: string, params: RegisterServerParams) =>
    ipc<NpuServer>('hyper-space:register-server', spaceId, params),
  unregisterServer: (serverId: string) =>
    ipc<boolean>('hyper-space:unregister-server', serverId),
  getServers: (spaceId: string) =>
    ipc<NpuServer[]>('hyper-space:get-servers', spaceId),
  saveCluster: (spaceId: string) =>
    ipc<void>('hyper-space:save-cluster', spaceId),
  loadCluster: (spaceId: string) =>
    ipc<void>('hyper-space:load-cluster', spaceId),

  // Events
  onPipelineEvent: (callback: (event: PipelineEvent) => void) =>
    onEvent('hyper-space:pipeline-event', callback),
  onClusterEvent: (callback: (event: ClusterEvent) => void) =>
    onEvent('hyper-space:cluster-event', callback),
  onAgentStatus: (callback: (report: AgentStatusReport) => void) =>
    onEvent('hyper-space:agent-status', callback),
};
```

- [ ] **步骤 4：新增 IPC Handler**

在 `src/main/ipc/` 下新建或修改对应 handler 文件，将 IPC invoke 路由到 `pipelineEngine` 和 `clusterManager`。同时注册 `eventBus` 事件转发到 renderer：

```typescript
// 在 IPC handler 初始化中
eventBus.on('pipeline', (event) => {
  mainWindow.webContents.send('hyper-space:pipeline-event', event);
});
eventBus.on('cluster', (event) => {
  mainWindow.webContents.send('hyper-space:cluster-event', event);
});
eventBus.on('agent-status', (report) => {
  mainWindow.webContents.send('hyper-space:agent-status', report);
});
```

- [ ] **步骤 5：验证构建通过**

运行：`npm run typecheck && npm run build`
预期：PASS

- [ ] **步骤 6：Re-read 确认改动正确**

- [ ] **步骤 7：Commit**

```bash
git add src/preload/index.ts src/renderer/api/transport.ts src/renderer/api/index.ts src/main/ipc/
git commit -m "feat(hyper-space): add IPC channels and renderer API for pipeline and cluster"
```

---

## Phase 4: 前端可视化

### 任务 9：Zustand Store + Dashboard 组件

**文件：**
- 创建：`src/renderer/stores/hyper-space.store.ts`
- 创建：`src/renderer/pages/hyper-space/pipeline-dashboard.tsx`
- 创建：`src/renderer/pages/hyper-space/cluster-grid.tsx`
- 创建：`src/renderer/pages/hyper-space/agent-log-panel.tsx`

- [ ] **步骤 1：创建 Zustand Store**

在 `src/renderer/stores/hyper-space.store.ts` 中：

```typescript
import { create } from 'zustand';
import type {
  PipelineState,
  PipelineEvent,
  PipelineStatus,
} from@shared/types/pipeline';
import type {
  NpuServer,
  ClusterEvent,
  ServerStatus,
} from '@shared/types/cluster';

interface AgentLogEntry {
  agentId: string;
  timestamp: number;
  content: string;
}

interface HyperSpaceState {
  // Pipeline
  pipelines: Map<string, {
    name: string;
    status: PipelineStatus;
    stages: Map<string, { name: string; status: string; progress: number }>;
  }>;

  // Cluster
  servers: Map<string, NpuServer>;

  // Agent status
  agentStatuses: Map<string, {
    progress: number;
    gpuUtilization?: number;
    metrics?: Record<string, unknown>;
    logTail?: string;
  }>;

  // Agent logs
  agentLogs: Map<string, AgentLogEntry[]>;

  // Selected agent for log viewing
  selectedAgentId: string | null;

  // Actions
  handlePipelineEvent: (event: PipelineEvent) => void;
  handleClusterEvent: (event: ClusterEvent) => void;
  handleAgentStatus: (report: { agentId: string; progress: number; gpuUtilization?: number; metrics?: Record<string, unknown>; logTail?: string }) => void;
  setSelectedAgent: (agentId: string | null) => void;
}

export const useHyperSpaceStore = create<HyperSpaceState>((set, get) => ({
  pipelines: new Map(),
  servers: new Map(),
  agentStatuses: new Map(),
  agentLogs: new Map(),
  selectedAgentId: null,

  handlePipelineEvent: (event) => {
    set((state) => {
      const pipelines = new Map(state.pipelines);
      // Update pipeline/stage/task status based on event type
      switch (event.type) {
        case 'pipeline:started': {
          pipelines.set(event.pipelineId, {
            name: '',
            status: 'running',
            stages: new Map(),
          });
          break;
        }
        case 'pipeline:completed': {
          const p = pipelines.get(event.pipelineId);
          if (p) p.status = 'completed';
          break;
        }
        case 'pipeline:failed': {
          const p = pipelines.get(event.pipelineId);
          if (p) p.status = 'failed';
          break;
        }
        case 'stage:started': {
          const p = pipelines.get(event.pipelineId);
          if (p) p.stages.set(event.stageId, { name: event.stageId, status: 'running', progress: 0 });
          break;
        }
        case 'stage:completed': {
          const p = pipelines.get(event.pipelineId);
          if (p) {
            const s = p.stages.get(event.stageId);
            if (s) { s.status = 'completed'; s.progress = 1; }
          }
          break;
        }
        case 'stage:failed': {
          const p = pipelines.get(event.pipelineId);
          if (p) {
            const s = p.stages.get(event.stageId);
            if (s) s.status = 'failed';
          }
          break;
        }
        case 'task:completed': {
          const p = pipelines.get(event.pipelineId);
          if (p) {
            const s = p.stages.get(event.stageId);
            if (s) s.progress = Math.min(1, (s.progress || 0) + 0.1);
          }
          break;
        }
      }
      return { pipelines };
    });
  },

  handleClusterEvent: (event) => {
    set((state) => {
      const servers = new Map(state.servers);
      switch (event.type) {
        case 'server:registered':
        case 'server:online':
        case 'server:offline':
        case 'server:heartbeat': {
          // Update server status (will be populated from getServers API)
          break;
        }
      }
      return { servers };
    });
  },

  handleAgentStatus: (report) => {
    set((state) => {
      const agentStatuses = new Map(state.agentStatuses);
      agentStatuses.set(report.agentId, {
        progress: report.progress,
        gpuUtilization: report.gpuUtilization,
        metrics: report.metrics,
        logTail: report.logTail,
      });

      // Append log
      if (report.logTail) {
        const agentLogs = new Map(state.agentLogs);
        const logs = [...(agentLogs.get(report.agentId) || [])];
        logs.push({
          agentId: report.agentId,
          timestamp: Date.now(),
          content: report.logTail,
        });
        // Keep only last 100 entries per agent
        if (logs.length > 100) logs.splice(0, logs.length - 100);
        agentLogs.set(report.agentId, logs);
        return { agentStatuses, agentLogs };
      }

      return { agentStatuses };
    });
  },

  setSelectedAgent: (agentId) => set({ selectedAgentId: agentId }),
}));
```

- [ ] **步骤 2：创建 Dashboard 组件骨架**

三个前端组件（`pipeline-dashboard.tsx`、`cluster-grid.tsx`、`agent-log-panel.tsx`）为 React 函数组件，使用 Tailwind CSS + 项目现有 UI 模式。组件实现细节在具体实现时根据项目现有组件库（Button、Card 等）编写。

`pipeline-dashboard.tsx` 核心：从 `useHyperSpaceStore` 读取 pipeline 状态，渲染阶段进度列表。
`cluster-grid.tsx` 核心：从 store 读取服务器列表，渲染状态网格（绿/黄/红状态标记）。
`agent-log-panel.tsx` 核心：从 store 读取选中 Agent 的日志，实时滚动显示。

- [ ] **步骤 3：验证构建通过**

运行：`npm run typecheck && npm run build`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/renderer/stores/hyper-space.store.ts src/renderer/pages/hyper-space/
git commit -m "feat(hyper-space): add Zustand store and dashboard UI components"
```

---

### 任务 10：端到端集成验证

- [ ] **步骤 1：运行完整构建**

```bash
npm run typecheck && npm run build
```

预期：全部通过，无类型错误。

- [ ] **步骤 2：启动开发服务器手动验证**

```bash
npm run dev
```

验证点：
1. 应用正常启动，无崩溃
2. 创建 Hyper Space 空间时，新类型和 Cluster Manager 不影响现有流程
3. 现有 Leader-Worker 协同功能正常（向后兼容）

- [ ] **步骤 3：最终 Commit**

如果有任何集成修复：

```bash
git add -A
git commit -m "fix(hyper-space): integration fixes from end-to-end verification"
```
