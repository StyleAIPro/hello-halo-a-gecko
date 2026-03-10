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
        // Get the terminal session for current conversation
        // Note: In production, you'd need to resolve the correct sessionId
        const sessionId = conversationId ? `session:${conversationId}` : 'current'
        const session = sharedTerminalService.getSession(sessionId)

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
      limit: z.number().optional().default(20).describe('Maximum number of commands to return')
    },
    async ({ source, limit }) => {
      try {
        // Get the most recent session
        const sessions = Array.from(sharedTerminalService['sessions'].values())
        const session = sessions[sessions.length - 1]

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
   * Clear the terminal output buffer
   */
  server.tool(
    'clear_terminal',
    'Clear the terminal output buffer (does not affect the actual terminal session)',
    {},
    async () => {
      try {
        const sessions = Array.from(sharedTerminalService['sessions'].values())

        for (const session of sessions) {
          session.clearBuffer()
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
