/**
 * Terminal Store - Shared terminal state for human-agent collaboration
 *
 * Features:
 * - Real-time command output streaming from Agent
 * - User command input that Agent can see
 * - Command history with source tracking (agent vs user)
 * - Per-conversation isolation (command history bound to conversationId)
 * - WebSocket connection management for remote terminals
 */

import { create } from 'zustand'
import { api } from '../api'

export interface TerminalCommand {
  id: string
  command: string
  output: string
  exitCode: number | null
  source: 'agent' | 'user'
  timestamp: string
  conversationId: string
  status: 'running' | 'completed' | 'error'
}

// Per-conversation terminal state
interface ConversationTerminalState {
  commands: TerminalCommand[]
  isConnected: boolean
}

export interface TerminalState {
  // Connection state
  isConnected: boolean
  isConnecting: boolean
  error: string | null

  // Current context
  currentSpaceId: string | null
  currentConversationId: string | null

  // Per-conversation terminal states
  conversationStates: Map<string, ConversationTerminalState>

  // UI state
  isVisible: boolean
  isExpanded: boolean
  autoScroll: boolean

  // Terminal output callback (for xterm.js)
  terminalOutputCallback: ((data: string) => void) | null

  // Actions
  connect: (spaceId: string, conversationId: string) => Promise<void>
  disconnect: () => void
  switchConversation: (conversationId: string) => void
  sendCommand: (command: string) => Promise<void>
  clearTerminal: () => void
  toggleVisibility: () => void
  toggleExpanded: () => void
  setAutoScroll: (enabled: boolean) => void
  setTerminalOutputCallback: (callback: ((data: string) => void) | null) => void

  // Internal event handlers (called by WebSocket listener)
  _onCommandStart: (cmd: Omit<TerminalCommand, 'output' | 'exitCode' | 'status'>) => void
  _onCommandOutput: (commandId: string, output: string, isStream: boolean) => void
  _onCommandComplete: (commandId: string, exitCode: number) => void
  _onCommandError: (commandId: string, error: string) => void
  _loadHistory: (commands: TerminalCommand[]) => void
}

// Global WebSocket connection (shared across components)
let terminalWebSocket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let currentContext: { spaceId: string; conversationId: string } | null = null

const RECONNECT_DELAY = 3000
const MAX_RECONNECT_ATTEMPTS = 5

export const useTerminalStore = create<TerminalState>((set, get) => ({
  // Initial state
  isConnected: false,
  isConnecting: false,
  error: null,
  currentSpaceId: null,
  currentConversationId: null,
  conversationStates: new Map(),
  isVisible: false,
  isExpanded: true,
  autoScroll: true,
  terminalOutputCallback: null,

  connect: async (spaceId: string, conversationId: string) => {
    set({ isConnecting: true, error: null, currentSpaceId: spaceId, currentConversationId: conversationId })
    currentContext = { spaceId, conversationId }

    try {
      // Get WebSocket endpoint from backend
      const result = await api.getTerminalWebSocketUrl(spaceId, conversationId)

      if (!result.success || !result.data?.wsUrl) {
        throw new Error('Failed to get terminal WebSocket URL')
      }

      const wsUrl = result.data.wsUrl

      // Create WebSocket connection
      terminalWebSocket = new WebSocket(wsUrl)

      terminalWebSocket.onopen = () => {
        console.log('[TerminalStore] WebSocket connected')
        set({ isConnected: true, isConnecting: false, error: null })
      }

      terminalWebSocket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          handleTerminalMessage(message)
        } catch (error) {
          console.error('[TerminalStore] Failed to parse message:', error)
        }
      }

      terminalWebSocket.onclose = () => {
        console.log('[TerminalStore] WebSocket closed')
        set({ isConnected: false })

        // Attempt reconnect
        if (currentContext) {
          attemptReconnect(currentContext.spaceId, currentContext.conversationId)
        }
      }

      terminalWebSocket.onerror = (error) => {
        console.error('[TerminalStore] WebSocket error:', error)
        set({ error: 'Terminal connection error', isConnected: false })
      }

    } catch (error) {
      console.error('[TerminalStore] Connection failed:', error)
      set({
        error: error instanceof Error ? error.message : 'Connection failed',
        isConnecting: false
      })
    }
  },

  disconnect: () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    if (terminalWebSocket) {
      terminalWebSocket.close()
      terminalWebSocket = null
    }

    set({
      isConnected: false,
      isConnecting: false,
      currentSpaceId: null,
      currentConversationId: null
    })
    currentContext = null
  },

  // Switch to a different conversation's terminal state
  switchConversation: (conversationId: string) => {
    set(state => {
      // Get or create state for new conversation
      let convState = state.conversationStates.get(conversationId)
      if (!convState) {
        convState = { commands: [], isConnected: false }
        const newMap = new Map(state.conversationStates)
        newMap.set(conversationId, convState)
        return { currentConversationId: conversationId, conversationStates: newMap }
      }
      return { currentConversationId: conversationId }
    })
  },

  sendCommand: async (command: string) => {
    const { isConnected } = get()

    if (!isConnected || !terminalWebSocket) {
      throw new Error('Terminal not connected')
    }

    // Send command to backend
    terminalWebSocket.send(JSON.stringify({
      type: 'terminal:user-command',
      data: { command }
    }))

    // Add to local command list (output will come via streaming)
    const commandId = `user-${Date.now()}`
    const { currentConversationId } = get()
    get()._onCommandStart({
      id: commandId,
      command,
      source: 'user',
      timestamp: new Date().toISOString(),
      conversationId: currentConversationId || ''
    })
  },

  clearTerminal: () => {
    const { currentConversationId } = get()
    if (currentConversationId) {
      set(state => {
        const newMap = new Map(state.conversationStates)
        const convState = newMap.get(currentConversationId)
        if (convState) {
          convState.commands = []
          newMap.set(currentConversationId, convState)
        }
        return { conversationStates: newMap }
      })
    }
  },

  toggleVisibility: () => {
    set(state => ({ isVisible: !state.isVisible }))
  },

  toggleExpanded: () => {
    set(state => ({ isExpanded: !state.isExpanded }))
  },

  setAutoScroll: (enabled: boolean) => {
    set({ autoScroll: enabled })
  },

  setTerminalOutputCallback: (callback) => {
    set({ terminalOutputCallback: callback })
  },

  // Internal event handlers
  _onCommandStart: (cmd) => {
    set(state => {
      const newMap = new Map(state.conversationStates)
      let convState = newMap.get(cmd.conversationId)

      if (!convState) {
        convState = { commands: [], isConnected: false }
        newMap.set(cmd.conversationId, convState)
      }

      convState.commands = [...convState.commands, {
        ...cmd,
        output: '',
        exitCode: null,
        status: 'running'
      }]
      convState.isConnected = true

      return { conversationStates: newMap }
    })
  },

  _onCommandOutput: (commandId: string, output: string, isStream: boolean) => {
    set(state => {
      const newMap = new Map(state.conversationStates)

      // Find and update command in any conversation
      for (const [convId, convState] of newMap.entries()) {
        const updatedCommands = convState.commands.map(cmd =>
          cmd.id === commandId
            ? { ...cmd, output: cmd.output + output }
            : cmd
        )
        if (updatedCommands !== convState.commands) {
          convState.commands = updatedCommands
          newMap.set(convId, convState)
          break
        }
      }

      return { conversationStates: newMap }
    })
  },

  _onCommandComplete: (commandId: string, exitCode: number) => {
    set(state => {
      const newMap = new Map(state.conversationStates)

      // Find and update command in any conversation
      for (const [convId, convState] of newMap.entries()) {
        const updatedCommands = convState.commands.map(cmd =>
          cmd.id === commandId
            ? { ...cmd, status: 'completed' as const, exitCode }
            : cmd
        )
        if (updatedCommands !== convState.commands) {
          convState.commands = updatedCommands
          newMap.set(convId, convState)
          break
        }
      }

      return { conversationStates: newMap }
    })
  },

  _onCommandError: (commandId: string, error: string) => {
    set(state => {
      const newMap = new Map(state.conversationStates)

      // Find and update command in any conversation
      for (const [convId, convState] of newMap.entries()) {
        const updatedCommands = convState.commands.map(cmd =>
          cmd.id === commandId
            ? { ...cmd, status: 'error' as const, output: cmd.output + '\n' + error }
            : cmd
        )
        if (updatedCommands !== convState.commands) {
          convState.commands = updatedCommands
          newMap.set(convId, convState)
          break
        }
      }

      return { conversationStates: newMap }
    })
  },

  _loadHistory: (commands: TerminalCommand[]) => {
    const { currentConversationId } = get()
    if (!currentConversationId) return

    set(state => {
      const newMap = new Map(state.conversationStates)
      newMap.set(currentConversationId, {
        commands,
        isConnected: state.isConnected
      })
      return { conversationStates: newMap }
    })
  }
}))

// Handle incoming WebSocket messages
function handleTerminalMessage(message: {
  type: string
  data: any
}) {
  const store = useTerminalStore.getState()

  switch (message.type) {
    case 'terminal:agent-command-start':
      store._onCommandStart({
        id: message.data.id,
        command: message.data.command,
        source: 'agent',
        timestamp: message.data.timestamp,
        conversationId: message.data.conversationId
      })
      break

    case 'terminal:agent-command-output':
      store._onCommandOutput(
        message.data.commandId,
        message.data.output,
        message.data.isStream ?? true
      )
      break

    case 'terminal:agent-command-complete':
      store._onCommandComplete(message.data.commandId, message.data.exitCode)
      break

    case 'terminal:agent-command-error':
      store._onCommandError(message.data.commandId, message.data.error)
      break

    case 'terminal:user-command':
      // User command from terminal - already added to local store when sent
      // This is an acknowledgment from backend that the command was received
      console.log('[TerminalStore] User command acknowledged:', message.data.command)
      store._onCommandOutput(message.data.commandId, '\n[Command sent to terminal...]', false)
      break

    case 'terminal:data':
      // Real terminal data from PTY/SSH session
      // Write directly to xterm.js
      if (store.terminalOutputCallback) {
        store.terminalOutputCallback(message.data.content)
      }
      break

    case 'terminal:history':
      // Load command history for current conversation
      store._loadHistory(message.data.commands || [])
      break

    case 'terminal:context-update':
      // Agent has acknowledged user's command - could trigger UI notification
      console.log('[TerminalStore] Agent acknowledged user command:', message.data)
      break

    case 'terminal:connected':
      console.log('[TerminalStore] Connected to terminal gateway:', message.data)
      break

    case 'terminal:ready':
      // Terminal session is ready for input
      console.log('[TerminalStore] Terminal session ready')
      set({ isConnected: true })
      break

    case 'terminal:exit':
      // Terminal session exited
      console.log('[TerminalStore] Terminal session exited:', message.data)
      set({ isConnected: false })
      break

    case 'terminal:error':
      // Terminal session error
      console.error('[TerminalStore] Terminal session error:', message.data)
      set({ error: message.data.error, isConnected: false })
      break
  }
}

// Attempt to reconnect
function attemptReconnect(spaceId: string, conversationId: string) {
  const store = useTerminalStore.getState()

  if (!store.isVisible) {
    // Don't reconnect if terminal is hidden
    return
  }

  let attempts = 0

  const tryReconnect = () => {
    attempts++

    if (attempts > MAX_RECONNECT_ATTEMPTS) {
      console.error('[TerminalStore] Max reconnection attempts reached')
      set({ error: 'Failed to reconnect' })
      return
    }

    console.log(`[TerminalStore] Reconnecting (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS})...`)
    store.connect(spaceId, conversationId)
  }

  reconnectTimer = setTimeout(tryReconnect, RECONNECT_DELAY)
}

// Export helper for getting current conversation context
export function getCurrentTerminalContext() {
  return currentContext
}
