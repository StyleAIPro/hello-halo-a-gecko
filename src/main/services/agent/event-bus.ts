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
import { createLogger } from '../log';
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

class HyperSpaceEventBus extends EventEmitter {
  private static instance: HyperSpaceEventBus | null = null;

  /** Pending messages per agent (for agents that are temporarily offline) */
  private pendingMessages: Map<string, AgentMessage[]> = new Map();

  private constructor() {
    super();
    this.setMaxListeners(100);
    log.info('Event Bus initialized');
  }

  static getInstance(): HyperSpaceEventBus {
    if (!HyperSpaceEventBus.instance) {
      HyperSpaceEventBus.instance = new HyperSpaceEventBus();
    }
    return HyperSpaceEventBus.instance;
  }

  // ---- Message methods ----

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

  broadcast(payload: BroadcastPayload): void {
    this.emit('broadcast', payload);
    log.debug(`Broadcast from ${payload.from}: ${payload.message.substring(0, 80)}`);
  }

  reportTaskResult(report: TaskResultReport): void {
    this.emit('task-result', report);
    log.debug(`Task result: ${report.agentId} task=${report.taskId} status=${report.status}`);
  }

  reportAgentStatus(report: AgentStatusReport): void {
    this.emit('agent-status', report);
  }

  emitPipelineEvent(event: PipelineEvent): void {
    this.emit('pipeline', event);
  }

  emitClusterEvent(event: ClusterEvent): void {
    this.emit('cluster', event);
  }

  // ---- Pending messages ----

  storePending(agentId: string, message: AgentMessage): void {
    const queue = this.pendingMessages.get(agentId) || [];
    queue.push(message);
    this.pendingMessages.set(agentId, queue);
  }

  drainPending(agentId: string): AgentMessage[] {
    const messages = this.pendingMessages.get(agentId) || [];
    this.pendingMessages.delete(agentId);
    return messages;
  }
}

export const eventBus = HyperSpaceEventBus.getInstance();