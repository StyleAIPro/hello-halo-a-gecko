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