/**
 * TaskBoard Service for Multi-Agent Team Collaboration
 *
 * Provides a file-backed shared task board where:
 * - Leaders/users can post tasks
 * - Workers can view and claim tasks matching their capabilities
 * - Task lifecycle is tracked (posted -> claimed -> in_progress -> completed/failed)
 *
 * Storage: ~/.aico-bot/spaces/{spaceId}/taskboard.json
 *
 * @module taskboard
 */

import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getSpacesDir } from '../config.service';
import { createLogger } from '../../utils/logger';
import type {
  TaskBoardTask,
  TaskBoardTaskStatus,
  TaskBoardPriority,
  TaskBoardFile,
  PostTaskInput,
  TaskBoardFilter,
} from '../../../shared/types/taskboard';

const log = createLogger('taskboard');

// ============================================
// TaskBoard Service
// ============================================

/**
 * Manages a shared task board for a Hyper Space team.
 */
export class TaskBoardService {
  /** Track initialized boards to avoid duplicate init */
  private boards: Map<string, { teamId: string; spaceId: string }> = new Map();

  /**
   * Initialize a task board for a space.
   * Creates the taskboard.json file if it doesn't exist.
   */
  initialize(spaceId: string, teamId: string): void {
    const filePath = this.getBoardPath(spaceId);
    const dir = this.getBoardDir(spaceId);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (!existsSync(filePath)) {
      const board: TaskBoardFile = {
        teamId,
        spaceId,
        tasks: [],
        lastModified: Date.now(),
      };
      this.writeBoard(filePath, board);
      log.info(`Initialized task board for space ${spaceId}`);
    }

    this.boards.set(spaceId, { teamId, spaceId });
  }

  /**
   * Destroy the task board for a space.
   */
  destroy(spaceId: string): void {
    const filePath = this.getBoardPath(spaceId);
    try {
      if (existsSync(filePath)) {
        rmSync(filePath, { force: true });
        log.info(`Destroyed task board for space ${spaceId}`);
      }
    } catch (err) {
      log.error(`Failed to destroy task board for space ${spaceId}:`, err);
    }
    this.boards.delete(spaceId);
  }

  /**
   * Post a new task to the board.
   * Returns the created task with its assigned ID.
   */
  postTask(spaceId: string, input: PostTaskInput): TaskBoardTask {
    const board = this.loadBoard(spaceId);

    const task: TaskBoardTask = {
      id: uuidv4(),
      title: input.title,
      description: input.description,
      status: 'posted',
      priority: input.priority || 'normal',
      requiredCapabilities: input.requiredCapabilities || [],
      postedBy: input.postedBy || 'user',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      retryCount: 0,
      maxRetries: input.maxRetries ?? 2,
      targetServerId: input.targetServerId,
      parentConversationId: input.parentConversationId,
    };

    board.tasks.push(task);
    board.lastModified = Date.now();
    this.writeBoard(this.getBoardPath(spaceId), board);

    log.info(`Task posted: "${task.title}" (${task.id}) priority=${task.priority}`);
    return task;
  }

  /**
   * Claim a task from the board.
   * Returns null if the task is not found, already claimed, or the claim is stale.
   */
  claimTask(
    taskId: string,
    agentId: string,
    agentName?: string,
    spaceId?: string,
  ): TaskBoardTask | null {
    const resolvedSpaceId = spaceId || this.findSpaceForTask(taskId);
    if (!resolvedSpaceId) {
      log.warn(`Cannot claim task ${taskId}: board not found`);
      return null;
    }

    const board = this.loadBoard(resolvedSpaceId);
    const task = board.tasks.find((t) => t.id === taskId);

    if (!task) {
      log.warn(`Task ${taskId} not found on board`);
      return null;
    }

    // Guard: only unclaimed tasks or failed tasks eligible for retry can be claimed
    if (
      task.status !== 'posted' &&
      !(task.status === 'failed' && task.retryCount < task.maxRetries)
    ) {
      log.warn(`Task ${taskId} is not claimable (status: ${task.status})`);
      return null;
    }

    // Mark as claimed
    task.status = 'claimed';
    task.claimedBy = agentId;
    task.claimedByName = agentName;
    task.claimedAt = Date.now();
    task.updatedAt = Date.now();

    // If retrying a failed task, increment retry count
    if (task.retryCount > 0) {
      task.retryCount++;
    }

    board.lastModified = Date.now();
    this.writeBoard(this.getBoardPath(resolvedSpaceId), board);

    log.info(`Task "${task.title}" (${taskId}) claimed by ${agentName || agentId}`);
    return task;
  }

  /**
   * Update a task's status.
   */
  updateTaskStatus(
    taskId: string,
    status: TaskBoardTaskStatus,
    result?: string,
    error?: string,
    spaceId?: string,
  ): TaskBoardTask | null {
    const resolvedSpaceId = spaceId || this.findSpaceForTask(taskId);
    if (!resolvedSpaceId) return null;

    const board = this.loadBoard(resolvedSpaceId);
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return null;

    task.status = status;
    task.updatedAt = Date.now();

    if (status === 'completed' || status === 'failed') {
      task.completedAt = Date.now();
      if (result) task.result = result;
      if (error) task.error = error;
    }

    board.lastModified = Date.now();
    this.writeBoard(this.getBoardPath(resolvedSpaceId), board);

    log.info(`Task "${task.title}" (${taskId}) status -> ${status}`);
    return task;
  }

  /**
   * Set the subagent task ID for a TaskBoard task (links to orchestrator execution).
   */
  linkSubagentTask(taskId: string, subagentTaskId: string, spaceId?: string): void {
    const resolvedSpaceId = spaceId || this.findSpaceForTask(taskId);
    if (!resolvedSpaceId) return;

    const board = this.loadBoard(resolvedSpaceId);
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return;

    task.subagentTaskId = subagentTaskId;
    task.status = 'in_progress';
    task.updatedAt = Date.now();
    board.lastModified = Date.now();
    this.writeBoard(this.getBoardPath(resolvedSpaceId), board);
  }

  /**
   * Get all unclaimed tasks (available for workers to claim).
   */
  getUnclaimedTasks(spaceId: string): TaskBoardTask[] {
    const board = this.loadBoard(spaceId);
    return board.tasks.filter(
      (t) => t.status === 'posted' || (t.status === 'failed' && t.retryCount < t.maxRetries),
    );
  }

  /**
   * Get tasks assigned to a specific agent.
   */
  getTasksForAgent(agentId: string, spaceId: string): TaskBoardTask[] {
    const board = this.loadBoard(spaceId);
    return board.tasks.filter((t) => t.claimedBy === agentId);
  }

  /**
   * Get all tasks on the board, optionally filtered.
   */
  getTasks(spaceId: string, filter?: TaskBoardFilter): TaskBoardTask[] {
    const board = this.loadBoard(spaceId);
    let tasks = board.tasks;

    if (filter) {
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        tasks = tasks.filter((t) => statuses.includes(t.status));
      }
      if (filter.assignedTo) {
        tasks = tasks.filter((t) => t.claimedBy === filter.assignedTo);
      }
      if (filter.postedBy) {
        tasks = tasks.filter((t) => t.postedBy === filter.postedBy);
      }
      if (filter.priority) {
        const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority];
        tasks = tasks.filter((t) => priorities.includes(t.priority));
      }
    }

    return tasks;
  }

  /**
   * Get a single task by ID.
   */
  getTask(taskId: string, spaceId?: string): TaskBoardTask | null {
    const resolvedSpaceId = spaceId || this.findSpaceForTask(taskId);
    if (!resolvedSpaceId) return null;

    const board = this.loadBoard(resolvedSpaceId);
    return board.tasks.find((t) => t.id === taskId) || null;
  }

  /**
   * Find the best worker for a task based on capability matching and load.
   * Returns null if no suitable worker is found.
   */
  findBestWorker(
    task: TaskBoardTask,
    workers: Array<{
      id: string;
      name?: string;
      status: string;
      capabilities?: string[];
      currentTaskId?: string;
    }>,
  ): { id: string; name: string } | null {
    // Filter workers that match capabilities and are idle
    const idleWorkers = workers.filter((w) => w.status === 'idle' && !w.currentTaskId);

    if (idleWorkers.length === 0) return null;

    // If task has required capabilities, filter further
    let candidates = idleWorkers;
    if (task.requiredCapabilities.length > 0) {
      candidates = idleWorkers.filter((w) => {
        const workerCaps = w.capabilities || [];
        return task.requiredCapabilities.every((cap) =>
          workerCaps.some((wc) => wc.toLowerCase() === cap.toLowerCase()),
        );
      });
    }

    if (candidates.length === 0) return null;

    // Pick the first matching candidate (could use more sophisticated load balancing)
    const chosen = candidates[0];
    return { id: chosen.id, name: chosen.name || chosen.id };
  }

  /**
   * Remove a task from the board.
   */
  removeTask(taskId: string, spaceId?: string): boolean {
    const resolvedSpaceId = spaceId || this.findSpaceForTask(taskId);
    if (!resolvedSpaceId) return false;

    const board = this.loadBoard(resolvedSpaceId);
    const index = board.tasks.findIndex((t) => t.id === taskId);
    if (index === -1) return false;

    board.tasks.splice(index, 1);
    board.lastModified = Date.now();
    this.writeBoard(this.getBoardPath(resolvedSpaceId), board);

    log.info(`Task ${taskId} removed from board`);
    return true;
  }

  // ============================================
  // Private Methods
  // ============================================

  private getBoardDir(spaceId: string): string {
    return join(getSpacesDir(), spaceId);
  }

  private getBoardPath(spaceId: string): string {
    return join(this.getBoardDir(spaceId), 'taskboard.json');
  }

  private loadBoard(spaceId: string): TaskBoardFile {
    const filePath = this.getBoardPath(spaceId);
    if (!existsSync(filePath)) {
      const info = this.boards.get(spaceId);
      throw new Error(`TaskBoard not found for space ${spaceId}. Initialize first.`);
    }
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as TaskBoardFile;
  }

  private writeBoard(filePath: string, board: TaskBoardFile): void {
    // Write atomically using temp file
    const tmpPath = `${filePath}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(board, null, 2), 'utf-8');
      writeFileSync(filePath, readFileSync(tmpPath, 'utf-8'), 'utf-8');
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
    } catch (err) {
      try {
        if (existsSync(tmpPath)) {
          const { unlinkSync } = require('fs');
          unlinkSync(tmpPath);
        }
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    }
  }

  /**
   * Find the space ID containing a task by searching all known boards.
   */
  private findSpaceForTask(taskId: string): string | undefined {
    // Try to search through known boards
    for (const [spaceId] of this.boards) {
      try {
        const board = this.loadBoard(spaceId);
        if (board.tasks.some((t) => t.id === taskId)) {
          return spaceId;
        }
      } catch {
        // Board file may not exist or be corrupt
      }
    }
    return undefined;
  }
}

// ============================================
// Singleton Export
// ============================================

/** Global task board service instance */
export const taskboardService = new TaskBoardService();
