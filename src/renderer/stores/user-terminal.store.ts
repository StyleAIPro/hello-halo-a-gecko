/**
 * User Terminal Store - 管理用户终端命令历史
 *
 * 功能：
 * - 记录用户在终端中执行的命令和输出
 * - 支持将命令历史追加到对话输入框
 */

import { create } from 'zustand'

export interface UserTerminalEntry {
  id: string
  command: string
  output: string
  timestamp: string
  conversationId: string
}

export interface UserTerminalState {
  // 按会话存储命令历史：Map<conversationId, UserTerminalEntry[]>
  commandHistory: Map<string, UserTerminalEntry[]>

  // 当前会话 ID
  currentConversationId: string | null

  // Actions
  addCommand: (conversationId: string, command: string, output: string) => void
  clearCommands: (conversationId?: string) => void
  getCommandsForConversation: (conversationId: string) => UserTerminalEntry[]
  getRecentCommands: (conversationId: string, limit?: number) => UserTerminalEntry[]
  setCurrentConversationId: (conversationId: string | null) => void

  // 获取格式化的命令文本（用于追加到输入框）
  getFormattedCommands: (conversationId: string, limit?: number) => string
}

export const useUserTerminalStore = create<UserTerminalState>((set, get) => ({
  commandHistory: new Map(),
  currentConversationId: null,

  addCommand: (conversationId: string, command: string, output: string) => {
    const entry: UserTerminalEntry = {
      id: `user-cmd-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      command,
      output,
      timestamp: new Date().toISOString(),
      conversationId
    }

    set(state => {
      const newHistory = new Map(state.commandHistory)
      const convCommands = newHistory.get(conversationId) || []
      newHistory.set(conversationId, [...convCommands, entry])
      return { commandHistory: newHistory }
    })
  },

  clearCommands: (conversationId) => {
    if (conversationId) {
      set(state => {
        const newHistory = new Map(state.commandHistory)
        newHistory.delete(conversationId)
        return { commandHistory: newHistory }
      })
    } else {
      set({ commandHistory: new Map() })
    }
  },

  getCommandsForConversation: (conversationId: string) => {
    const state = get()
    return state.commandHistory.get(conversationId) || []
  },

  getRecentCommands: (conversationId: string, limit = 10) => {
    const commands = get().getCommandsForConversation(conversationId)
    return commands.slice(-limit)
  },

  setCurrentConversationId: (conversationId: string | null) => {
    set({ currentConversationId: conversationId })
  },

  getFormattedCommands: (conversationId: string, limit?: number) => {
    const commands = limit
      ? get().getRecentCommands(conversationId, limit)
      : get().getCommandsForConversation(conversationId)

    if (commands.length === 0) {
      return ''
    }

    const parts: string[] = []
    parts.push('以下是我在终端中执行的命令和结果：')
    parts.push('')

    commands.forEach((cmd, index) => {
      parts.push(`### 命令 ${index + 1}`)
      parts.push('')
      parts.push('```bash')
      parts.push(cmd.command)
      parts.push('```')
      parts.push('')

      if (cmd.output) {
        parts.push('**输出:**')
        parts.push('```')
        parts.push(cmd.output)
        parts.push('```')
        parts.push('')
      }
    })

    return parts.join('\n')
  }
}))
