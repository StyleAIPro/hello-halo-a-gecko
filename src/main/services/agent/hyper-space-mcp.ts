/**
 * Hyper Space MCP Server
 *
 * Provides tools for multi-agent collaboration in Hyper Spaces.
 * Inspired by OpenClaw's subagent system.
 *
 * Tools:
 * - spawn_subagent: Create a subagent task for parallel execution
 * - announce_completion: Signal task completion to parent agent
 */

import { z } from 'zod'
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { agentOrchestrator } from './orchestrator'
import type { AgentConfig, SubagentAnnouncement } from '../../../shared/types/hyper-space'

// ============================================
// Helpers
// ============================================

/** Build a standard text content response. */
function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {})
  }
}

// ============================================
// Tool Factories
// ============================================

function buildTools(spaceId: string, conversationId: string) {
  /**
   * spawn_subagent tool
   *
   * Allows an agent to spawn a subagent task for parallel execution.
   * The subagent will be routed to an appropriate worker based on capabilities.
   */
  const spawn_subagent = tool(
    'spawn_subagent',
    'Spawn a subagent task for parallel execution in a Hyper Space. ' +
    'The task will be routed to an appropriate worker agent based on capabilities. ' +
    'Use this to distribute work across multiple agents for faster completion. ' +
    'Returns a task ID that can be used to check status and retrieve results.',
    {
      task: z.string().describe('The task description for the subagent to execute'),
      capabilities: z.array(z.string()).optional().describe(
        'Required capabilities for the subagent (e.g., ["code", "testing"]). ' +
        'Used to route to appropriate worker.'
      ),
      priority: z.enum(['low', 'normal', 'high']).optional().describe(
        'Task priority (default: normal)'
      ),
      announceOnComplete: z.boolean().optional().describe(
        'Whether to announce completion automatically (default: true)'
      )
    },
    async (params: {
      task: string
      capabilities?: string[]
      priority?: 'low' | 'normal' | 'high'
      announceOnComplete?: boolean
    }) => {
      try {
        const team = agentOrchestrator.getTeamBySpace(spaceId)
        if (!team) {
          return textResult(
            'No Hyper Space team found. spawn_subagent can only be used in Hyper Spaces.',
            true
          )
        }

        // Dispatch the task
        const tasks = await agentOrchestrator.dispatchTask({
          teamId: team.id,
          task: params.task,
          conversationId
        })

        if (tasks.length === 0) {
          return textResult('No available workers to handle the task.', true)
        }

        const task = tasks[0]

        // Start execution in background
        agentOrchestrator.executeAllTasks(team.id).catch(err => {
          console.error(`[HyperSpaceMcp] Task execution error:`, err)
        })

        return textResult(
          `Subagent task spawned successfully.\n\n` +
          `Task ID: ${task.id}\n` +
          `Agent: ${task.agentId}\n` +
          `Status: ${task.status}\n\n` +
          `Use check_subagent_status with task ID "${task.id}" to check progress and get results.`
        )
      } catch (e) {
        return textResult(`Error spawning subagent: ${(e as Error).message}`, true)
      }
    }
  )

  /**
   * check_subagent_status tool
   *
   * Check the status of a spawned subagent task.
   */
  const check_subagent_status = tool(
    'check_subagent_status',
    'Check the status of a spawned subagent task. ' +
    'Returns current status (pending/running/completed/failed) and results if completed.',
    {
      taskId: z.string().describe('The task ID returned by spawn_subagent')
    },
    async (params: { taskId: string }) => {
      try {
        const task = agentOrchestrator.getTask(params.taskId)
        if (!task) {
          return textResult(`Task ${params.taskId} not found.`, true)
        }

        let result = `Task Status: ${task.status}\n` +
          `Task ID: ${task.id}\n` +
          `Agent: ${task.agentId}\n` +
          `Started: ${new Date(task.startedAt).toISOString()}`

        if (task.status === 'completed' && task.result) {
          result += `\n\nResult:\n${task.result}`
        } else if (task.status === 'failed' && task.error) {
          result += `\n\nError: ${task.error}`
        }

        return textResult(result)
      } catch (e) {
        return textResult(`Error checking task status: ${(e as Error).message}`, true)
      }
    }
  )

  /**
   * announce_completion tool
   *
   * Signal task completion to parent agent.
   * Used by subagents to announce their results.
   */
  const announce_completion = tool(
    'announce_completion',
    'Signal task completion to the parent agent in a Hyper Space. ' +
    'Use this when you have finished your assigned task and want to report results. ' +
    'This triggers the announcement system and marks the task as complete.',
    {
      taskId: z.string().describe('Your assigned task ID'),
      status: z.enum(['completed', 'failed']).describe('Task completion status'),
      result: z.string().optional().describe('Task result or output (for completed tasks)'),
      error: z.string().optional().describe('Error message (for failed tasks)'),
      summary: z.string().optional().describe('Brief summary of the result (max 200 chars)')
    },
    async (params: {
      taskId: string
      status: 'completed' | 'failed'
      result?: string
      error?: string
      summary?: string
    }) => {
      try {
        const task = agentOrchestrator.getTask(params.taskId)
        if (!task) {
          return textResult(`Task ${params.taskId} not found.`, true)
        }

        // Create and send announcement
        const announcement: SubagentAnnouncement = {
          type: 'agent:announce',
          taskId: params.taskId,
          agentId: task.agentId,
          status: params.status,
          result: params.result,
          summary: params.summary || (params.result ? params.result.substring(0, 200) : undefined),
          timestamp: Date.now()
        }

        agentOrchestrator.sendAnnouncement(announcement)

        return textResult(
          `Announcement sent successfully.\n` +
          `Task ${params.taskId} marked as ${params.status}.`
        )
      } catch (e) {
        return textResult(`Error sending announcement: ${(e as Error).message}`, true)
      }
    }
  )

  /**
   * list_team_members tool
   *
   * List all agents in the current Hyper Space team.
   */
  const list_team_members = tool(
    'list_team_members',
    'List all agents (leader and workers) in the current Hyper Space team. ' +
    'Shows their status, capabilities, and current tasks.',
    {},
    async () => {
      try {
        const team = agentOrchestrator.getTeamBySpace(spaceId)
        if (!team) {
          return textResult(
            'No Hyper Space team found. This tool can only be used in Hyper Spaces.',
            true
          )
        }

        const status = agentOrchestrator.getTeamStatus(team.id)
        if (!status) {
          return textResult('Failed to get team status.', true)
        }

        let result = '## Hyper Space Team\n\n'
        result += `Team Status: ${status.status}\n\n`

        result += `### Leader\n`
        result += `- ID: ${status.leader.id}\n`
        result += `- Status: ${status.leader.status}\n\n`

        result += `### Workers\n`
        if (status.workers.length === 0) {
          result += 'No workers in team.\n'
        } else {
          for (const worker of status.workers) {
            result += `- ID: ${worker.id}\n`
            result += `  - Status: ${worker.status}\n`
            if (worker.currentTaskId) {
              result += `  - Current Task: ${worker.currentTaskId}\n`
            }
          }
        }

        result += `\nPending Tasks: ${status.pendingTasks}\n`

        return textResult(result)
      } catch (e) {
        return textResult(`Error listing team members: ${(e as Error).message}`, true)
      }
    }
  )

  /**
   * wait_for_team tool
   *
   * Wait for all pending tasks in the team to complete.
   */
  const wait_for_team = tool(
    'wait_for_team',
    'Wait for all pending tasks in the Hyper Space team to complete. ' +
    'Returns aggregated results from all completed tasks. ' +
    'Use this to coordinate multi-agent work.',
    {
      timeout: z.number().optional().describe('Timeout in milliseconds (default: 300000 = 5 min)'),
      aggregationStrategy: z.enum(['concat', 'summarize', 'vote']).optional().describe(
        'How to aggregate results (default: summarize)'
      )
    },
    async (params: {
      timeout?: number
      aggregationStrategy?: 'concat' | 'summarize' | 'vote'
    }) => {
      try {
        const team = agentOrchestrator.getTeamBySpace(spaceId)
        if (!team) {
          return textResult(
            'No Hyper Space team found. This tool can only be used in Hyper Spaces.',
            true
          )
        }

        // Wait for completion
        const tasks = await agentOrchestrator.waitForCompletion({
          conversationId,
          timeout: params.timeout || 300000
        })

        // Aggregate results
        const strategy = params.aggregationStrategy || 'summarize'
        const aggregated = agentOrchestrator.aggregateResults(tasks, strategy)

        return textResult(
          `## Team Tasks Completed\n\n` +
          `Total tasks: ${tasks.length}\n` +
          `Completed: ${tasks.filter(t => t.status === 'completed').length}\n` +
          `Failed: ${tasks.filter(t => t.status === 'failed').length}\n\n` +
          `### Aggregated Results (${strategy})\n\n` +
          aggregated
        )
      } catch (e) {
        return textResult(`Error waiting for team: ${(e as Error).message}`, true)
      }
    }
  )

  return [
    spawn_subagent,
    check_subagent_status,
    announce_completion,
    list_team_members,
    wait_for_team
  ]
}

// ============================================
// Export SDK MCP Server
// ============================================

/**
 * Create Hyper Space SDK MCP Server.
 * Provides tools for multi-agent collaboration.
 *
 * @param spaceId - The current space ID
 * @param conversationId - The current conversation ID
 */
export function createHyperSpaceMcpServer(spaceId: string, conversationId: string) {
  const allTools = buildTools(spaceId, conversationId)

  return createSdkMcpServer({
    name: 'hyper-space',
    version: '1.0.0',
    tools: allTools
  })
}
