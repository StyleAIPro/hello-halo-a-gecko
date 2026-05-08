/**
 * Pipeline Execution
 *
 * Manages the state machine of a single pipeline run.
 * Tracks stages, tasks, and handles retry/iteration logic.
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../log';
import { eventBus } from '../event-bus';
import type {
  PipelineSpec,
  PipelineState,
  PipelineStatus,
  PipelineTask,
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

  getReadyStages(): string[] {
    const ready: string[] = [];

    for (const stage of this.spec.stages) {
      const status = this.state.stages.get(stage.id);
      if (status !== 'pending') continue;

      const incomingEdges = this.spec.edges.filter((e) => e.to === stage.id);
      if (incomingEdges.length === 0) {
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

  start(): void {
    this.state.status = 'running';
    this.state.startedAt = Date.now();
    this.emit({ type: 'pipeline:started', pipelineId: this.id });
    log.info(`Pipeline started: ${this.spec.name} (${this.id})`);
  }

  startStage(stageId: string): void {
    this.state.stages.set(stageId, 'running');
    this.emit({ type: 'stage:started', pipelineId: this.id, stageId });
    log.info(`Stage started: ${stageId}`);
  }

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

  startTask(taskId: string): void {
    const task = this.state.tasks.get(taskId);
    if (!task) return;
    task.status = 'running';
    task.startedAt = Date.now();
  }

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

  failTask(taskId: string, error: string): void {
    const task = this.state.tasks.get(taskId);
    if (!task) return;

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
    if (stageStatus === 'completed') {
      this.emit({ type: 'stage:completed', pipelineId: this.id, stageId });
    } else {
      this.emit({ type: 'stage:failed', pipelineId: this.id, stageId, error: 'One or more tasks failed' });
    }

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

        if (this.spec.stages.findIndex((s) => s.id === edge.to) <=
            this.spec.stages.findIndex((s) => s.id === edge.from)) {
          this.state.iterationCount++;
          log.info(`Iteration ${this.state.iterationCount}: ${edge.from} → ${edge.to}`);
          this.resetStagesFrom(edge.to);
        }
      }
    }

    this.checkPipelineCompletion();
  }

  private resetStagesFrom(stageId: string): void {
    const stageIdx = this.spec.stages.findIndex((s) => s.id === stageId);
    for (let i = stageIdx; i < this.spec.stages.length; i++) {
      const id = this.spec.stages[i].id;
      this.state.stages.set(id, 'pending');
      for (const [taskId, task] of Array.from(this.state.tasks)) {
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
    if (anyFailed) {
      this.emit({ type: 'pipeline:failed', pipelineId: this.id, error: 'One or more stages failed' });
    } else {
      this.emit({ type: 'pipeline:completed', pipelineId: this.id });
    }
    log.info(`Pipeline ${this.state.status}: ${this.spec.name}`);
  }

  private isEdgeSatisfied(edge: StageEdge): boolean {
    const fromStatus = this.state.stages.get(edge.from);
    if (!fromStatus) return false;

    switch (edge.condition ?? 'on-all-complete') {
      case 'on-all-complete':
        return fromStatus === 'completed' || fromStatus === 'failed';
      case 'on-success':
        return fromStatus === 'completed';
      case 'on-failure':
        return fromStatus === 'failed';
      case 'on-any-complete':
        return this.state.traversedEdges.has(`${edge.from}->${edge.to}`) ||
          fromStatus === 'completed' || fromStatus === 'failed';
      default:
        return false;
    }
  }

  private emit(event: PipelineEvent): void {
    eventBus.emitPipelineEvent(event);
  }
}
