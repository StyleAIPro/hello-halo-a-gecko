/**
 * TaskBoard Types for Multi-Agent Team Collaboration
 *
 * Provides a shared task board where tasks can be posted, claimed,
 * and tracked by all agents in a Hyper Space team.
 */

// ============================================
// Task Status
// ============================================

/**
 * Lifecycle states for a TaskBoard task.
 *
 * posted -> claimed -> in_progress -> completed
 *                                -> failed -> (retry) -> claimed
 */
export type TaskBoardTaskStatus = 'posted' | 'claimed' | 'in_progress' | 'completed' | 'failed';

/**
 * Task priority levels.
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

// ============================================
// Task Board Task
// ============================================

/**
 * A task on the shared TaskBoard.
 * All agents can see and claim tasks matching their capabilities.
 */
export interface TaskBoardTask {
  /** Unique task ID */
  id: string;

  /** Short title for display */
  title: string;

  /** Detailed description of what needs to be done */
  description: string;

  /** Current status in the task lifecycle */
  status: TaskBoardTaskStatus;

  /** Task priority */
  priority: TaskPriority;

  /** Capabilities required to complete this task (e.g., ['NPU操作', '模型训练']) */
  requiredCapabilities: string[];

  /** Agent ID or 'user' that posted the task */
  postedBy: string;

  /** Agent ID that claimed the task (null when unclaimed) */
  claimedBy?: string;

  /** Name of the agent that claimed the task */
  claimedByName?: string;

  /** When the task was claimed */
  claimedAt?: number;

  /** When the task was completed or failed */
  completedAt?: number;

  /** Task result (for completed tasks) */
  result?: string;

  /** Error message (for failed tasks) */
  error?: string;

  /** When the task was created */
  createdAt: number;

  /** When the task was last updated */
  updatedAt: number;

  /** Target server ID for NPU cluster routing */
  targetServerId?: string;

  /** Number of times this task has been retried */
  retryCount: number;

  /** Maximum retries before marking as permanently failed */
  maxRetries: number;

  /** Parent conversation ID (links to the orchestrator's SubagentTask) */
  parentConversationId?: string;

  /** Corresponding SubagentTask ID in the orchestrator (when claimed and executing) */
  subagentTaskId?: string;
}

// ============================================
// TaskBoard File Structure
// ============================================

/**
 * On-disk format for the TaskBoard.
 * Stored at: ~/.aico-bot/spaces/{spaceId}/taskboard.json
 */
export interface TaskBoardFile {
  /** Team ID this board belongs to */
  teamId: string;

  /** Space ID this board belongs to */
  spaceId: string;

  /** All tasks on the board */
  tasks: TaskBoardTask[];

  /** Last modification timestamp */
  lastModified: number;
}

// ============================================
// Utility Types
// ============================================

/**
 * Input for posting a new task to the board.
 * Auto-generated fields (id, status, timestamps, retryCount) are omitted.
 */
export interface PostTaskInput {
  title: string;
  description: string;
  priority?: TaskPriority;
  requiredCapabilities?: string[];
  targetServerId?: string;
  maxRetries?: number;
  postedBy?: string;
  parentConversationId?: string;
}

/**
 * Filter options for querying the TaskBoard.
 */
export interface TaskBoardFilter {
  status?: TaskBoardTaskStatus | TaskBoardTaskStatus[];
  assignedTo?: string; // Agent ID
  postedBy?: string;
  priority?: TaskPriority | TaskPriority[];
  capabilities?: string[];
}
