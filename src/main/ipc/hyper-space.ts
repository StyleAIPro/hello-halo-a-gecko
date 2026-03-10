/**
 * IPC Handlers for Hyper Space
 *
 * Handles IPC communication for multi-agent Hyper Space features
 */

import { ipcMain } from 'electron'
import { agentOrchestrator } from '../services/agent/orchestrator'
import type {
  AgentConfig,
  OrchestrationConfig,
  SubagentTask,
  CreateHyperSpaceInput
} from '../../shared/types/hyper-space'
import { createSpace, getSpace, updateSpace } from '../services/space.service'
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
      // Create the space with hyper type
      const space = createSpace({
        name: input.name,
        icon: input.icon,
        customPath: input.customPath,
        claudeSource: input.claudeSource || 'local',
        remoteServerId: input.remoteServerId,
        remotePath: input.remotePath,
        useSshTunnel: input.useSshTunnel
      })

      // If this is a hyper space, create the agent team
      if (input.spaceType === 'hyper' && input.agents && input.agents.length > 0) {
        const team = agentOrchestrator.createTeam({
          spaceId: space.id,
          conversationId: '', // Will be set when conversation starts
          agents: input.agents,
          config: input.orchestration
        })

        console.log(`[IPC] Created Hyper Space ${space.id} with team ${team.id}`)

        return {
          success: true,
          space: {
            ...space,
            spaceType: 'hyper',
            agents: input.agents,
            orchestration: input.orchestration
          }
        }
      }

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
      const team = agentOrchestrator.getTeamBySpace(params.spaceId)
      if (!team) {
        return { success: false, error: 'Hyper Space team not found' }
      }

      // Update team config
      team.config = {
        ...team.config,
        ...params.config,
        routing: { ...team.config.routing, ...params.config.routing },
        aggregation: { ...team.config.aggregation, ...params.config.aggregation },
        announce: { ...team.config.announce, ...params.config.announce }
      }

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
