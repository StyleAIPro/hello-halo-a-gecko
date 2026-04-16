/**
 * IPC Handlers for Hyper Space
 *
 * Handles IPC communication for multi-agent Hyper Space features
 */

import { ipcMain } from 'electron'
import { agentOrchestrator } from '../services/agent/orchestrator'
import { taskboardService } from '../services/agent/taskboard'
import { permissionForwarder } from '../services/agent/permission-forwarder'
import type {
  AgentConfig,
  OrchestrationConfig,
  SubagentTask,
  CreateHyperSpaceInput
} from '../../shared/types/hyper-space'
import type { PostTaskInput } from '../../shared/types/taskboard'
import { createSpace, createHyperSpace, getSpace, updateSpace } from '../services/space.service'
import type { Space } from '../../shared/types'

/**
 * Register Hyper Space IPC handlers
 */
export function registerHyperSpaceHandlers(): void {
  console.log('[IPC] Registering Hyper Space handlers')

  // ============================================
  // Team Management
  // ============================================

  /**
   * Create a Hyper Space with agent team
   */
  ipcMain.handle('hyper-space:create', async (_event, input: CreateHyperSpaceInput) => {
    try {
      // Use createHyperSpace for hyper spaces
      if (input.spaceType === 'hyper') {
        const space = createHyperSpace(input)

        if (!space) {
          return { success: false, error: 'Failed to create Hyper Space' }
        }

        console.log(`[IPC] Created Hyper Space ${space.id} with ${input.agents?.length || 0} agents`)

        return { success: true, space }
      }

      // Fallback to regular space creation
      const space = createSpace({
        name: input.name,
        icon: input.icon,
        customPath: input.customPath,
        claudeSource: input.claudeSource || 'local',
        remoteServerId: input.remoteServerId,
        remotePath: input.remotePath,
        useSshTunnel: input.useSshTunnel
      })

      return { success: true, space }
    } catch (error) {
      console.error('[IPC] Failed to create Hyper Space:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  /**
   * Get Hyper Space team status
   */
  ipcMain.handle('hyper-space:get-status', async (_event, spaceId: string) => {
    try {
      const status = agentOrchestrator.getTeamStatus(
        agentOrchestrator.getTeamBySpace(spaceId)?.id || ''
      )

      if (!status) {
        return { success: false, error: 'Team not found' }
      }

      return { success: true, status }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  /**
   * Get worker session states for recovery after page refresh.
   * Returns status info for all workers that have been started.
   */
  ipcMain.handle('hyper-space:get-worker-states', async (_event, spaceId: string) => {
    try {
      const workerStates = agentOrchestrator.getWorkerSessionStates(spaceId)
      return { success: true, data: workerStates }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  /**
   * Add agent to existing Hyper Space
   */
  ipcMain.handle('hyper-space:add-agent', async (_event, params: {
    spaceId: string
    agent: AgentConfig
  }) => {
    try {
      const team = agentOrchestrator.getTeamBySpace(params.spaceId)
      if (!team) {
        return { success: false, error: 'Hyper Space team not found' }
      }

      const success = agentOrchestrator.addAgentToTeam(team.id, params.agent)

      return { success }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  /**
   * Remove agent from Hyper Space
   */
  ipcMain.handle('hyper-space:remove-agent', async (_event, params: {
    spaceId: string
    agentId: string
  }) => {
    try {
      const team = agentOrchestrator.getTeamBySpace(params.spaceId)
      if (!team) {
        return { success: false, error: 'Hyper Space team not found' }
      }

      const success = agentOrchestrator.removeAgentFromTeam(team.id, params.agentId)

      return { success }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // ============================================
  // Task Dispatching
  // ============================================

  /**
   * Dispatch a task to agents
   */
  ipcMain.handle('hyper-space:dispatch-task', async (_event, params: {
    spaceId: string
    task: string
    conversationId: string
  }) => {
    try {
      const team = agentOrchestrator.getTeamBySpace(params.spaceId)
      if (!team) {
        return { success: false, error: 'Hyper Space team not found' }
      }

      const tasks = await agentOrchestrator.dispatchTask({
        teamId: team.id,
        task: params.task,
        conversationId: params.conversationId
      })

      return {
        success: true,
        tasks: tasks.map(t => ({
          id: t.id,
          agentId: t.agentId,
          status: t.status,
          task: t.task
        }))
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  /**
   * Get task status
   */
  ipcMain.handle('hyper-space:get-task', async (_event, taskId: string) => {
    try {
      const task = agentOrchestrator.getTask(taskId)
      if (!task) {
        return { success: false, error: 'Task not found' }
      }

      return { success: true, task }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  /**
   * Get all tasks for a conversation
   */
  ipcMain.handle('hyper-space:get-tasks', async (_event, conversationId: string) => {
    try {
      const tasks = agentOrchestrator.getTasksForConversation(conversationId)
      return { success: true, tasks }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  /**
   * Wait for all tasks to complete
   */
  ipcMain.handle('hyper-space:wait-completion', async (_event, params: {
    conversationId: string
    timeout?: number
  }) => {
    try {
      const tasks = await agentOrchestrator.waitForCompletion({
        conversationId: params.conversationId,
        timeout: params.timeout
      })

      return { success: true, tasks }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  /**
   * Aggregate results from multiple tasks
   */
  ipcMain.handle('hyper-space:aggregate-results', async (_event, params: {
    conversationId: string
    strategy: 'concat' | 'summarize' | 'vote'
  }) => {
    try {
      const tasks = agentOrchestrator.getTasksForConversation(params.conversationId)
      const result = agentOrchestrator.aggregateResults(tasks, params.strategy)

      return { success: true, result }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // ============================================
  // Orchestration Configuration
  // ============================================

  /**
   * Update orchestration configuration
   */
  ipcMain.handle('hyper-space:update-config', async (_event, params: {
    spaceId: string
    config: Partial<OrchestrationConfig>
  }) => {
    try {
      const ok = agentOrchestrator.updateTeamConfig(params.spaceId, params.config)
      if (!ok) {
        return { success: false, error: 'Hyper Space team not found' }
      }
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // ============================================
  // Agent Mention (for @ autocomplete)
  // ============================================

  /**
   * Get HyperSpace members for @ mention autocomplete
   */
  ipcMain.handle('hyper-space:get-members', async (_event, spaceId: string) => {
    try {
      const members = agentOrchestrator.getTeamMembers(spaceId)

      if (members) {
        return { success: true, data: { members } }
      }

      // Team not in runtime, try to get from space definition
      const space = getSpace(spaceId)
      if (space && space.agents) {
        return {
          success: true,
          data: {
            members: space.agents.map(a => ({
              id: a.id,
              name: a.name,
              role: a.role,
              type: a.type,
              capabilities: a.capabilities
            }))
          }
        }
      }

      return { success: false, error: 'Hyper Space team not found' }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // ============================================
  // TaskBoard
  // ============================================

  /**
   * Get all tasks on the shared TaskBoard
   */
  ipcMain.handle('hyper-space:get-taskboard', async (_event, spaceId: string) => {
    try {
      const tasks = taskboardService.getTasks(spaceId)
      return { success: true, data: { tasks } }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  /**
   * Post a new task to the TaskBoard
   */
  ipcMain.handle('hyper-space:post-task', async (_event, spaceId: string, input: PostTaskInput) => {
    try {
      const task = taskboardService.postTask(spaceId, input)
      return { success: true, data: task }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  /**
   * Claim a task from the TaskBoard
   */
  ipcMain.handle('hyper-space:claim-task', async (_event, spaceId: string, taskId: string, agentId: string, agentName?: string) => {
    try {
      const task = taskboardService.claimTask(taskId, agentId, agentName, spaceId)
      if (!task) {
        return { success: false, error: 'Task not found or not claimable' }
      }
      return { success: true, data: task }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  /**
   * Update task status on the TaskBoard
   */
  ipcMain.handle('hyper-space:update-task-status', async (
    _event,
    spaceId: string,
    taskId: string,
    status: string,
    result?: string,
    error?: string
  ) => {
    try {
      const task = taskboardService.updateTaskStatus(
        taskId,
        status as any,
        result,
        error,
        spaceId
      )
      if (!task) {
        return { success: false, error: 'Task not found' }
      }
      return { success: true, data: task }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // ============================================
  // Persistent Mode
  // ============================================

  /**
   * Enable/disable persistent worker mode for a team.
   * When enabled, workers stay alive between tasks and auto-claim from TaskBoard.
   */
  ipcMain.handle('hyper-space:set-persistent-mode', async (_event, spaceId: string, enabled: boolean) => {
    try {
      const team = agentOrchestrator.getTeamBySpace(spaceId)
      if (!team) {
        return { success: false, error: 'Team not found for this space' }
      }

      if (enabled) {
        await agentOrchestrator.startPersistentWorkers(team.id)
      } else {
        await agentOrchestrator.stopPersistentWorkers(team.id)
      }

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  /**
   * Check if persistent mode is active for a space.
   */
  ipcMain.handle('hyper-space:get-persistent-mode', async (_event, spaceId: string) => {
    try {
      const team = agentOrchestrator.getTeamBySpace(spaceId)
      if (!team) {
        return { success: false, error: 'Team not found' }
      }
      return { success: true, data: { persistent: agentOrchestrator.isPersistentMode(team.id) } }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // ============================================
  // Permission Forwarding
  // ============================================

  /**
   * Resolve a worker's permission request (approve/deny from UI).
   */
  ipcMain.handle('hyper-space:resolve-permission', async (
    _event,
    spaceId: string,
    workerAgentId: string,
    requestId: string,
    approved: boolean
  ) => {
    try {
      // Handle locally (resolve the waiting promise)
      permissionForwarder.handleResponse({
        spaceId,
        respondingAgentId: 'user',
        requestId,
        approved
      })

      // Also post response to worker's mailbox (for remote workers)
      permissionForwarder.postResponse(spaceId, workerAgentId, requestId, approved)

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  console.log('[IPC] Hyper Space handlers registered')
}
