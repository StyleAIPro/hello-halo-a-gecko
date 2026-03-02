/**
 * Remote Deploy Service
 * Manages remote server configurations and deployments
 */

import { app } from 'electron'
import { SSHManager, SSHConfig } from '../remote-ssh/ssh-manager'
import { getConfig, saveConfig } from '../config.service'
import type { RemoteServer } from '../../../shared/types'
import * as fs from 'fs'
import path from 'path'

/**
 * Get the path to the remote-agent-proxy package
 * Works in both development and production modes
 */
function getRemoteAgentProxyPath(): string {
  // In development mode, use the project root
  // In production mode, use the app resources path
  if (app.isPackaged) {
    // Production: resources are in app.asar/packages or app/resources/packages
    return path.join(process.resourcesPath, 'packages', 'remote-agent-proxy')
  } else {
    // Development: use the project root
    // Use app.getAppPath() which returns the project root in dev mode
    const projectRoot = app.getAppPath()
    return path.join(projectRoot, 'packages', 'remote-agent-proxy')
  }
}

// Extended server config with runtime fields not persisted
export interface RemoteServerConfig extends RemoteServer {
  ssh: SSHConfig
  lastConnected?: Date
}

export interface RemoteServerConfigInput extends Omit<RemoteServerConfig, 'id' | 'status' | 'lastConnected'> {
  ssh: SSHConfig
}

const DEPLOY_AGENT_PATH = '/opt/claude-deployment'
const AGENT_CHECK_COMMAND = 'npm list -g @anthropic-ai/claude-agent-sdk'

// Agent package files to deploy
const AGENT_FILES = [
  { name: 'package.json', path: '../packages/remote-agent-proxy/package.json' },
  { name: 'index.js', path: '../packages/remote-agent-proxy/dist/index.js' },
  { name: 'index.js.map', path: '../packages/remote-agent-proxy/dist/index.js.map' },
  { name: 'server.js', path: '../packages/remote-agent-proxy/dist/server.js' },
  { name: 'server.js.map', path: '../packages/remote-agent-proxy/dist/server.js.map' },
  { name: 'claude-manager.js', path: '../packages/remote-agent-proxy/dist/claude-manager.js' },
  { name: 'claude-manager.js.map', path: '../packages/remote-agent-proxy/dist/claude-manager.js.map' },
  { name: 'types.js', path: '../packages/remote-agent-proxy/dist/types.js' },
  { name: 'types.js.map', path: '../packages/remote-agent-proxy/dist/types.js.map' }
]

export class RemoteDeployService {
  private servers: Map<string, RemoteServerConfig> = new Map()
  private sshManagers: Map<string, SSHManager> = new Map()
  private statusCallbacks: Set<(serverId: string, config: RemoteServer) => void> = new Set()
  private commandOutputCallbacks: Set<(serverId: string, type: 'command' | 'output' | 'error' | 'success', content: string) => void> = new Set()

  constructor() {
    this.loadServers()
  }

  /**
   * Subscribe to command output events
   */
  onCommandOutput(callback: (serverId: string, type: 'command' | 'output' | 'error' | 'success', content: string) => void): () => void {
    this.commandOutputCallbacks.add(callback)
    return () => this.commandOutputCallbacks.delete(callback)
  }

  /**
   * Emit command output event
   */
  private emitCommandOutput(serverId: string, type: 'command' | 'output' | 'error' | 'success', content: string): void {
    this.commandOutputCallbacks.forEach(callback => callback(serverId, type, content))
  }

  /**
   * Convert shared RemoteServer to internal RemoteServerConfig
   */
  private toInternalConfig(server: RemoteServer): RemoteServerConfig {
    return {
      ...server,
      status: server.status || 'disconnected',
      ssh: {
        host: server.host,
        port: server.sshPort,
        username: server.username,
        password: server.password,
      },
    }
  }

  /**
   * Convert internal RemoteServerConfig to shared RemoteServer
   */
  private toSharedConfig(config: RemoteServerConfig): RemoteServer {
    const { ssh, lastConnected, ...rest } = config

    // Safety check for ssh object
    if (!ssh) {
      console.error('[RemoteDeployService] toSharedConfig - ssh is undefined:', config)
      throw new Error('SSH configuration is missing')
    }

    return {
      ...rest,
      host: ssh.host,
      sshPort: ssh.port,
      username: ssh.username,
      password: ssh.password,
    }
  }

  /**
   * Load servers from config
   */
  private loadServers(): void {
    const config = getConfig()
    const servers = config.remoteServers || []

    for (const server of servers) {
      const internalConfig = this.toInternalConfig(server)
      this.servers.set(server.id, {
        ...internalConfig,
        status: 'disconnected',
      })
    }

    console.log(`[RemoteDeployService] Loaded ${this.servers.size} servers from config`)
  }

  /**
   * Save servers to config
   */
  private async saveServers(): Promise<void> {
    const config = getConfig()
    const serverList = Array.from(this.servers.values())
      .map((s) => {
        const shared = this.toSharedConfig(s)
        return {
          ...shared,
          status: 'disconnected' as const, // Don't persist connection status
        }
      })

    saveConfig({
      ...config,
      remoteServers: serverList,
    })

    console.log(`[RemoteDeployService] Saved ${serverList.length} servers to config`)
  }

  /**
   * Generate a unique server ID
   */
  private generateId(): string {
    return `server-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
  }

  /**
   * Generate a random auth token
   */
  private generateAuthToken(): string {
    return Buffer.from(`${Date.now()}-${Math.random()}`).toString('base64').substring(0, 32)
  }

  /**
   * Add a new server configuration
   * Automatically checks and deploys claude-agent-sdk if not installed
   */
  async addServer(config: RemoteServerConfigInput): Promise<string> {
    const id = this.generateId()
    console.log('[RemoteDeployService] addServer - Input:', JSON.stringify(config))

    // Build complete RemoteServerConfig with all required fields
    const server: RemoteServerConfig = {
      id,
      name: config.name,
      ssh: config.ssh,
      wsPort: config.wsPort,
      authToken: config.authToken || this.generateAuthToken(),
      status: 'disconnected',
    }

    console.log('[RemoteDeployService] addServer - Server object before save:', JSON.stringify(server))

    this.servers.set(id, server)
    await this.saveServers()

    const shared = this.toSharedConfig(server)
    console.log('[RemoteDeployService] addServer - Shared config:', JSON.stringify(shared))
    console.log(`[RemoteDeployService] Added server: ${server.name} (${id})`)

    // Automatically connect and check/deploy agent-sdk
    try {
      await this.connectServer(id)

      // Check if claude-agent-sdk is installed
      const agentCheck = await this.checkAgentInstalled(id)
      console.log(`[RemoteDeployService] Agent check result:`, agentCheck)

      if (!agentCheck.installed) {
        console.log(`[RemoteDeployService] Deploying claude-agent-sdk to ${server.name}...`)
        await this.deployAgentSDK(id)

        // Check again after deployment to confirm installation
        const postDeployCheck = await this.checkAgentInstalled(id)
        await this.updateServer(id, {
          status: 'disconnected',
          sdkInstalled: postDeployCheck.installed,
          sdkVersion: postDeployCheck.version,
        })
      } else {
        console.log(`[RemoteDeployService] claude-agent-sdk already installed on ${server.name}, version: ${agentCheck.version}`)
        // Update server metadata to show SDK is installed
        await this.updateServer(id, {
          status: 'disconnected',
          sdkInstalled: agentCheck.installed,
          sdkVersion: agentCheck.version,
          error: undefined,
        })
      }
    } catch (error) {
      console.error('[RemoteDeployService] Auto connect/check failed:', error)
      // Don't fail addServer if auto-deploy fails, just log the error
      await this.disconnectServer(id)
    }

    return id
  }

  /**
   * Get all servers
   */
  getServers(): RemoteServer[] {
    return Array.from(this.servers.values()).map((s) => this.toSharedConfig(s))
  }

  /**
   * Get a specific server by ID
   */
  getServer(id: string): RemoteServer | undefined {
    const config = this.servers.get(id)
    return config ? this.toSharedConfig(config) : undefined
  }

  /**
   * Update a server configuration
   */
  async updateServer(id: string, updates: Partial<Omit<RemoteServerConfig, 'id'>>): Promise<void> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    this.servers.set(id, { ...server, ...updates })
    await this.saveServers()
    this.notifyStatusChange(id, this.servers.get(id)!)
  }

  /**
   * Remove a server
   */
  async removeServer(id: string): Promise<void> {
    const server = this.servers.get(id)
    if (server) {
      await this.disconnectServer(id)
      this.servers.delete(id)
      await this.saveServers()
      console.log(`[RemoteDeployService] Removed server: ${server.name} (${id})`)
    }
  }

  /**
   * Get or create SSH manager for a server
   */
  private getSSHManager(id: string): SSHManager {
    let manager = this.sshManagers.get(id)

    // If manager exists but is not connected, create a fresh one
    if (manager && !manager.isConnected()) {
      console.log(`[RemoteDeployService] Cached SSH manager for ${id} is disconnected, creating fresh one`)
      this.sshManagers.delete(id)
      manager = new SSHManager()
      this.sshManagers.set(id, manager)
    } else if (!manager) {
      manager = new SSHManager()
      this.sshManagers.set(id, manager)
    }

    return manager
  }

  /**
   * Connect to a server
   */
  async connectServer(id: string): Promise<void> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    console.log(`[RemoteDeployService] connectServer called for ${server.name} (${id}), current status: ${server.status}`)

    if (server.status === 'connected') {
      console.log(`[RemoteDeployService] Server ${server.name} already connected, checking SSH state...`)
      const manager = this.getSSHManager(id)
      console.log(`[RemoteDeployService] SSH state: ${manager.isConnected()}`)
      if (manager.isConnected()) {
        console.log(`[RemoteDeployService] SSH is connected, reusing connection`)
        return
      }
      console.log(`[RemoteDeployService] SSH is not connected, will reconnect`)
    }

    await this.updateServer(id, { status: 'connecting' })

    try {
      const manager = this.getSSHManager(id)
      console.log(`[RemoteDeployService] Calling manager.connect for ${server.name}...`)

      manager.connect(server.ssh)

      // Wait a bit for connection to stabilize
      await new Promise(resolve => setTimeout(resolve, 2000))

      // Verify SSH is actually connected
      console.log(`[RemoteDeployService] Verifying SSH connection after 2s: ${manager.isConnected()}`)

      if (!manager.isConnected()) {
        throw new Error('SSH connection not established')
      }

      // Sync auth token from remote server
      try {
        console.log(`[RemoteDeployService] Syncing auth token from remote server...`)
        const envContent = await manager.executeCommand(`cat ${DEPLOY_AGENT_PATH}/.env 2>/dev/null || echo ""`)
        const authTokenMatch = envContent.match(/AUTH_TOKEN=(.+)/)
        if (authTokenMatch && authTokenMatch[1]) {
          const remoteAuthToken = authTokenMatch[1].trim()
          if (remoteAuthToken !== server.authToken) {
            console.log(`[RemoteDeployService] Updating local auth token to match remote`)
            server.authToken = remoteAuthToken
            await this.saveServers()
          }
        } else {
          console.log(`[RemoteDeployService] No AUTH_TOKEN found in remote .env, using local config`)
        }
      } catch (error) {
        console.error(`[RemoteDeployService] Failed to sync auth token:`, error)
      }

      await this.updateServer(id, {
        status: 'connected',
        error: undefined,
        lastConnected: new Date(),
      })

      console.log(`[RemoteDeployService] Connected to server: ${server.name}`)
    } catch (error) {
      const err = error as Error
      console.error(`[RemoteDeployService] connectServer error for ${server.name}:`, err)
      await this.updateServer(id, {
        status: 'error',
        error: err.message,
      })
      throw error
    }
  }

  /**
   * Disconnect from a server
   */
  async disconnectServer(id: string): Promise<void> {
    const manager = this.sshManagers.get(id)
    if (manager) {
      manager.disconnect()
      this.sshManagers.delete(id)
    }

    const server = this.servers.get(id)
    if (server && (server.status === 'connected' || server.status === 'connecting')) {
      await this.updateServer(id, { status: 'disconnected', error: undefined })
      console.log(`[RemoteDeployService] Disconnected from server: ${server.name}`)
    }
  }

  /**
   * Deploy to a server (full deployment including agent code)
   * Note: Does NOT auto-start the agent, only deploys the SDK
   */
  async deployToServer(id: string): Promise<void> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    if (server.status !== 'connected') {
      await this.connectServer(id)
    }

    await this.updateServer(id, { status: 'deploying' })

    try {
      // Only deploy the agent SDK, don't start the agent
      await this.deployAgentSDK(id)

      await this.updateServer(id, { status: 'connected' })
      console.log(`[RemoteDeployService] Deployment completed for: ${server.name}`)
    } catch (error) {
      const err = error as Error
      await this.updateServer(id, {
        status: 'error',
        error: err.message,
      })
      throw error
    }
  }

  /**
   * Deploy agent code to the remote server
   * Uploads the pre-built remote-agent-proxy package from packages/remote-agent-proxy/dist
   */
  async deployAgentCode(id: string): Promise<void> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    const manager = this.getSSHManager(id)

    try {
      // Create deployment directory structure
      console.log('[RemoteDeployService] Creating deployment directories...')
      await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/dist`)
      await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/logs`)
      await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/data`)

      // Get the path to the remote-agent-proxy package
      const packageDir = getRemoteAgentProxyPath()
      const distDir = path.join(packageDir, 'dist')

      console.log(`[RemoteDeployService] Looking for remote-agent-proxy at: ${packageDir}`)
      console.log(`[RemoteDeployService] Dist directory: ${distDir}`)

      // Check if dist directory exists
      if (!fs.existsSync(distDir)) {
        throw new Error(`Remote agent proxy not built. Run 'npm run build' in packages/remote-agent-proxy first. (looked at: ${distDir})`)
      }

      console.log('[RemoteDeployService] Uploading remote-agent-proxy package...')

      // Upload package.json first
      const packageJsonPath = path.join(packageDir, 'package.json')
      if (fs.existsSync(packageJsonPath)) {
        await manager.uploadFile(packageJsonPath, `${DEPLOY_AGENT_PATH}/package.json`)
        console.log('[RemoteDeployService] Uploaded package.json')
      }

      // Upload all files from dist directory
      const distFiles = fs.readdirSync(distDir)
      for (const file of distFiles) {
        const localPath = path.join(distDir, file)
        const remotePath = `${DEPLOY_AGENT_PATH}/dist/${file}`

        if (fs.statSync(localPath).isFile()) {
          console.log(`[RemoteDeployService] Uploading ${file}...`)
          await manager.uploadFile(localPath, remotePath)
        }
      }

      console.log('[RemoteDeployService] Package upload completed')

      // Install dependencies on remote server
      console.log('[RemoteDeployService] Installing dependencies on remote server...')
      const installResult = await manager.executeCommandFull(`cd ${DEPLOY_AGENT_PATH} && npm install --production`)
      console.log('[RemoteDeployService] npm install output:', installResult.stdout)
      if (installResult.stderr) {
        console.log('[RemoteDeployService] npm install stderr:', installResult.stderr)
      }

      if (installResult.exitCode !== 0) {
        throw new Error(`Failed to install dependencies: ${installResult.stderr || installResult.stdout}`)
      }

      // Upload local patched SDK to remote server
      // This ensures the remote SDK has the same patches as local (cwd, permissionMode, extraArgs, etc.)
      console.log('[RemoteDeployService] Uploading locally patched SDK to remote server...')
      const projectRoot = app.isPackaged ? process.resourcesPath : app.getAppPath()
      const localSdkPath = path.join(projectRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
      const remoteSdkPath = `${DEPLOY_AGENT_PATH}/node_modules/@anthropic-ai/claude-agent-sdk`

      // Check if local patched SDK exists
      if (fs.existsSync(path.join(localSdkPath, 'sdk.mjs'))) {
        // Upload the patched sdk.mjs file
        const localSdkFile = path.join(localSdkPath, 'sdk.mjs')
        console.log(`[RemoteDeployService] Uploading patched sdk.mjs from ${localSdkFile}`)
        await manager.uploadFile(localSdkFile, `${remoteSdkPath}/sdk.mjs`)
        console.log('[RemoteDeployService] Patched SDK uploaded successfully')
      } else {
        console.warn('[RemoteDeployService] Local patched SDK not found, skipping SDK upload')
        console.warn('[RemoteDeployService] Expected path:', path.join(localSdkPath, 'sdk.mjs'))
      }

      console.log(`[RemoteDeployService] Agent code deployed to: ${server.name}`)

      // Restart agent to apply changes
      console.log('[RemoteDeployService] Restarting agent to apply changes...')
      try {
        await this.stopAgent(id)
        await new Promise(resolve => setTimeout(resolve, 1000))
        await this.startAgent(id)
        console.log('[RemoteDeployService] Agent restarted successfully')
      } catch (restartError) {
        console.error('[RemoteDeployService] Failed to restart agent:', restartError)
        // Don't throw - the code was deployed successfully
      }
    } catch (error) {
      console.error('[RemoteDeployService] Deploy error:', error)
      throw error
    }
  }

  /**
   * Start the agent on the remote server
   */
  async startAgent(id: string): Promise<void> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    const manager = this.getSSHManager(id)

    // Ensure logs directory exists
    await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/logs`)

    // Check if process is already running
    const checkResult = await manager.executeCommandFull(
      `pgrep -f "node.*${DEPLOY_AGENT_PATH}" || echo "not running"`
    )

    if (checkResult.exitCode === 0 && !checkResult.stdout.includes('not running')) {
      console.log('[RemoteDeployService] Agent already running, restarting...')
      await this.stopAgent(id)
    }

    // Start the agent server with environment variables
    // Use the correct env var names expected by remote-agent-proxy
    const envVars = [
      `REMOTE_AGENT_PORT=${server.wsPort || 8080}`,
      `REMOTE_AGENT_AUTH_TOKEN=${server.authToken || ''}`,
      `REMOTE_AGENT_WORK_DIR=${server.workDir || '/root'}`,
      `IS_SANDBOX=1`,  // Required for bypass-permissions mode in root environment
      server.claudeApiKey ? `ANTHROPIC_API_KEY=${server.claudeApiKey}` : null,
      server.claudeBaseUrl ? `ANTHROPIC_BASE_URL=${server.claudeBaseUrl}` : null,
      server.claudeModel ? `ANTHROPIC_MODEL=${server.claudeModel}` : null
    ].filter(Boolean).join(' ')

    const indexPath = `${DEPLOY_AGENT_PATH}/dist/index.js`

    console.log(`[RemoteDeployService] Starting agent with env: PORT=${server.wsPort || 8080}, WORK_DIR=${server.workDir || '/root'}`)

    const startCommand = `nohup env ${envVars} node ${indexPath} > ${DEPLOY_AGENT_PATH}/logs/output.log 2>&1 &`
    await manager.executeCommand(startCommand)

    // Wait a moment for the process to start
    await new Promise(resolve => setTimeout(resolve, 3000))

    // Check if it's running by checking the port
    const port = server.wsPort || 8080
    const verifyResult = await manager.executeCommandFull(
      `ss -tln | grep ":${port}" || echo "NOT_RUNNING"`
    )

    if (verifyResult.stdout.includes('NOT_RUNNING')) {
      // Check the logs for error
      try {
        const logResult = await manager.executeCommand(`tail -50 ${DEPLOY_AGENT_PATH}/logs/output.log`)
        console.error('[RemoteDeployService] Agent startup failed. Logs:', logResult)
      } catch {}
      throw new Error('Failed to start agent process - port not listening')
    }

    console.log(`[RemoteDeployService] Agent started on: ${server.name}, port ${port}`)
  }

  /**
   * Stop the agent on the remote server
   */
  async stopAgent(id: string): Promise<void> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    const manager = this.getSSHManager(id)

    // Kill any node process running from the deployment directory
    await manager.executeCommand(
      `pkill -f "node.*${DEPLOY_AGENT_PATH}" || true`
    )

    console.log(`[RemoteDeployService] Agent stopped on: ${server.name}`)
  }

  /**
   * Get agent server logs
   */
  async getAgentLogs(id: string, lines: number = 100): Promise<string> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    const manager = this.getSSHManager(id)
    try {
      const logPath = `${DEPLOY_AGENT_PATH}/logs/output.log`
      const result = await manager.executeCommandFull(`tail -${lines} ${logPath}`)
      return result.stdout
    } catch (error) {
      console.error('[RemoteDeployService] Failed to get agent logs:', error)
      throw error
    }
  }

  /**
   * Check if agent server is running
   */
  async isAgentRunning(id: string): Promise<boolean> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    const manager = this.getSSHManager(id)
    try {
      // Check if the WebSocket port is listening
      const port = server.wsPort || 8080
      const result = await manager.executeCommandFull(
        `ss -tln | grep ":${port}" || echo "NOT_RUNNING"`
      )
      return !result.stdout.includes('NOT_RUNNING')
    } catch {
      return false
    }
  }

  /**
   * Execute a command on the remote server
   */
  async executeCommand(id: string, command: string): Promise<string> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    if (server.status !== 'connected') {
      await this.connectServer(id)
    }

    const manager = this.getSSHManager(id)
    return manager.executeCommand(command)
  }

  /**
   * Get the SSH manager for a server (for streaming execution)
   */
  getSSHManagerForServer(id: string): SSHManager | undefined {
    const server = this.servers.get(id)
    if (!server) {
      return undefined
    }
    if (server.status !== 'connected') {
      return undefined
    }
    return this.getSSHManager(id)
  }

  /**
   * Send a message to the agent via SSH (for operations not yet supported by WebSocket)
   */
  async sendAgentMessage(id: string, message: any): Promise<any> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    // For now, this is a placeholder
    // In the full implementation, this would use WebSocket client
    console.log(`[RemoteDeployService] Sending message to agent:`, message.type)

    return {
      type: 'response',
      success: true,
    }
  }

  /**
   * Register a status change callback
   */
  onStatusChange(callback: (serverId: string, config: RemoteServer) => void): void {
    this.statusCallbacks.add(callback)
  }

  /**
   * Remove a status change callback
   */
  offStatusChange(callback: (serverId: string, config: RemoteServer) => void): void {
    this.statusCallbacks.delete(callback)
  }

  /**
   * Notify all registered callbacks of a status change
   */
  private notifyStatusChange(serverId: string, config: RemoteServerConfig): void {
    const shared = this.toSharedConfig(config)
    for (const callback of this.statusCallbacks) {
      try {
        callback(serverId, shared)
      } catch (error) {
        console.error('[RemoteDeployService] Status callback error:', error)
      }
    }
  }

  /**
   * Disconnect all servers
   */
  disconnectAll(): void {
    for (const [id] of this.servers) {
      this.disconnectServer(id)
    }
  }

  /**
   * Check if claude-agent-sdk is installed on remote server
   */
  async checkAgentInstalled(id: string): Promise<{ installed: boolean; version?: string }> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    console.log(`[RemoteDeployService] Starting SDK check for ${server.name}, current status: ${server.status}`)

    // Get the SSH manager first
    const manager = this.getSSHManager(id)

    // Check if SSH connection is actually established
    console.log(`[RemoteDeployService] Checking SSH connection state: ${manager.isConnected()}`)

    // Only connect if not already connected
    if (!manager.isConnected()) {
      console.log(`[RemoteDeployService] Not connected, connecting to ${server.name}...`)
      await this.connectServer(id)
      // Wait for connection to stabilize
      console.log(`[RemoteDeployService] Waiting for SSH connection to stabilize...`)
      await new Promise(resolve => setTimeout(resolve, 1500))
    }

    // Verify connection is ready
    console.log(`[RemoteDeployService] Verifying SSH connection state after connect: ${manager.isConnected()}`)
    if (!manager.isConnected()) {
      throw new Error(`Failed to establish SSH connection to server: ${server.name}`)
    }

    try {
      // First, test connection with a simple pwd command
      console.log(`[RemoteDeployService] Testing SSH connection to ${server.name} with pwd command...`)
      this.emitCommandOutput(id, 'command', 'pwd')
      const testResult = await manager.executeCommandFull('pwd')
      console.log(`[RemoteDeployService] pwd result: ${testResult.stdout}`)
      if (testResult.stdout.trim()) {
        this.emitCommandOutput(id, 'output', testResult.stdout.trim())
      }

      // Check if claude-agent-sdk is installed globally using npm list
      console.log(`[RemoteDeployService] Checking for claude-agent-sdk...`)
      this.emitCommandOutput(id, 'command', AGENT_CHECK_COMMAND)
      const result = await manager.executeCommandFull(AGENT_CHECK_COMMAND)
      const stdout = result.stdout.trim()
      const stderr = result.stderr.trim()

      console.log(`[RemoteDeployService] npm list output: stdout="${stdout}", stderr="${stderr}"`)

      if (stdout) {
        this.emitCommandOutput(id, 'output', stdout)
      }
      if (stderr) {
        this.emitCommandOutput(id, 'error', stderr)
      }

      // npm list -g returns:
      // - If installed: "/path/to/node_modules/@anthropic-ai/claude-agent-sdk@x.y.z"
      // - If not installed: empty string or "empty string"
      const installed = stdout.includes('@anthropic-ai/claude-agent-sdk') && !stdout.includes('NOT_INSTALLED')

      // If installed, try to extract version
      let version: string | undefined
      if (installed) {
        // Parse version from output like: "/path/node_modules/@anthropic-ai/claude-agent-sdk@0.1.0"
        const versionMatch = stdout.match(/@anthropic-ai\/claude-agent-sdk@([\d.]+)/)
        version = versionMatch ? versionMatch[1] : 'unknown'
      }

      const statusMessage = installed
        ? `claude-agent-sdk is installed (version: ${version})`
        : 'claude-agent-sdk is not installed'

      this.emitCommandOutput(id, 'success', statusMessage)
      console.log(`[RemoteDeployService] Agent check for ${server.name}: installed=${installed}, version=${version}`)

      // Update server config with SDK status
      await this.updateServer(id, {
        sdkInstalled: installed,
        sdkVersion: version,
      })

      return { installed, version }
    } catch (error) {
      console.error(`[RemoteDeployService] Failed to check agent on ${server.name}:`, error)
      throw error
    }
  }

  /**
   * Deploy agent SDK to remote server via SCP
   */
  async deployAgentSDK(id: string): Promise<void> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    console.log(`[RemoteDeployService] Starting SDK deployment for ${server.name}, current status: ${server.status}`)

    // Get the SSH manager first
    const manager = this.getSSHManager(id)

    // Check if SSH connection is actually established
    console.log(`[RemoteDeployService] Checking SSH connection state: ${manager.isConnected()}`)

    // Only connect if not already connected
    if (!manager.isConnected()) {
      console.log(`[RemoteDeployService] Not connected, connecting to ${server.name}...`)
      await this.connectServer(id)
      // Wait for connection to stabilize
      console.log(`[RemoteDeployService] Waiting for SSH connection to stabilize...`)
      await new Promise(resolve => setTimeout(resolve, 1500))
    }

    // Verify connection is ready
    console.log(`[RemoteDeployService] Verifying SSH connection state after connect: ${manager.isConnected()}`)
    if (!manager.isConnected()) {
      throw new Error(`Failed to establish SSH connection to server: ${server.name}`)
    }

    try {
      console.log(`[RemoteDeployService] Deploying agent SDK to ${server.name}`)
      this.emitCommandOutput(id, 'command', 'Starting deployment of claude-agent-sdk...')

      // First, test connection with a simple pwd command
      console.log(`[RemoteDeployService] Testing SSH connection to ${server.name} with pwd command...`)
      this.emitCommandOutput(id, 'command', 'pwd')
      const testResult = await manager.executeCommandFull('pwd')
      console.log(`[RemoteDeployService] pwd result: ${testResult.stdout}`)
      if (testResult.stdout.trim()) {
        this.emitCommandOutput(id, 'output', testResult.stdout.trim())
      }

      // Check if Node.js is installed
      console.log('[RemoteDeployService] Checking Node.js installation...')
      this.emitCommandOutput(id, 'command', 'node --version')
      try {
        const nodeVersion = await manager.executeCommandFull('node --version')
        console.log(`[RemoteDeployService] Node.js version: ${nodeVersion.stdout.trim()}`)
        this.emitCommandOutput(id, 'output', nodeVersion.stdout.trim())
      } catch {
        this.emitCommandOutput(id, 'error', 'Node.js is not installed on the remote server. Please install Node.js first.')
        throw new Error('Node.js is not installed on the remote server. Please install Node.js first.')
      }

      // Check if npm is installed
      console.log('[RemoteDeployService] Checking npm installation...')
      this.emitCommandOutput(id, 'command', 'npm --version')
      try {
        const npmVersion = await manager.executeCommandFull('npm --version')
        console.log(`[RemoteDeployService] npm version: ${npmVersion.stdout.trim()}`)
        this.emitCommandOutput(id, 'output', npmVersion.stdout.trim())
      } catch {
        this.emitCommandOutput(id, 'error', 'npm is not installed on the remote server. Please install npm first.')
        throw new Error('npm is not installed on the remote server. Please install npm first.')
      }

      // Install claude-agent-sdk globally
      console.log('[RemoteDeployService] Installing @anthropic-ai/claude-agent-sdk globally...')
      const installCmd = 'npm install -g @anthropic-ai/claude-agent-sdk'
      this.emitCommandOutput(id, 'command', installCmd)
      const installResult = await manager.executeCommandFull(installCmd)
      console.log('[RemoteDeployService] npm install output:', installResult.stdout)
      if (installResult.stdout.trim()) {
        this.emitCommandOutput(id, 'output', installResult.stdout.trim())
      }
      if (installResult.stderr) {
        console.log('[RemoteDeployService] npm install stderr:', installResult.stderr)
        this.emitCommandOutput(id, 'error', installResult.stderr.trim())
      }

      if (installResult.exitCode !== 0) {
        this.emitCommandOutput(id, 'error', `npm install failed with exit code ${installResult.exitCode}`)
        throw new Error(`npm install failed with exit code ${installResult.exitCode}: ${installResult.stderr}`)
      }

      const successMsg = 'claude-agent-sdk installed successfully'
      this.emitCommandOutput(id, 'success', successMsg)
      console.log(`[RemoteDeployService] Agent SDK deployment completed for ${server.name}`)

      // Update SDK status after deployment
      const sdkCheck = await this.checkAgentInstalled(id)
      await this.updateServer(id, {
        sdkInstalled: sdkCheck.installed,
        sdkVersion: sdkCheck.version,
      })
    } catch (error) {
      const err = error as Error
      console.error(`[RemoteDeployService] Failed to deploy agent SDK to ${server.name}:`, error)
      this.emitCommandOutput(id, 'error', err.message)
      throw error
    }
  }
}
