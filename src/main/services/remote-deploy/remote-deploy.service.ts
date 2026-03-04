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
import os from 'os'
import { SYSTEM_PROMPT_TEMPLATE } from '../agent/system-prompt'

/**
 * Escape a value for use in shell environment variable
 * Handles special characters like quotes, spaces, etc.
 */
function escapeEnvValue(value: string): string {
  // If the value contains no special characters, return as-is
  if (/^[a-zA-Z0-9_\-./:@]+$/.test(value)) {
    return value
  }
  // Otherwise, wrap in single quotes and escape any existing single quotes
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Get the path to the remote-agent-proxy package
 * Works in both development and production modes
 */
function getRemoteAgentProxyPath(): string {
  // In development mode, use the project root
  // In production mode, use the app resources path
  if (app.isPackaged) {
    // Production: resources are in app.asar/packages
    // Use app.getAppPath() which returns the path to app.asar in production
    const appPath = app.getAppPath()
    return path.join(appPath, 'packages', 'remote-agent-proxy')
  } else {
    // Development: use the project root
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
const AGENT_CHECK_COMMAND = 'npm list -g @anthropic-ai/claude-agent-sdk 2>/dev/null || echo "NOT_INSTALLED"'

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
  private deployProgressCallbacks: Set<(serverId: string, stage: string, message: string, progress?: number) => void> = new Set()

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
   * Subscribe to deploy progress events
   */
  onDeployProgress(callback: (serverId: string, stage: string, message: string, progress?: number) => void): () => void {
    this.deployProgressCallbacks.add(callback)
    return () => this.deployProgressCallbacks.delete(callback)
  }

  /**
   * Emit command output event
   */
  private emitCommandOutput(serverId: string, type: 'command' | 'output' | 'error' | 'success', content: string): void {
    this.commandOutputCallbacks.forEach(callback => callback(serverId, type, content))
  }

  /**
   * Emit deploy progress event
   */
  private emitDeployProgress(serverId: string, stage: string, message: string, progress?: number): void {
    console.log(`[RemoteDeployService][${serverId}] ${stage}: ${message}`)
    this.deployProgressCallbacks.forEach(callback => callback(serverId, stage, message, progress))
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

    // Automatically connect and perform full deployment
    try {
      await this.connectServer(id)

      // Step 1: Check and install Claude CLI + SDK globally
      const agentCheck = await this.checkAgentInstalled(id)
      console.log(`[RemoteDeployService] Agent check result:`, agentCheck)

      if (!agentCheck.installed) {
        console.log(`[RemoteDeployService] Deploying Claude CLI and SDK to ${server.name}...`)
        await this.deployAgentSDK(id)

        const postDeployCheck = await this.checkAgentInstalled(id)
        await this.updateServer(id, {
          sdkInstalled: postDeployCheck.installed,
          sdkVersion: postDeployCheck.version,
        })
      } else {
        console.log(`[RemoteDeployService] claude-agent-sdk already installed on ${server.name}, version: ${agentCheck.version}`)
        await this.updateServer(id, {
          sdkInstalled: agentCheck.installed,
          sdkVersion: agentCheck.version,
          error: undefined,
        })
      }

      // Step 2: Deploy agent code (upload remote-agent-proxy, install deps, upload patched SDK)
      console.log(`[RemoteDeployService] Deploying agent code to ${server.name}...`)
      await this.deployAgentCode(id)

      // Step 3: Start the agent
      console.log(`[RemoteDeployService] Starting agent on ${server.name}...`)
      await this.startAgent(id)

      await this.updateServer(id, { status: 'connected', error: undefined })
      console.log(`[RemoteDeployService] Full deployment completed for ${server.name}`)
    } catch (error) {
      console.error('[RemoteDeployService] Auto deployment failed:', error)
      await this.updateServer(id, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      })
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
   * Deploy to a server (full deployment including agent code and system prompt)
   * This deploys the complete agent package including:
   * - SDK installation
   * - Agent code upload
   * - System prompt sync
   * - Auto restart agent to apply changes
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
      // Deploy agent SDK
      await this.deployAgentSDK(id)

      // Deploy agent code (includes system prompt sync and auto restart)
      await this.deployAgentCode(id)

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

    // Ensure SSH connection is established before proceeding
    if (!manager.isConnected()) {
      this.emitDeployProgress(id, 'connect', `正在连接到 ${server.name}...`, 5)
      await this.connectServer(id)
      // Re-get the manager after connection
      const connectedManager = this.getSSHManager(id)
      if (!connectedManager.isConnected()) {
        throw new Error(`Failed to establish SSH connection to ${server.name}`)
      }
    }

    try {
      // Create deployment directory structure
      this.emitDeployProgress(id, 'prepare', '正在创建部署目录...', 10)
      await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/dist`)
      await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/logs`)
      await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/data`)

      // Get the path to the remote-agent-proxy package
      const packageDir = getRemoteAgentProxyPath()
      const distDir = path.join(packageDir, 'dist')

      // Check if dist directory exists
      if (!fs.existsSync(distDir)) {
        throw new Error(`Remote agent proxy not built. Run 'npm run build' in packages/remote-agent-proxy first. (looked at: ${distDir})`)
      }

      // Upload package.json first
      this.emitDeployProgress(id, 'upload', '正在上传 package.json...', 15)
      const packageJsonPath = path.join(packageDir, 'package.json')
      if (fs.existsSync(packageJsonPath)) {
        await manager.uploadFile(packageJsonPath, `${DEPLOY_AGENT_PATH}/package.json`)
      }

      // Upload all files from dist directory
      const distFiles = fs.readdirSync(distDir).filter(f => fs.statSync(path.join(distDir, f)).isFile())
      let uploadedCount = 0
      for (const file of distFiles) {
        const localPath = path.join(distDir, file)
        const remotePath = `${DEPLOY_AGENT_PATH}/dist/${file}`
        uploadedCount++
        const progress = 15 + Math.round((uploadedCount / distFiles.length) * 20)
        this.emitDeployProgress(id, 'upload', `正在上传 ${file}...`, progress)
        await manager.uploadFile(localPath, remotePath)
      }

      // Upload patches directory for SDK patch support
      const patchesDir = path.join(packageDir, 'patches')
      if (fs.existsSync(patchesDir)) {
        this.emitDeployProgress(id, 'upload', '正在上传 SDK 补丁...', 40)
        await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/patches`)
        const patchFiles = fs.readdirSync(patchesDir)
        for (const file of patchFiles) {
          const localPath = path.join(patchesDir, file)
          if (fs.statSync(localPath).isFile()) {
            await manager.uploadFile(localPath, `${DEPLOY_AGENT_PATH}/patches/${file}`)
          }
        }
      }

      // Check if Node.js is installed before running npm commands
      this.emitDeployProgress(id, 'prepare', '检查 Node.js 环境...', 42)
      const nodeCheck = await manager.executeCommandFull('node --version')
      if (nodeCheck.exitCode !== 0 || !nodeCheck.stdout.trim()) {
        // Node.js not installed, install it automatically
        console.log('[RemoteDeployService] Node.js not found, installing...')
        this.emitDeployProgress(id, 'prepare', 'Node.js 未安装，正在自动安装...', 43)
        this.emitCommandOutput(id, 'command', 'Installing Node.js 20.x...')

        // Detect OS and architecture, then install Node.js
        // Supports: Debian/Ubuntu, RHEL/CentOS/Fedora, EulerOS/openEuler, Amazon Linux, Alpine, Arch, SUSE
        // For EulerOS/openEuler, use official Node.js binary tarball since NodeSource doesn't support them
        // Detect architecture: x86_64 -> linux-x64, aarch64 -> linux-arm64
        // Note: Check if node can actually execute (not just exists) to handle broken installations
        // Use npmmirror (Taobao) as fallback for China network issues
        const installNodeCmd = `ARCH=$(uname -m) && NODE_ARCH=$([ "$ARCH" = "aarch64" ] && echo "linux-arm64" || echo "linux-x64") && NODE_VER="v20.18.1" && if node --version > /dev/null 2>&1; then echo "Node.js already installed and working"; elif [ -f /etc/debian_version ]; then curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs; elif [ -f /etc/redhat-release ]; then curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs; elif grep -qE "EulerOS|openEuler|hce" /etc/os-release 2>/dev/null; then echo "Detected EulerOS/openEuler on $ARCH, installing Node.js $NODE_VER for $NODE_ARCH..." && rm -rf /usr/local/node-v* /usr/local/bin/node /usr/local/bin/npm 2>/dev/null && (curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$NODE_ARCH.tar.xz" -o /tmp/node.tar.xz || curl -fsSL "https://npmmirror.com/mirrors/node/$NODE_VER/node-$NODE_VER-$NODE_ARCH.tar.xz" -o /tmp/node.tar.xz) && tar -xJf /tmp/node.tar.xz -C /usr/local && rm /tmp/node.tar.xz && ln -sf /usr/local/node-$NODE_VER-$NODE_ARCH/bin/node /usr/local/bin/node && ln -sf /usr/local/node-$NODE_VER-$NODE_ARCH/bin/npm /usr/local/bin/npm; elif command -v apk > /dev/null 2>&1; then apk add nodejs npm; else echo "Unsupported OS: $(cat /etc/os-release 2>/dev/null | head -1)" && exit 1; fi`

        const nodeInstallResult = await manager.executeCommandFull(installNodeCmd)
        if (nodeInstallResult.stdout.trim()) {
          this.emitCommandOutput(id, 'output', nodeInstallResult.stdout.trim())
        }
        if (nodeInstallResult.exitCode !== 0) {
          this.emitCommandOutput(id, 'error', `Failed to install Node.js: ${nodeInstallResult.stderr}`)
          throw new Error(`Failed to install Node.js: ${nodeInstallResult.stderr}`)
        }

        this.emitCommandOutput(id, 'success', 'Node.js installed successfully')
      } else {
        this.emitCommandOutput(id, 'output', `Node.js: ${nodeCheck.stdout.trim()}`)
      }

      // Install dependencies on remote server
      this.emitDeployProgress(id, 'install', '正在配置 npm 镜像...', 45)
      await manager.executeCommand('npm config set registry https://registry.npmmirror.com')

      // Verify package.json exists before installing
      const packageJsonCheck = await manager.executeCommandFull(`test -f ${DEPLOY_AGENT_PATH}/package.json && echo "EXISTS" || echo "NOT_FOUND"`)
      if (packageJsonCheck.stdout.includes('NOT_FOUND')) {
        throw new Error('package.json not found on remote server - upload failed')
      }

      // Remove existing node_modules to force clean install
      this.emitDeployProgress(id, 'install', '正在清理旧依赖...', 50)
      await manager.executeCommand(`rm -rf ${DEPLOY_AGENT_PATH}/node_modules`)

      // Run npm install with streaming output
      this.emitDeployProgress(id, 'install', '正在安装依赖 (npm install)...', 55)
      this.emitCommandOutput(id, 'command', `$ npm install`)

      const installResult = await manager.executeCommandStreaming(
        `cd ${DEPLOY_AGENT_PATH} && npm install 2>&1`,
        (type, data) => {
          // Send each line of output to terminal
          const lines = data.split('\n').filter(line => line.trim())
          for (const line of lines) {
            this.emitCommandOutput(id, type === 'stderr' ? 'error' : 'output', line)
          }
        }
      )

      if (installResult.exitCode !== 0) {
        this.emitDeployProgress(id, 'error', `依赖安装失败 (exit code: ${installResult.exitCode})`, 0)
        throw new Error(`Failed to install dependencies: ${installResult.stderr || installResult.stdout}`)
      }

      this.emitCommandOutput(id, 'success', '✓ 依赖安装完成')
      this.emitDeployProgress(id, 'install', '依赖安装完成', 75)

      // Also install SDK globally for use by other projects
      this.emitDeployProgress(id, 'install', '正在全局安装 SDK...', 77)
      this.emitCommandOutput(id, 'command', '$ npm install -g @anthropic-ai/claude-agent-sdk')
      const globalSdkResult = await manager.executeCommandStreaming(
        'npm install -g @anthropic-ai/claude-agent-sdk 2>&1',
        (type, data) => {
          const lines = data.split('\n').filter(line => line.trim())
          for (const line of lines) {
            this.emitCommandOutput(id, type === 'stderr' ? 'error' : 'output', line)
          }
        }
      )
      if (globalSdkResult.exitCode === 0) {
        this.emitCommandOutput(id, 'success', '✓ SDK 全局安装完成')
      } else {
        this.emitCommandOutput(id, 'output', `! SDK 全局安装跳过: ${globalSdkResult.stderr || 'unknown error'}`)
      }

      // Verify node_modules was created
      const nodeModulesCheck = await manager.executeCommandFull(`test -d ${DEPLOY_AGENT_PATH}/node_modules && echo "EXISTS" || echo "NOT_FOUND"`)
      if (nodeModulesCheck.stdout.includes('NOT_FOUND')) {
        throw new Error('node_modules directory not created after npm install')
      }

      // Upload local patched SDK to remote server
      this.emitDeployProgress(id, 'sdk', '正在上传本地 SDK 补丁...', 80)
      const projectRoot = app.isPackaged ? process.resourcesPath : app.getAppPath()
      const localSdkPath = path.join(projectRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
      const remoteSdkPath = `${DEPLOY_AGENT_PATH}/node_modules/@anthropic-ai/claude-agent-sdk`

      // Check if local patched SDK exists
      if (fs.existsSync(path.join(localSdkPath, 'sdk.mjs'))) {
        await manager.executeCommand(`mkdir -p ${remoteSdkPath}`)
        const localSdkFile = path.join(localSdkPath, 'sdk.mjs')
        await manager.uploadFile(localSdkFile, `${remoteSdkPath}/sdk.mjs`)
        this.emitCommandOutput(id, 'success', '✓ SDK 补丁上传完成')
      } else {
        this.emitCommandOutput(id, 'output', '! 本地 SDK 补丁未找到，跳过上传')
      }

      // Sync system prompt to remote server
      this.emitDeployProgress(id, 'sync', '正在同步系统提示词...', 90)
      await this.syncSystemPrompt(id)

      // Restart agent to apply changes
      this.emitDeployProgress(id, 'restart', '正在重启 Agent...', 95)
      try {
        await this.stopAgent(id)
        await new Promise(resolve => setTimeout(resolve, 1000))
        await this.startAgent(id)
        this.emitCommandOutput(id, 'success', '✓ Agent 重启成功')
      } catch (restartError) {
        this.emitCommandOutput(id, 'error', `! Agent 重启失败: ${restartError}`)
        // Don't throw - the code was deployed successfully
      }

      this.emitDeployProgress(id, 'complete', '✓ 部署完成!', 100)
      this.emitCommandOutput(id, 'success', '========================================')
      this.emitCommandOutput(id, 'success', '部署成功完成!')
      this.emitCommandOutput(id, 'success', '========================================')

    } catch (error) {
      this.emitDeployProgress(id, 'error', `部署失败: ${error}`, 0)
      this.emitCommandOutput(id, 'error', `✗ 部署失败: ${error}`)
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
    // Escape single quotes in values and wrap them in single quotes to handle special characters
    const escapeEnvValue = (value: string | undefined): string => {
      if (!value) return "''"
      // Escape single quotes by replacing ' with '\''
      return `'${value.replace(/'/g, "'\\''")}'`
    }

    const envVars = [
      `REMOTE_AGENT_PORT=${server.wsPort || 8080}`,
      `REMOTE_AGENT_AUTH_TOKEN=${escapeEnvValue(server.authToken)}`,
      `REMOTE_AGENT_WORK_DIR=${escapeEnvValue(server.workDir || '/root')}`,
      `IS_SANDBOX=1`,  // Required for bypass-permissions mode in root environment
      server.claudeApiKey ? `ANTHROPIC_API_KEY=${escapeEnvValue(server.claudeApiKey)}` : null,
      server.claudeBaseUrl ? `ANTHROPIC_BASE_URL=${escapeEnvValue(server.claudeBaseUrl)}` : null,
      server.claudeModel ? `ANTHROPIC_MODEL=${escapeEnvValue(server.claudeModel)}` : null
    ].filter(Boolean).join(' ')

    const indexPath = `${DEPLOY_AGENT_PATH}/dist/index.js`

    console.log(`[RemoteDeployService] Starting agent with env: PORT=${server.wsPort || 8080}, WORK_DIR=${server.workDir || '/root'}`)

    const startCommand = `nohup env ${envVars} node ${indexPath} > ${DEPLOY_AGENT_PATH}/logs/output.log 2>&1 &`
    await manager.executeCommand(startCommand)

    // Wait a moment for the process to start
    await new Promise(resolve => setTimeout(resolve, 5000))

    // Check if it's running by checking the port (try both ss and netstat)
    const port = server.wsPort || 8080
    const verifyResult = await manager.executeCommandFull(
      `(ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep ":${port}" || echo "NOT_RUNNING"`
    )

    if (verifyResult.stdout.includes('NOT_RUNNING')) {
      // Check the logs for error
      let logOutput = ''
      try {
        const logResult = await manager.executeCommandFull(`tail -50 ${DEPLOY_AGENT_PATH}/logs/output.log 2>&1 || echo "No log file"`)
        logOutput = logResult.stdout || logResult.stderr || 'No logs available'
        console.error('[RemoteDeployService] Agent startup failed. Logs:', logOutput)
        this.emitCommandOutput(id, 'error', `Agent startup logs:\n${logOutput}`)
      } catch (e) {
        console.error('[RemoteDeployService] Failed to read logs:', e)
      }

      // Also check if node process is running at all
      const processCheck = await manager.executeCommandFull(`ps aux | grep -E "node.*${DEPLOY_AGENT_PATH}" | grep -v grep || echo "NO_PROCESS"`)
      console.log('[RemoteDeployService] Process check:', processCheck.stdout)

      throw new Error(`Failed to start agent process - port ${port} not listening. Logs: ${logOutput.slice(0, 500)}`)
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
   * Restart agent with new configuration (e.g., updated API key)
   * This only restarts the agent process, doesn't redeploy code
   */
  async restartAgentWithNewConfig(id: string): Promise<void> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    console.log(`[RemoteDeployService] Restarting agent with new config for: ${server.name}`)

    // Check if agent is currently running
    const manager = this.getSSHManager(id)
    const checkResult = await manager.executeCommandFull(
      `pgrep -f "node.*${DEPLOY_AGENT_PATH}" || echo "not running"`
    )

    if (checkResult.exitCode === 0 && !checkResult.stdout.includes('not running')) {
      // Agent is running, restart it with new config
      console.log(`[RemoteDeployService] Agent is running, restarting with new config...`)
      await this.stopAgent(id)
      await this.startAgent(id)
      console.log(`[RemoteDeployService] Agent restarted with new config`)
    } else {
      console.log(`[RemoteDeployService] Agent not running, no restart needed`)
    }
  }

  /**
   * Sync system prompt template to remote server
   * This uploads the template with placeholders intact.
   * The remote server will replace placeholders at runtime with its own values.
   */
  async syncSystemPrompt(id: string): Promise<void> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    const manager = this.getSSHManager(id)

    try {
      // Create config directory if not exists
      await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/config`)

      // Write system prompt template to file
      // The template uses ${VAR} placeholders that will be replaced at runtime by the remote server
      const remotePath = `${DEPLOY_AGENT_PATH}/config/system-prompt.txt`

      // Use base64 encoding to safely transfer the prompt template
      const base64Content = Buffer.from(SYSTEM_PROMPT_TEMPLATE).toString('base64')
      const uploadCommand = `echo "${base64Content}" | base64 -d > ${remotePath}`

      await manager.executeCommand(uploadCommand)

      console.log(`[RemoteDeployService] System prompt template synced to ${remotePath}`)
    } catch (error) {
      console.error('[RemoteDeployService] Failed to sync system prompt:', error)
      throw error
    }
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

      // Check if Node.js is installed, install if not
      console.log('[RemoteDeployService] Checking Node.js installation...')
      this.emitCommandOutput(id, 'command', 'node --version')
      try {
        const nodeVersion = await manager.executeCommandFull('node --version')
        console.log(`[RemoteDeployService] Node.js version: ${nodeVersion.stdout.trim()}`)
        this.emitCommandOutput(id, 'output', nodeVersion.stdout.trim())
      } catch {
        // Node.js not installed, install it automatically
        console.log('[RemoteDeployService] Node.js not found, installing...')
        this.emitCommandOutput(id, 'command', 'Installing Node.js 20.x...')

        // Detect OS and architecture, then install Node.js
        // Supports: Debian/Ubuntu, RHEL/CentOS/Fedora, EulerOS/openEuler, Amazon Linux, Alpine, Arch, SUSE
        // For EulerOS/openEuler, use official Node.js binary tarball since NodeSource doesn't support them
        // Detect architecture: x86_64 -> linux-x64, aarch64 -> linux-arm64
        // Note: Check if node can actually execute (not just exists) to handle broken installations
        // Use npmmirror (Taobao) as fallback for China network issues
        const installNodeCmd = `ARCH=$(uname -m) && NODE_ARCH=$([ "$ARCH" = "aarch64" ] && echo "linux-arm64" || echo "linux-x64") && NODE_VER="v20.18.1" && if node --version > /dev/null 2>&1; then echo "Node.js already installed and working"; elif [ -f /etc/debian_version ]; then curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs; elif [ -f /etc/redhat-release ]; then curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs; elif grep -qE "EulerOS|openEuler|hce" /etc/os-release 2>/dev/null; then echo "Detected EulerOS/openEuler on $ARCH, installing Node.js $NODE_VER for $NODE_ARCH..." && rm -rf /usr/local/node-v* /usr/local/bin/node /usr/local/bin/npm 2>/dev/null && (curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$NODE_ARCH.tar.xz" -o /tmp/node.tar.xz || curl -fsSL "https://npmmirror.com/mirrors/node/$NODE_VER/node-$NODE_VER-$NODE_ARCH.tar.xz" -o /tmp/node.tar.xz) && tar -xJf /tmp/node.tar.xz -C /usr/local && rm /tmp/node.tar.xz && ln -sf /usr/local/node-$NODE_VER-$NODE_ARCH/bin/node /usr/local/bin/node && ln -sf /usr/local/node-$NODE_VER-$NODE_ARCH/bin/npm /usr/local/bin/npm; elif command -v apk > /dev/null 2>&1; then apk add nodejs npm; else echo "Unsupported OS: $(cat /etc/os-release 2>/dev/null | head -1)" && exit 1; fi`

        const nodeInstallResult = await manager.executeCommandFull(installNodeCmd)
        if (nodeInstallResult.stdout.trim()) {
          this.emitCommandOutput(id, 'output', nodeInstallResult.stdout.trim())
        }
        if (nodeInstallResult.exitCode !== 0) {
          this.emitCommandOutput(id, 'error', `Failed to install Node.js: ${nodeInstallResult.stderr}`)
          throw new Error(`Failed to install Node.js: ${nodeInstallResult.stderr}`)
        }

        // Configure npm to use Chinese mirror after installation
        await manager.executeCommand('npm config set registry https://registry.npmmirror.com')

        this.emitCommandOutput(id, 'success', 'Node.js installed successfully')
      }

      // Check if npm is installed (usually comes with Node.js)
      console.log('[RemoteDeployService] Checking npm installation...')
      this.emitCommandOutput(id, 'command', 'npm --version')
      try {
        const npmVersion = await manager.executeCommandFull('npm --version')
        console.log(`[RemoteDeployService] npm version: ${npmVersion.stdout.trim()}`)
        this.emitCommandOutput(id, 'output', npmVersion.stdout.trim())
      } catch {
        // npm not found - this shouldn't happen if Node.js was just installed
        this.emitCommandOutput(id, 'error', 'npm is not installed. This should not happen after Node.js installation.')
        throw new Error('npm is not installed on the remote server. Please reinstall Node.js.')
      }

      // Install Claude CLI globally (required for SDK to work)
      console.log('[RemoteDeployService] Checking Claude CLI installation...')
      this.emitCommandOutput(id, 'command', 'claude --version')
      try {
        const claudeVersion = await manager.executeCommandFull('claude --version')
        console.log(`[RemoteDeployService] Claude CLI version: ${claudeVersion.stdout.trim()}`)
        this.emitCommandOutput(id, 'output', `Claude CLI: ${claudeVersion.stdout.trim()}`)
      } catch {
        // Claude CLI not installed, install it
        console.log('[RemoteDeployService] Claude CLI not found, installing...')
        this.emitCommandOutput(id, 'command', 'npm install -g @anthropic-ai/claude-code')
        const claudeInstallResult = await manager.executeCommandFull('npm install -g @anthropic-ai/claude-code')
        if (claudeInstallResult.stdout.trim()) {
          this.emitCommandOutput(id, 'output', claudeInstallResult.stdout.trim())
        }
        if (claudeInstallResult.exitCode !== 0) {
          this.emitCommandOutput(id, 'error', `Failed to install Claude CLI: ${claudeInstallResult.stderr}`)
          throw new Error(`Failed to install Claude CLI: ${claudeInstallResult.stderr}`)
        }
        this.emitCommandOutput(id, 'success', 'Claude CLI installed successfully')
      }

      // Install claude-agent-sdk globally
      console.log('[RemoteDeployService] Installing @anthropic-ai/claude-agent-sdk globally...')

      // Configure npm to use Chinese mirror for faster installation
      console.log('[RemoteDeployService] Configuring npm mirror (npmmirror)...')
      await manager.executeCommand('npm config set registry https://registry.npmmirror.com')

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
