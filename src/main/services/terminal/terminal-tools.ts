/**
 * Terminal Tools - MCP Tools for Agent to query terminal output
 *
 * Tools:
 * - get_terminal_output: Get recent N lines from user's terminal
 * - get_command_history: Get list of commands executed by user
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { sharedTerminalService } from './shared-terminal-service'

/**
 * Resolve a terminal session from tool parameters.
 * Tries by conversationId suffix first, then falls back to the most recent session.
 */
function resolveSession(conversationId?: string) {
  if (conversationId) {
    // sessionId format is "${spaceId}:${conversationId}"
    const session = sharedTerminalService.getSessionByConversationId(conversationId)
    if (session) return session
  }

  // Fallback: return the most recently created session
  const sessionIds = sharedTerminalService.getSessionIds()
  if (sessionIds.length === 0) return undefined
  const lastId = sessionIds[sessionIds.length - 1]
  return sharedTerminalService.getSession(lastId)
}

/**
 * Register terminal-related MCP tools
 */
export function registerTerminalTools(server: McpServer): void {
  /**
   * Get recent terminal output lines
   * Agent can use this to see what the user has been doing
   */
  server.tool(
    'get_terminal_output',
    'Get recent output from the shared terminal (user commands and output)',
    {
      lines: z.number().optional().default(50).describe('Number of lines to retrieve (default: 50)'),
      conversationId: z.string().optional().describe('Conversation ID (defaults to current)')
    },
    async ({ lines, conversationId }) => {
      try {
        const session = resolveSession(conversationId)

        if (!session) {
          return {
            content: [{ type: 'text', text: 'No active terminal session found' }],
            isError: true
          }
        }

        const outputLines = session.getRecentOutput(lines)

        if (outputLines.length === 0) {
          return {
            content: [{ type: 'text', text: 'Terminal output buffer is empty' }]
          }
        }

        // Format output for display
        const formatted = outputLines
          .map(line => {
            const prefix = line.source === 'user-command' ? '$ ' :
                          line.source === 'agent-command' ? '[AGENT] $ ' :
                          line.source === 'agent-output' ? '  [AGENT] ' : '  '
            return `${prefix}${line.content}`
          })
          .join('\n')

        return {
          content: [
            {
              type: 'text',
              text: `Terminal Output (last ${lines} lines):\n\n${formatted}`
            }
          ]
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error getting terminal output: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        }
      }
    }
  )

  /**
   * Get command history
   * Returns list of commands executed in the terminal
   */
  server.tool(
    'get_command_history',
    'Get list of commands executed in the terminal (both user and agent)',
    {
      source: z.enum(['all', 'user', 'agent']).optional().default('all').describe('Filter by command source'),
      limit: z.number().optional().default(20).describe('Maximum number of commands to return'),
      conversationId: z.string().optional().describe('Conversation ID to filter by')
    },
    async ({ source, limit, conversationId }) => {
      try {
        const session = resolveSession(conversationId)

        if (!session) {
          return {
            content: [{ type: 'text', text: 'No terminal sessions found' }]
          }
        }

        let commands = session.getCommandHistory()

        // Filter by source
        if (source !== 'all') {
          commands = commands.filter(cmd => cmd.source === source)
        }

        // Limit results
        commands = commands.slice(-limit)

        if (commands.length === 0) {
          return {
            content: [{ type: 'text', text: 'No commands in history' }]
          }
        }

        // Format for display
        const formatted = commands
          .map(cmd => {
            const icon = cmd.source === 'user' ? '👤' : '🤖'
            const status = cmd.status === 'completed' ? '✓' : cmd.status === 'error' ? '✗' : '○'
            return `${icon} ${status} ${cmd.command}${cmd.exitCode !== null ? ` (exit: ${cmd.exitCode})` : ''}`
          })
          .join('\n')

        return {
          content: [
            {
              type: 'text',
              text: `Command History (${commands.length} commands):\n\n${formatted}`
            }
          ]
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error getting command history: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        }
      }
    }
  )

  /**
   * Clear terminal output
   * Clear the terminal output buffer for a specific session
   */
  server.tool(
    'clear_terminal',
    'Clear the terminal output buffer (does not affect the actual terminal session)',
    {
      conversationId: z.string().optional().describe('Conversation ID (defaults to most recent session)')
    },
    async ({ conversationId }) => {
      try {
        if (conversationId) {
          // Clear specific session
          const session = sharedTerminalService.getSessionByConversationId(conversationId)
          if (session) {
            session.clearBuffer()
          }
        } else {
          // Clear all sessions (original behavior preserved for backward compat)
          for (const sessionId of sharedTerminalService.getSessionIds()) {
            const session = sharedTerminalService.getSession(sessionId)
            session?.clearBuffer()
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: 'Terminal output buffer cleared'
            }
          ]
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error clearing terminal: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        }
      }
    }
  )
}
