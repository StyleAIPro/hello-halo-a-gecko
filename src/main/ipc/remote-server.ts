/**
 * Remote Server IPC Handlers
 * Manages remote server configurations and deployments
 */

import { ipcMain, BrowserWindow } from 'electron'
import { RemoteDeployService, RemoteServerConfigInput } from '../services/remote-deploy'
import type { RemoteServer } from '../../shared/types'
import { getMainWindow, onMainWindowChange } from '../services/window.service'

const deployService = new RemoteDeployService()

let mainWindow: BrowserWindow | null = null

// Subscribe to window changes
onMainWindowChange((window) => {
  mainWindow = window
})

// Subscribe to status changes
deployService.onStatusChange((serverId, config) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('remote-server:status-change', {
      serverId,
      config,
    })
  }
})

// Subscribe to command output events
deployService.onCommandOutput((serverId, type, content) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('remote-server:command-output', {
      serverId,
      type,
      content,
      timestamp: Date.now(),
    })
  }
})

/**
 * Register IPC handlers for remote server and remote agent operations
 */
export function registerRemoteServerHandlers(): void {
  console.log('[IPC] Registering remote server handlers')

  // ===== Remote Server Handlers =====

  ipcMain.handle('remote-server:add', async (_event, input: RemoteServerConfigInput) => {
    console.log('[IPC] remote-server:add - Adding server:', input.name)
    console.log('[IPC] remote-server:add - Full input:', JSON.stringify(input))
    try {
      const id = await deployService.addServer(input)
      console.log('[IPC] remote-server:add - Added server ID:', id)
      return { success: true, data: { id } }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[IPC] remote-server:add - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('remote-server:list', async () => {
    try {
      const servers = deployService.getServers()
      return { success: true, data: servers }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[IPC] remote-server:list - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('remote-server:get', async (_event, id: string) => {
    try {
      const server = deployService.getServer(id)
      if (!server) {
        return { success: false, error: 'Server not found' }
      }
      return { success: true, data: server }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[IPC] remote-server:get - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(
    'remote-server:update',
    async (_event, id: string, updates: Partial<Omit<RemoteServer, 'id'>>) => {
      console.log('[IPC] remote-server:update - Updating server:', id)
      try {
        deployService.updateServer(id, updates)
        const server = deployService.getServer(id)
        return { success: true, data: server }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[IPC] remote-server:update - Failed:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  ipcMain.handle('remote-server:delete', async (_event, id: string) => {
    console.log('[IPC] remote-server:delete - Removing server:', id)
    try {
      deployService.removeServer(id)
      return { success: true }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[IPC] remote-server:delete - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('remote-server:deploy', async (_event, serverId: string) => {
    console.log('[IPC] remote-server:deploy - Deploying to server:', serverId)
    try {
      await deployService.deployToServer(serverId)
      const server = deployService.getServer(serverId)
      return { success: true, data: server }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[IPC] remote-server:deploy - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('remote-server:connect', async (_event, serverId: string) => {
    console.log('[IPC] remote-server:connect - Connecting to server:', serverId)
    try {
      await deployService.connectServer(serverId)
      const server = deployService.getServer(serverId)
      return { success: true, data: server }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[IPC] remote-server:connect - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('remote-server:disconnect', async (_event, serverId: string) => {
    console.log('[IPC] remote-server:disconnect - Disconnecting from server:', serverId)
    try {
      deployService.disconnectServer(serverId)
      const server = deployService.getServer(serverId)
      return { success: true, data: server }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[IPC] remote-server:disconnect - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(
    'remote-server:execute',
    async (_event, id: string, command: string) => {
      console.log('[IPC] remote-server:execute - Executing command on server:', id)
      try {
        const output = await deployService.executeCommand(id, command)
        return { success: true, data: { output } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[IPC] remote-server:execute - Failed:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // ===== Remote Agent Handlers =====

  ipcMain.handle('remote-agent:send-message', async (_event, serverId: string, message: any) => {
    console.log('[IPC] remote-agent:sendMessage - Sending message to agent:', serverId, message.type)
    try {
      const response = await deployService.sendAgentMessage(serverId, message)
      return { success: true, data: response }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[IPC] remote-agent:sendMessage - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(
    'remote-agent:fs-list',
    async (_event, serverId: string, directory?: string) => {
      const dir = directory || '/opt/remote-agent-proxy'
      console.log('[IPC] remote-agent:fs-list - Listing files:', dir)
      try {
        // Execute ls command via SSH
        const output = await deployService.executeCommand(serverId, `ls -la "${dir}"`)
        const lines = output.trim().split('\n').slice(1) // Skip total line
        const files = lines.map((line) => {
          const parts = line.trim().split(/\s+/)
          const name = parts[parts.length - 1]
          const isDir = line.startsWith('d')
          return {
            name,
            isDirectory: isDir,
            size: parseInt(parts[4] || '0', 10),
            modifiedTime: new Date(), // ls doesn't give full date in short format
          }
        }).filter((f) => f.name !== '.' && f.name !== '..')

        return { success: true, data: { files } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[IPC] remote-agent:fs-list - Failed:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  ipcMain.handle('remote-agent:fs-read', async (_event, serverId: string, path: string) => {
    console.log('[IPC] remote-agent:fs-read - Reading file:', path)
    try {
      const content = await deployService.executeCommand(serverId, `cat "${path}"`)
      return { success: true, data: { content } }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[IPC] remote-agent:fs-read - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(
    'remote-agent:fs-write',
    async (_event, serverId: string, path: string, content: string) => {
      console.log('[IPC] remote-agent:fs-write - Writing file:', path)
      try {
        // Escape single quotes in content
        const escapedContent = content.replace(/'/g, "'\\''")
        await deployService.executeCommand(
          serverId,
          `echo '${escapedContent}' > "${path}"`
        )
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[IPC] remote-agent:fs-write - Failed:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  ipcMain.handle('remote-agent:fs-delete', async (_event, serverId: string, path: string) => {
    console.log('[IPC] remote-agent:fs-delete - Deleting file:', path)
    try {
      await deployService.executeCommand(serverId, `rm -rf "${path}"`)
      return { success: true }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[IPC] remote-agent:fs-delete - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  console.log('[IPC] Remote server handlers registered')

  // Test connection handler
  ipcMain.handle('remote-server:test-connection', async (_event, serverId: string) => {
    console.log('[IPC] remote-server:test-connection - Testing connection:', serverId)
    try {
      const server = deployService.getServer(serverId)
      if (!server) {
        return { success: false, error: 'Server not found' }
      }
      if (server.status !== 'connected') {
        return { success: false, error: 'Server not connected' }
      }
      return { success: true, data: server }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[IPC] remote-server:test-connection - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('remote-agent:check-connection', async (_event, serverId: string) => {
    console.log('[IPC] remote-agent:check-connection - Checking connection:', serverId)
    try {
      // TODO: Implement actual connection check
      return { success: true, data: { connected: true } }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[IPC] remote-agent:check-connection - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  // Get messages handler
  ipcMain.handle('remote-agent:get-messages', async (_event, serverId: string, sessionId: string) => {
    console.log('[IPC] remote-agent:get-messages - Getting messages:', serverId, sessionId)
    try {
      // TODO: Implement message retrieval
      return { success: true, data: [] }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[IPC] remote-agent:get-messages - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })
}

// Check if claude-agent-sdk is installed on remote server
ipcMain.handle('remote-server:check-agent', async (_event, serverId: string) => {
  console.log('[IPC] remote-server:check-agent - Checking agent installation:', serverId)
  try {
    const result = await deployService.checkAgentInstalled(serverId)
    return { success: true, data: result }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[IPC] remote-server:check-agent - Failed:', err.message)
    return { success: false, error: err.message }
  }
})

// Deploy agent SDK to remote server via SCP
ipcMain.handle('remote-server:deploy-agent', async (_event, serverId: string) => {
  console.log('[IPC] remote-server:deploy-agent - Deploying agent SDK:', serverId)
  try {
    await deployService.deployAgentSDK(serverId)
    return { success: true, data: { message: 'Agent SDK deployment started' } }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[IPC] remote-server:deploy-agent - Failed:', err.message)
    return { success: false, error: err.message }
  }
})

// Start agent server on remote server
ipcMain.handle('remote-server:start-agent', async (_event, serverId: string) => {
  console.log('[IPC] remote-server:start-agent - Starting agent:', serverId)
  try {
    await deployService.startAgent(serverId)
    return { success: true, data: { message: 'Agent started successfully' } }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[IPC] remote-server:start-agent - Failed:', err.message)
    return { success: false, error: err.message }
  }
})

// Stop agent server on remote server
ipcMain.handle('remote-server:stop-agent', async (_event, serverId: string) => {
  console.log('[IPC] remote-server:stop-agent - Stopping agent:', serverId)
  try {
    await deployService.stopAgent(serverId)
    return { success: true, data: { message: 'Agent stopped successfully' } }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[IPC] remote-server:stop-agent - Failed:', err.message)
    return { success: false, error: err.message }
  }
})

// Get agent server logs
ipcMain.handle('remote-server:get-agent-logs', async (_event, serverId: string, lines: number = 100) => {
  console.log('[IPC] remote-server:get-agent-logs - Getting logs:', serverId)
  try {
    const logs = await deployService.getAgentLogs(serverId, lines)
    return { success: true, data: { logs } }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[IPC] remote-server:get-agent-logs - Failed:', err.message)
    return { success: false, error: err.message }
  }
})

// Check if agent server is running
ipcMain.handle('remote-server:is-agent-running', async (_event, serverId: string) => {
  console.log('[IPC] remote-server:is-agent-running - Checking status:', serverId)
  try {
    const running = await deployService.isAgentRunning(serverId)
    return { success: true, data: { running } }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[IPC] remote-server:is-agent-running - Failed:', err.message)
    return { success: false, error: err.message }
  }
})

export function getRemoteDeployService(): RemoteDeployService {
  return deployService
}