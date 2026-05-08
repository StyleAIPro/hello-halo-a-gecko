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
  PipelineTask,
  PipelineEvent,
} from '../../../../shared/types/pipeline';
import type { TaskResultReport } from '../event-bus';
import type { AcquireWorkersRequest, NpuServer } from '../../../../shared/types/cluster';

const log = createLogger('pipeline-engine');

class PipelineEngine {
  private static instance: PipelineEngine | null = null;

  private executions: Map<string, PipelineExecution> = new Map();

  /** Reverse map: taskId → pipelineId */
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

  async startPipeline(spec: PipelineSpec): Promise<string> {
    const pipelineId = spec.id || uuidv4();
    spec.id = pipelineId;

    const execution = new PipelineExecution(spec);
    this.executions.set(pipelineId, execution);

    execution.start();
    await this.scheduleReadyStages(execution);

    return pipelineId;
  }

  getExecution(pipelineId: string): PipelineExecution | undefined {
    return this.executions.get(pipelineId);
  }

  cancelPipeline(pipelineId: string): void {
    const execution = this.executions.get(pipelineId);
    if (execution) {
      execution.cancel();
      this.executions.delete(pipelineId);
    }
  }

  // ---- Scheduling ----

  private async scheduleReadyStages(execution: PipelineExecution): Promise<void> {
    const readyStageIds = execution.getReadyStages();

    for (const stageId of readyStageIds) {
      await this.scheduleStage(execution, stageId);
    }
  }

  private async scheduleStage(execution: PipelineExecution, stageId: string): Promise<void> {
    const spec = execution.spec;
    const stage = spec.stages.find((s) => s.id === stageId);
    if (!stage) return;

    execution.startStage(stageId);

    const prompt = this.resolvePrompt(stage.taskPrompt, spec.variables);

    const request: AcquireWorkersRequest = {
      selector: stage.targetSelector || 'all',
      count: stage.mode === 'reduce' || stage.mode === 'sequential' ? 1 : 0,
      strategy: 'least-loaded',
    };
    const workers = clusterManager.acquireWorkers(request);

    if (workers.length === 0) {
      log.error(`No available workers for stage ${stageId}`);
      const task = execution.createTask(stageId, 'none', prompt);
      execution.failTask(task.id, 'No available workers');
      return;
    }

    const targetCount = stage.maxConcurrency
      ? Math.min(workers.length, stage.maxConcurrency)
      : workers.length;

    for (let i = 0; i < targetCount; i++) {
      const worker = workers[i];
      const task = execution.createTask(stageId, worker.id, prompt);
      this.taskPipelineMap.set(task.id, execution.id);

      clusterManager.updateTaskCount(worker.id, 1);

      await this.dispatchTask(task, worker, execution);
    }
  }

  private async dispatchTask(
    task: PipelineTask,
    worker: NpuServer,
    execution: PipelineExecution,
  ): Promise<void> {
    execution.startTask(task.id);
    log.info(`Dispatched task ${task.id} to ${worker.name} (${worker.id})`);

    // The task is dispatched and will be updated when report_result
    // comes through the Event Bus from the agent.
  }

  // ---- Event handling ----

  private setupListeners(): void {
    eventBus.on('task-result', (report: TaskResultReport) => {
      this.handleTaskResult(report);
    });

    eventBus.on('pipeline', (event: PipelineEvent) => {
      if (event.type === 'pipeline:completed' || event.type === 'pipeline:failed') {
        const execution = this.executions.get(event.pipelineId);
        if (execution) {
          this.executions.delete(event.pipelineId);
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

    const worker = clusterManager.getServer(report.agentId);
    if (worker) {
      clusterManager.updateTaskCount(report.agentId, -1);
    }

    if (report.status === 'completed') {
      execution.completeTask(report.taskId, report.result);
    } else {
      execution.failTask(report.taskId, report.error || 'Unknown error');
    }

    if (execution.getStatus() === 'running') {
      this.scheduleReadyStages(execution);
    }
  }

  // ---- Helpers ----

  private resolvePrompt(template: string, variables: Record<string, unknown>): string {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
      result = result.split(`{{${key}}}`).join(String(value));
    }
    return result;
  }
}

export const pipelineEngine = PipelineEngine.getInstance();
