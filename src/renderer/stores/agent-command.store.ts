/**
 * Agent Command Viewer Store - 管理 Agent 命令显示区
 *
 * 功能：
 * - 只读显示 Agent 执行的命令和输出
 * - 使用 xterm.js 渲染真实 Terminal 样式
 * - 支持滑动查看历史命令
 * - 按会话隔离命令历史（conversationId 绑定）
 * - 持久化到磁盘，随会话保存和恢复
 */

import { create } from 'zustand'
import { api } from '../api'

export interface AgentCommandEntry {
  id: string
  command: string
  output: string
  exitCode: number | null
  status: 'pending' | 'running' | 'completed' | 'error'
  timestamp: string
  conversationId: string
  cwd?: string  // Current working directory for prompt display
  cwdLabel?: string  // Full prompt like "user@host path %"
  pathOnly?: string  // Just the last path component
}

export interface AgentCommandViewerState {
  // 按会话存储命令历史：Map<conversationId, AgentCommandEntry[]>
  commandHistory: Map<string, AgentCommandEntry[]>

  // 当前活跃的命令（正在执行）
  activeCommandId: string | null

  // 连接状态
  isConnected: boolean
  currentConversationId: string | null

  // UI 状态
  autoScroll: boolean
  maxDisplayCommands: number

  // 已加载的会话（避免重复加载）
  loadedConversations: Set<string>

  // Actions
  addCommand: (spaceId: string, conversationId: string, command: string) => void
  updateCommandOutput: (commandId: string, output: string, isComplete: boolean, exitCode?: number) => void
  clearCommands: (conversationId?: string) => void
  getCommandsForConversation: (conversationId: string) => AgentCommandEntry[]
  setAutoScroll: (enabled: boolean) => void
  loadCommandsForConversation: (spaceId: string, conversationId: string, forceReload?: boolean) => Promise<void>
  exportToMarkdown: (conversationId: string, spaceId: string) => Promise<void>

  // 内部方法（由 WebSocket 调用）
  _onAgentCommandStart: (entry: Omit<AgentCommandEntry, 'output' | 'exitCode' | 'status'>) => void
  _onAgentCommandOutput: (commandId: string, output: string) => void
  _onAgentCommandComplete: (commandId: string, exitCode: number) => void
  _onAgentCommandError: (commandId: string, error: string) => void
  _loadCommands: (conversationId: string, commands: AgentCommandEntry[]) => void
}

export const useAgentCommandViewerStore = create<AgentCommandViewerState>((set, get) => ({
  // Initial state
  commandHistory: new Map(),
  activeCommandId: null,
  isConnected: false,
  currentConversationId: null,
  autoScroll: true,
  maxDisplayCommands: 100,
  loadedConversations: new Set<string>(),

  // Actions
  addCommand: (spaceId: string, conversationId: string, command: string) => {
    const commandId = `agent-cmd-${Date.now()}-${Math.random().toString(36).substring(7)}`

    get()._onAgentCommandStart({
      id: commandId,
      command,
      timestamp: new Date().toISOString(),
      conversationId
    })
  },

  updateCommandOutput: (commandId: string, output: string, isComplete: boolean, exitCode?: number) => {
    if (isComplete) {
      get()._onAgentCommandComplete(commandId, exitCode ?? 0)
    } else {
      get()._onAgentCommandOutput(commandId, output)
    }
  },

  clearCommands: (conversationId) => {
    if (conversationId) {
      set(state => {
        const newHistory = new Map(state.commandHistory)
        newHistory.delete(conversationId)
        const newLoaded = new Set(state.loadedConversations)
        newLoaded.delete(conversationId)
        return { commandHistory: newHistory, loadedConversations: newLoaded }
      })
    } else {
      set({ commandHistory: new Map(), activeCommandId: null, loadedConversations: new Set() })
    }
  },

  getCommandsForConversation: (conversationId: string) => {
    const state = get()
    return state.commandHistory.get(conversationId) || []
  },

  setAutoScroll: (enabled: boolean) => {
    set({ autoScroll: enabled })
  },

  loadCommandsForConversation: async (spaceId: string, conversationId: string, forceReload = false) => {
    const state = get()

    // Skip if already loaded (unless force reload is requested)
    if (!forceReload && state.loadedConversations.has(conversationId)) {
      console.log(`[AgentCommandStore] Commands already loaded for ${conversationId}`)
      return
    }

    try {
      console.log(`[AgentCommandStore] Loading commands for ${conversationId}...`)
      const result = await api.getAgentCommands(spaceId, conversationId)

      if (result.success && result.data) {
        const commands = result.data as AgentCommandEntry[]
        console.log(`[AgentCommandStore] Loaded ${commands.length} commands for ${conversationId}`)
        get()._loadCommands(conversationId, commands)
      } else {
        console.log(`[AgentCommandStore] No commands found for ${conversationId}`)
      }
    } catch (error) {
      console.error(`[AgentCommandStore] Failed to load commands for ${conversationId}:`, error)
    }
  },

  // Internal handlers
  _onAgentCommandStart: (entry) => {
    set(state => {
      const newHistory = new Map(state.commandHistory)
      const convCommands = newHistory.get(entry.conversationId) || []

      const newCommand: AgentCommandEntry = {
        ...entry,
        output: '',
        exitCode: null,
        status: 'running'
      }

      newHistory.set(entry.conversationId, [...convCommands, newCommand])

      return {
        commandHistory: newHistory,
        activeCommandId: entry.id,
        currentConversationId: entry.conversationId,
        isConnected: true
      }
    })
  },

  _onAgentCommandOutput: (commandId: string, output: string) => {
    set(state => {
      const newHistory = new Map(state.commandHistory)

      // Find and update the command in any conversation
      for (const [convId, commands] of newHistory.entries()) {
        const commandIndex = commands.findIndex(cmd => cmd.id === commandId)
        if (commandIndex >= 0) {
          const updatedCommands = [...commands]
          updatedCommands[commandIndex] = {
            ...updatedCommands[commandIndex],
            output: updatedCommands[commandIndex].output + output
          }
          newHistory.set(convId, updatedCommands)
          break
        }
      }

      return { commandHistory: newHistory }
    })
  },

  _onAgentCommandComplete: (commandId: string, exitCode: number) => {
    set(state => {
      const newHistory = new Map(state.commandHistory)

      // Find and update the command in any conversation
      for (const [convId, commands] of newHistory.entries()) {
        const commandIndex = commands.findIndex(cmd => cmd.id === commandId)
        if (commandIndex >= 0) {
          const updatedCommands = [...commands]
          updatedCommands[commandIndex] = {
            ...updatedCommands[commandIndex],
            status: 'completed' as const,
            exitCode
          }
          newHistory.set(convId, updatedCommands)
          break
        }
      }

      return { commandHistory: newHistory, activeCommandId: null }
    })
  },

  _onAgentCommandError: (commandId: string, error: string) => {
    set(state => {
      const newHistory = new Map(state.commandHistory)

      // Find and update the command in any conversation
      for (const [convId, commands] of newHistory.entries()) {
        const commandIndex = commands.findIndex(cmd => cmd.id === commandId)
        if (commandIndex >= 0) {
          const updatedCommands = [...commands]
          updatedCommands[commandIndex] = {
            ...updatedCommands[commandIndex],
            status: 'error' as const,
            output: updatedCommands[commandIndex].output + '\n' + error
          }
          newHistory.set(convId, updatedCommands)
          break
        }
      }

      return { commandHistory: newHistory, activeCommandId: null }
    })
  },

  _loadCommands: (conversationId: string, commands: AgentCommandEntry[]) => {
    set(state => {
      const newHistory = new Map(state.commandHistory)
      const newLoaded = new Set(state.loadedConversations)

      // Check if we already have commands in memory for this conversation
      const existingCommands = newHistory.get(conversationId)

      if (!existingCommands || existingCommands.length === 0) {
        // No existing commands - use loaded commands directly
        newHistory.set(conversationId, commands)
      } else {
        // Merge: use loaded commands as base, but preserve any in-memory updates
        // (e.g., commands that are still running or have more recent output)
        const loadedIds = new Set(commands.map(c => c.id))
        const mergedCommands = [...commands]

        // Add any in-memory commands that aren't in the loaded set
        // (these are new commands added after the last save)
        for (const cmd of existingCommands) {
          if (!loadedIds.has(cmd.id)) {
            mergedCommands.push(cmd)
          }
        }

        // Sort by timestamp to maintain order
        mergedCommands.sort((a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        )

        newHistory.set(conversationId, mergedCommands)
      }
      newLoaded.add(conversationId)

      return { commandHistory: newHistory, loadedConversations: newLoaded }
    })
  },

  exportToMarkdown: async (conversationId: string, spaceId: string) => {
    const state = get()
    const commands = state.commandHistory.get(conversationId) || []

    if (commands.length === 0) {
      console.log('[AgentCommandStore] No commands to export')
      return
    }

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
    const fileName = `agent-commands-${conversationId.slice(0, 8)}-${timestamp}.md`

    // Generate Markdown content
    const markdownParts: string[] = []

    // Header
    markdownParts.push('# Agent Terminal Command History')
    markdownParts.push('')
    markdownParts.push(`Exported at: ${new Date().toISOString()}`)
    markdownParts.push(`Conversation ID: ${conversationId}`)
    markdownParts.push(`Total Commands: ${commands.length}`)
    markdownParts.push('')
    markdownParts.push('---')
    markdownParts.push('')

    // Commands
    commands.forEach((cmd, index) => {
      const statusEmoji = cmd.status === 'completed' && cmd.exitCode === 0 ? '✅' :
                         cmd.status === 'completed' && cmd.exitCode !== 0 ? '❌' :
                         cmd.status === 'error' ? '⚠️' : '⏳'

      markdownParts.push(`## Command ${index + 1} ${statusEmoji}`)
      markdownParts.push('')
      markdownParts.push(`**Time:** ${new Date(cmd.timestamp).toLocaleString()}`)
      markdownParts.push('')
      markdownParts.push(`**Status:** ${cmd.status}${cmd.exitCode !== null ? ` (Exit Code: ${cmd.exitCode})` : ''}`)
      markdownParts.push('')

      if (cmd.cwdLabel) {
        markdownParts.push(`**Directory:** ${cmd.cwdLabel}`)
        markdownParts.push('')
      }

      markdownParts.push('**Command:**')
      markdownParts.push('```bash')
      markdownParts.push(cmd.command)
      markdownParts.push('```')
      markdownParts.push('')

      if (cmd.output) {
        markdownParts.push('**Output:**')
        markdownParts.push('```')
        markdownParts.push(cmd.output)
        markdownParts.push('```')
        markdownParts.push('')
      }

      markdownParts.push('---')
      markdownParts.push('')
    })

    const markdownContent = markdownParts.join('\n')

    // Save to file using IPC
    try {
      const result = await window.aicoBot?.saveFile?.(spaceId, fileName, markdownContent)
      if (result?.success) {
        console.log(`[AgentCommandStore] Exported ${commands.length} commands to ${fileName}`)
        window.aicoBot?.showMessage?.('info', `Exported ${commands.length} commands to ${fileName}`)
      } else {
        // Fallback: download directly
        downloadMarkdown(markdownContent, fileName)
      }
    } catch (error) {
      console.error('[AgentCommandStore] Failed to export:', error)
      // Fallback: download directly
      downloadMarkdown(markdownContent, fileName)
    }
  }
}))

// Helper function to download markdown file
function downloadMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
