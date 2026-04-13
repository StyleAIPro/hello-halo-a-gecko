/**
 * Remote Deploy Service
 * Manages remote server configurations and deployments
 */

import { app } from 'electron'
import { SSHManager, SSHConfig } from '../remote-ssh/ssh-manager'
import { getConfig, saveConfig } from '../config.service'
import type { RemoteServer } from '../../../shared/types'
import type { InstalledSkill } from '../../../shared/skill/skill-types'
import type { SkillFileNode } from '../../../shared/skill/skill-types'
import * as fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { parse as parseYaml } from 'yaml'
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
      // Include optional fields for Claude API configuration
      workDir: config.workDir,
      claudeApiKey: config.claudeApiKey,
      claudeBaseUrl: config.claudeBaseUrl,
      claudeModel: config.claudeModel,
    }

    console.log('[RemoteDeployService] addServer - Server object before save:', JSON.stringify(server))

    this.servers.set(id, server)
    await this.saveServers()

    const shared = this.toSharedConfig(server)
    console.log('[RemoteDeployService] addServer - Shared config:', JSON.stringify(shared))
    console.log(`[RemoteDeployService] Added server: ${server.name} (${id})`)

    // Only establish SSH connection, do NOT auto-deploy
    // Deployment is handled separately via "Update Agent" button
    try {
      await this.connectServer(id)
      console.log(`[RemoteDeployService] Server ${server.name} connected (deployment skipped - use Update Agent)`)
    } catch (error) {
      console.error('[RemoteDeployService] Connection failed:', error)
      await this.updateServer(id, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      })
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
   * Note: If password is not provided or empty, the original password is preserved
   * Handles both direct RemoteServerConfig updates and IPC calls with RemoteServer format
   */
  async updateServer(id: string, updates: Partial<Omit<RemoteServerConfig, 'id'>> & Record<string, any>): Promise<void> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    const originalPassword = server.ssh?.password
    let processedUpdates = { ...updates }

    // Handle password field from IPC (flat RemoteServer format)
    // If updates has top-level 'password' field, we need to handle it specially
    if ('password' in updates && !('ssh' in updates)) {
      const newPassword = updates.password
      if (newPassword && newPassword.trim() !== '') {
        // Non-empty password: update ssh config
        processedUpdates = {
          ...updates,
          ssh: {
            ...server.ssh,
            host: updates.host ?? server.ssh.host,
            port: updates.sshPort ?? server.ssh.port,
            username: updates.username ?? server.ssh.username,
            password: newPassword,
          }
        }
        console.log(`[RemoteDeployService] Updating password for server ${server.name}`)
      } else {
        // Empty or missing password: preserve original, update other ssh fields
        processedUpdates = {
          ...updates,
          ssh: {
            ...server.ssh,
            host: updates.host ?? server.ssh.host,
            port: updates.sshPort ?? server.ssh.port,
            username: updates.username ?? server.ssh.username,
            password: originalPassword, // Preserve original
          }
        }
        console.log(`[RemoteDeployService] Preserving original password for server ${server.name}`)
      }
      // Remove flat fields that are now in ssh
      delete processedUpdates.password
      delete processedUpdates.host
      delete processedUpdates.sshPort
      delete processedUpdates.username
    }
    // Handle ssh.password directly (RemoteServerConfig format)
    else if (updates.ssh && 'password' in updates.ssh) {
      const newPassword = updates.ssh.password
      if ((!newPassword || newPassword.trim() === '') && originalPassword) {
        processedUpdates.ssh = {
          ...updates.ssh,
          password: originalPassword,
        }
        console.log(`[RemoteDeployService] Preserving original password for server ${server.name} (ssh.password)`)
      }
    }

    this.servers.set(id, { ...server, ...processedUpdates })
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

      // Register this PC's token to the remote whitelist (tokens.json)
      // This ensures the PC can authenticate when connecting via WebSocket
      try {
        console.log(`[RemoteDeployService] Ensuring local token is in remote whitelist...`)
        await this.registerTokenOnRemote(id)
      } catch (error) {
        console.warn(`[RemoteDeployService] Failed to register token (non-fatal):`, error)
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

      // Create ~/.agents/skills directory for skill storage (shared with local AICO-Bot)
      this.emitDeployProgress(id, 'prepare', '正在创建 skills 目录...', 12)
      await manager.executeCommand(`mkdir -p ~/.agents/skills`)
      await manager.executeCommand(`mkdir -p ~/.agents/claude-config`)

      // Get the path to the remote-agent-proxy package
      const packageDir = getRemoteAgentProxyPath()
      const distDir = path.join(packageDir, 'dist')

      // Check if dist directory exists
      if (!fs.existsSync(distDir)) {
        throw new Error(`Remote agent proxy not built. Run 'npm run build' in packages/remote-agent-proxy first. (looked at: ${distDir})`)
      }

      // Upload package.json
      this.emitDeployProgress(id, 'upload', '正在上传 package.json...', 15)
      const packageJsonPath = path.join(packageDir, 'package.json')
      if (fs.existsSync(packageJsonPath)) {
        await manager.uploadFile(packageJsonPath, `${DEPLOY_AGENT_PATH}/package.json`)
      }

      // Upload all files from dist directory recursively (including subdirectories like proxy-apps/)
      const distFiles = this.readdirRecursive(distDir)
      let uploadedCount = 0
      for (const file of distFiles) {
        const localPath = path.join(distDir, file)
        const remotePath = `${DEPLOY_AGENT_PATH}/dist/${file}`
        uploadedCount++
        const progress = 15 + Math.round((uploadedCount / distFiles.length) * 20)
        this.emitDeployProgress(id, 'upload', `正在上传 ${file}...`, progress)
        // Ensure remote subdirectory exists before uploading
        const remoteDir = path.dirname(remotePath)
        await manager.executeCommand(`mkdir -p "${remoteDir}"`)
        await manager.uploadFile(localPath, remotePath)
      }

      // Also upload version.json to the root deployment path for easy access
      const versionJsonPath = path.join(distDir, 'version.json')
      if (fs.existsSync(versionJsonPath)) {
        this.emitDeployProgress(id, 'upload', '正在上传版本信息...', 38)
        await manager.uploadFile(versionJsonPath, `${DEPLOY_AGENT_PATH}/version.json`)
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

      // Upload scripts directory (register-token.js etc.)
      const scriptsDir = path.join(packageDir, 'scripts')
      if (fs.existsSync(scriptsDir)) {
        this.emitDeployProgress(id, 'upload', '正在上传辅助脚本...', 41)
        await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/scripts`)
        const scriptFiles = fs.readdirSync(scriptsDir)
        for (const file of scriptFiles) {
          const localPath = path.join(scriptsDir, file)
          if (fs.statSync(localPath).isFile()) {
            await manager.uploadFile(localPath, `${DEPLOY_AGENT_PATH}/scripts/${file}`)
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
        const installNodeCmd = `ARCH=$(uname -m) && NODE_ARCH=$([ "$ARCH" = "aarch64" ] && echo "linux-arm64" || echo "linux-x64") && NODE_VER="v20.18.1" && if node --version > /dev/null 2>&1; then echo "Node.js already installed and working"; elif [ -f /etc/debian_version ]; then curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs; elif [ -f /etc/redhat-release ]; then curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs; elif grep -qE "EulerOS|openEuler|hce" /etc/os-release 2>/dev/null; then echo "Detected EulerOS/openEuler on $ARCH, installing Node.js $NODE_VER for $NODE_ARCH..." && rm -rf /usr/local/node-v* /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx 2>/dev/null && (curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$NODE_ARCH.tar.xz" -o /tmp/node.tar.xz || curl -fsSL "https://npmmirror.com/mirrors/node/$NODE_VER/node-$NODE_VER-$NODE_ARCH.tar.xz" -o /tmp/node.tar.xz) && tar -xJf /tmp/node.tar.xz -C /usr/local && rm /tmp/node.tar.xz && ln -sf /usr/local/node-$NODE_VER-$NODE_ARCH/bin/node /usr/local/bin/node && ln -sf /usr/local/node-$NODE_VER-$NODE_ARCH/bin/npm /usr/local/bin/npm && ln -sf /usr/local/node-$NODE_VER-$NODE_ARCH/bin/npx /usr/local/bin/npx; elif command -v apk > /dev/null 2>&1; then apk add nodejs npm; else echo "Unsupported OS: $(cat /etc/os-release 2>/dev/null | head -1)" && exit 1; fi`

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

      // Check if npm is installed (usually comes with Node.js)
      this.emitDeployProgress(id, 'install', '检查 npm 安装...', 44)
      this.emitCommandOutput(id, 'command', 'npm --version')
      const npmCheck = await manager.executeCommandFull('npm --version')
      if (npmCheck.exitCode !== 0 || !npmCheck.stdout.trim()) {
        this.emitCommandOutput(id, 'error', 'npm is not installed')
        throw new Error('npm is not installed on the remote server')
      }
      this.emitCommandOutput(id, 'output', `npm: ${npmCheck.stdout.trim()}`)

      // Check if npx is installed (usually comes with Node.js, but may be missing in some installations)
      this.emitDeployProgress(id, 'install', '检查 npx 安装...', 45)
      this.emitCommandOutput(id, 'command', 'npx --version')
      try {
        const npxCheck = await manager.executeCommandFull('npx --version')
        if (npxCheck.exitCode === 0 && npxCheck.stdout.trim()) {
          this.emitCommandOutput(id, 'output', `npx: ${npxCheck.stdout.trim()}`)
        } else {
          throw new Error('npx not found')
        }
      } catch {
        // npx not found - install it using npm
        console.log('[RemoteDeployService] npx not found, installing...')
        this.emitCommandOutput(id, 'command', 'npm install -g npx --force')
        this.emitDeployProgress(id, 'install', 'npx 未安装，正在自动安装...', 46)
        const npxInstallResult = await manager.executeCommandFull('npm install -g npx --force')
        if (npxInstallResult.stdout.trim()) {
          this.emitCommandOutput(id, 'output', npxInstallResult.stdout.trim())
        }
        if (npxInstallResult.exitCode !== 0 && !npxInstallResult.stderr.includes('EEXIST')) {
          this.emitCommandOutput(id, 'error', `Failed to install npx: ${npxInstallResult.stderr}`)
          throw new Error(`Failed to install npx: ${npxInstallResult.stderr}`)
        }
        this.emitCommandOutput(id, 'success', 'npx installed successfully')

        // STEP 1: Clean up old standalone npx package FIRST (causes cb.apply errors with npm 10.x)
        // Modern npm (v10+) includes npx built-in, standalone npx package conflicts with it
        console.log('[RemoteDeployService] Checking for standalone npx package...')
        const checkStandaloneNpx = await manager.executeCommandFull('npm list -g npx 2>/dev/null || echo "NOT_FOUND"')
        if (checkStandaloneNpx.stdout.includes('npx@') && !checkStandaloneNpx.stdout.includes('npm@')) {
          console.log('[RemoteDeployService] Found standalone npx package, removing...')
          const removeStandaloneCmd = 'npm uninstall -g npx 2>/dev/null || true'
          await manager.executeCommandFull(removeStandaloneCmd)
          this.emitCommandOutput(id, 'output', 'Removed standalone npx package (using npm built-in npx)')
        }

        // STEP 2: Clean npm cache to prevent cb.apply errors
        await manager.executeCommand('npm cache clean --force 2>/dev/null || true')

        // STEP 3: After cleanup, verify npx is in PATH and create/fix symlink
        try {
          // Get npm prefix to find the correct npx location
          const npmPrefixResult = await manager.executeCommandFull('npm config get prefix')
          const npmPrefix = npmPrefixResult.stdout.trim() || '/usr/local'

          // Find and create/fix symlink - always do this to ensure correct path
          const findAndLinkCmd = `
            NPX_BIN=""
            # Try npm prefix location first (npm built-in npx)
            if [ -f "${npmPrefix}/bin/npx" ]; then
              NPX_BIN="${npmPrefix}/bin/npx"
            # Try node installation directory
            elif [ -f "/usr/local/node-v20.18.1-linux-arm64/bin/npx" ]; then
              NPX_BIN="/usr/local/node-v20.18.1-linux-arm64/bin/npx"
            # Fallback: search for npx
            else
              NPX_BIN=$(find /usr/local -name npx -type f 2>/dev/null | head -1)
            fi
            if [ -n "$NPX_BIN" ] && [ -x "$NPX_BIN" ]; then
              rm -f /usr/local/bin/npx
              ln -sf "$NPX_BIN" /usr/local/bin/npx
              echo "Created symlink: /usr/local/bin/npx -> $NPX_BIN"
            else
              echo "Could not find npx binary"
              exit 1
            fi
          `
          const linkResult = await manager.executeCommandFull(findAndLinkCmd)
          if (linkResult.stdout.trim()) {
            this.emitCommandOutput(id, 'output', linkResult.stdout.trim())
          }
          if (linkResult.exitCode === 0) {
            this.emitCommandOutput(id, 'success', 'npx symlink created in /usr/local/bin')
          }

          // STEP 4: Verify npx works correctly after all fixes
          const verifyNpxCmd = await manager.executeCommandFull('npx --version 2>&1')
          if (verifyNpxCmd.exitCode === 0 && verifyNpxCmd.stdout.trim()) {
            this.emitCommandOutput(id, 'output', `npx version: ${verifyNpxCmd.stdout.trim()}`)
          } else if (verifyNpxCmd.stdout.includes('Error') || verifyNpxCmd.exitCode !== 0) {
            // npx still broken - try alternative approach: use npm exec instead
            console.log('[RemoteDeployService] npx still not working, creating alternative wrapper...')
            const createWrapperCmd = `
              cat > /usr/local/bin/npx << 'WRAPPER'
#!/bin/sh
exec node "${npmPrefix}/lib/node_modules/npm/bin/npx-cli.js" "$@"
WRAPPER
              chmod +x /usr/local/bin/npx
            `
            await manager.executeCommandFull(createWrapperCmd)
            this.emitCommandOutput(id, 'output', 'Created npx wrapper script')
          }
        } catch (linkError) {
          console.warn('[RemoteDeployService] Failed to create npx symlink:', linkError)
          // Don't throw - continue with deployment
        }
      }

      // Install dependencies on remote server
      this.emitDeployProgress(id, 'install', '正在配置 npm 镜像...', 50)
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
        `cd ${DEPLOY_AGENT_PATH} && export PATH="/usr/local/bin:/usr/local/node-v*/bin:$PATH" && npm install --legacy-peer-deps 2>&1`,
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
        'export PATH="/usr/local/bin:/usr/local/node-v*/bin:$PATH" && npm install -g @anthropic-ai/claude-agent-sdk 2>&1',
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
      // Only upload sdk.mjs when a patch file exists — uploading an unpatched sdk.mjs
      // from a different version would cause protocol mismatch with the remote CLI.
      this.emitDeployProgress(id, 'sdk', '正在上传本地 SDK 补丁...', 80)
      const projectRoot = app.isPackaged ? process.resourcesPath : app.getAppPath()
      const localSdkPath = path.join(projectRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
      const remoteSdkPath = `${DEPLOY_AGENT_PATH}/node_modules/@anthropic-ai/claude-agent-sdk`

      const hasPatch = fs.existsSync(patchesDir) &&
        fs.readdirSync(patchesDir).some((f: string) => f.endsWith('.patch'))

      if (hasPatch && fs.existsSync(path.join(localSdkPath, 'sdk.mjs'))) {
        await manager.executeCommand(`mkdir -p ${remoteSdkPath}`)
        const localSdkFile = path.join(localSdkPath, 'sdk.mjs')
        await manager.uploadFile(localSdkFile, `${remoteSdkPath}/sdk.mjs`)
        this.emitCommandOutput(id, 'success', '✓ SDK 补丁上传完成')
      } else if (!hasPatch) {
        this.emitCommandOutput(id, 'output', '无 SDK 补丁，使用远程 npm 安装版本')
      } else {
        this.emitCommandOutput(id, 'output', '! 本地 SDK 补丁未找到，跳过上传')
      }

      // Sync system prompt to remote server
      this.emitDeployProgress(id, 'sync', '正在同步系统提示词...', 90)
      await this.syncSystemPrompt(id)

      // Restart agent to apply changes
      // CRITICAL: Check if there are active sessions before restarting
      // If a session is in-flight (e.g., long-running script, docker pull), skip restart to avoid interruption
      this.emitDeployProgress(id, 'restart', '检查 Agent 状态...', 95)
      try {
        const manager = this.getSSHManager(id)
        const healthPort = (server.wsPort || 8080) + 1

        // Check if agent is running and get active session count via HTTP health endpoint
        const checkHealthCmd = `curl -s --connect-timeout 2 http://localhost:${healthPort}/health 2>/dev/null || echo '{}'`
        const healthCheck = await manager.executeCommandFull(checkHealthCmd)

        let hasActiveSessions = false
        let agentRunning = false
        let activeSessionCount = 0

        try {
          const healthData = JSON.parse(healthCheck.stdout || '{}')
          if (healthData.status === 'ok') {
            agentRunning = true
            activeSessionCount = healthData.activeSessions || 0
            hasActiveSessions = activeSessionCount > 0
          }
        } catch (e) {
          agentRunning = false
        }

        if (hasActiveSessions) {
          this.emitCommandOutput(id, 'output', `⚠️ 检测到 ${activeSessionCount} 个活跃会话，跳过重启以避免中断`)
          this.emitCommandOutput(id, 'output', '提示：代码已更新，将在所有会话完成后手动重启生效')
        } else if (agentRunning) {
          await this.stopAgent(id)
          await new Promise(resolve => setTimeout(resolve, 1000))
          await this.startAgent(id)
          this.emitCommandOutput(id, 'success', '✓ Agent 重启成功')
        } else {
          await this.startAgent(id)
          this.emitCommandOutput(id, 'success', '✓ Agent 已启动')
        }
      } catch (restartError) {
        this.emitCommandOutput(id, 'error', `! Agent 重启失败：${restartError}`)
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
   * Fast update: only upload changed files, skip full environment setup.
   * Falls back to full deployAgentCode() if this is the first deployment.
   */
  async updateAgentCode(id: string): Promise<void> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    const manager = this.getSSHManager(id)

    // Ensure SSH connection
    if (!manager.isConnected()) {
      this.emitDeployProgress(id, 'connect', `正在连接到 ${server.name}...`, 5)
      await this.connectServer(id)
      const connectedManager = this.getSSHManager(id)
      if (!connectedManager.isConnected()) {
        throw new Error(`Failed to establish SSH connection to ${server.name}`)
      }
    }

    // Check if this is the first deployment or a broken deployment.
    // Verify both version.json exists AND npm/node are functional — a partial
    // previous deployment may have uploaded files but never installed Node.js.
    const firstDeployCheck = await manager.executeCommandFull(
      `test -f ${DEPLOY_AGENT_PATH}/version.json && export PATH="/usr/local/bin:/usr/local/node-v*/bin:$PATH" && command -v npm >/dev/null 2>&1 && echo "DEPLOYED" || echo "NOT_DEPLOYED"`
    )

    if (!firstDeployCheck.stdout.includes('DEPLOYED')) {
      this.emitCommandOutput(id, 'output', '首次部署或环境不完整，执行完整安装...')
      this.emitDeployProgress(id, 'prepare', '首次部署中...', 10)
      return this.deployAgentCode(id)
    }

    // --- Incremental update path ---
    this.emitCommandOutput(id, 'command', '增量更新模式 (跳过环境初始化)')

    // Ensure remote directories exist (in case of partial/broken previous deployment)
    this.emitCommandOutput(id, 'output', '正在检查远程目录...')
    await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/dist`)
    await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/patches`)
    await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/config`)
    await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/logs`)
    await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/scripts`)

    // Detect npm path: SSH exec runs non-login/non-interactive shell,
    // so .bashrc/.profile are not sourced and npm may not be in PATH.
    const npmPathDetect = await manager.executeCommandFull(
      `export PATH="/usr/local/bin:/usr/local/node-v*/bin:$PATH" && which npm 2>/dev/null || echo ""`
    )
    const npmCmd = npmPathDetect.stdout.trim()

    if (!npmCmd) {
      // npm not found — deployment environment is broken, fall back to full install
      this.emitCommandOutput(id, 'output', 'npm 未找到，回退到完整安装...')
      this.emitDeployProgress(id, 'prepare', '环境不完整，执行完整安装...', 10)
      return this.deployAgentCode(id)
    }

    const npmPathPrefix = `export PATH="/usr/local/bin:/usr/local/node-v*/bin:$PATH" && `

    this.emitDeployProgress(id, 'upload', '正在检查文件变更...', 10)

    const packageDir = getRemoteAgentProxyPath()
    const distDir = path.join(packageDir, 'dist')
    const patchesDir = path.join(packageDir, 'patches')

    // 1. Upload changed dist files (recursive to include subdirectories like proxy-apps/)
    let changedFiles = 0
    const distFiles = this.readdirRecursive(distDir)
    for (let i = 0; i < distFiles.length; i++) {
      const file = distFiles[i]
      const localPath = path.join(distDir, file)
      const remotePath = `${DEPLOY_AGENT_PATH}/dist/${file}`
      const progress = 10 + Math.round(((i + 1) / distFiles.length) * 20)
      this.emitDeployProgress(id, 'upload', `正在检查 ${file}...`, progress)

      // Compare md5 with remote
      const localMd5 = this.computeMd5(localPath)
      const remoteMd5Result = await manager.executeCommandFull(`md5sum ${remotePath} 2>/dev/null | awk '{print $1}' || echo ""`)
      const remoteMd5 = remoteMd5Result.stdout.trim()

      if (localMd5 !== remoteMd5) {
        // Ensure remote subdirectory exists before uploading
        const remoteDir = path.dirname(remotePath)
        await manager.executeCommand(`mkdir -p "${remoteDir}"`)
        await manager.uploadFile(localPath, remotePath)
        changedFiles++
        this.emitCommandOutput(id, 'output', `  ↑ ${file} (已更新)`)
      }
    }
    this.emitCommandOutput(id, 'output', `dist 文件: ${changedFiles}/${distFiles.length} 已更新`)

    // Also upload version.json to root
    const versionJsonPath = path.join(distDir, 'version.json')
    if (fs.existsSync(versionJsonPath)) {
      const localMd5 = this.computeMd5(versionJsonPath)
      const remoteMd5Result = await manager.executeCommandFull(`md5sum ${DEPLOY_AGENT_PATH}/version.json 2>/dev/null | awk '{print $1}' || echo ""`)
      if (localMd5 !== remoteMd5Result.stdout.trim()) {
        await manager.uploadFile(versionJsonPath, `${DEPLOY_AGENT_PATH}/version.json`)
      }
    }

    // 2. Upload package.json and check if npm install is needed
    this.emitDeployProgress(id, 'install', '正在检查依赖变更...', 35)
    const packageJsonPath = path.join(packageDir, 'package.json')
    const localPkgMd5 = this.computeMd5(packageJsonPath)
    const remotePkgMd5Result = await manager.executeCommandFull(`md5sum ${DEPLOY_AGENT_PATH}/package.json 2>/dev/null | awk '{print $1}' || echo ""`)

    if (localPkgMd5 !== remotePkgMd5Result.stdout.trim()) {
      // package.json changed → npm install needed
      await manager.uploadFile(packageJsonPath, `${DEPLOY_AGENT_PATH}/package.json`)
      this.emitCommandOutput(id, 'output', 'package.json 已变更，执行 npm install...')
      this.emitDeployProgress(id, 'install', '正在安装依赖 (npm install)...', 40)

      const installResult = await manager.executeCommandStreaming(
        `cd ${DEPLOY_AGENT_PATH} && ${npmPathPrefix}npm install --legacy-peer-deps 2>&1`,
        (type, data) => {
          const lines = data.split('\n').filter(line => line.trim())
          for (const line of lines) {
            this.emitCommandOutput(id, type === 'stderr' ? 'error' : 'output', line)
          }
        }
      )

      if (installResult.exitCode !== 0) {
        this.emitCommandOutput(id, 'error', `npm install 失败: ${installResult.stderr || installResult.stdout}`)
        throw new Error(`npm install failed: ${installResult.stderr || installResult.stdout}`)
      }
      this.emitCommandOutput(id, 'success', '✓ 依赖安装完成')
    } else {
      // package.json unchanged — verify node_modules integrity before skipping npm install
      const depsMissing = await this.checkRemoteDependencies(id, manager, packageJsonPath)
      if (depsMissing) {
        this.emitCommandOutput(id, 'output', `检测到缺失依赖: ${depsMissing}，执行 npm install...`)
        this.emitDeployProgress(id, 'install', '正在修复依赖 (npm install)...', 40)

        const repairResult = await manager.executeCommandStreaming(
          `cd ${DEPLOY_AGENT_PATH} && ${npmPathPrefix}npm install --legacy-peer-deps 2>&1`,
          (type, data) => {
            const lines = data.split('\n').filter(line => line.trim())
            for (const line of lines) {
              this.emitCommandOutput(id, type === 'stderr' ? 'error' : 'output', line)
            }
          }
        )

        if (repairResult.exitCode !== 0) {
          this.emitCommandOutput(id, 'error', `npm install 失败: ${repairResult.stderr || repairResult.stdout}`)
          throw new Error(`npm install failed: ${repairResult.stderr || repairResult.stdout}`)
        }
        this.emitCommandOutput(id, 'success', '✓ 依赖修复完成')
      } else {
        this.emitCommandOutput(id, 'output', 'package.json 未变更，依赖完整，跳过 npm install')
      }
    }

    // 3. Check if global SDK needs updating
    this.emitDeployProgress(id, 'install', '正在检查 SDK 版本...', 55)
    const localVersionInfo = this.getLocalAgentVersion()
    if (localVersionInfo?.version) {
      const remoteVersionResult = await manager.executeCommandFull(
        `${npmPathPrefix}${AGENT_CHECK_COMMAND} | grep -oP 'claude-agent-sdk@\\K[^\\s]+' || echo ""`
      )
      const remoteSdkVersion = remoteVersionResult.stdout.trim()
      if (remoteSdkVersion && remoteSdkVersion !== localVersionInfo.version) {
        this.emitCommandOutput(id, 'output', `SDK 版本变更: ${remoteSdkVersion} → ${localVersionInfo.version}`)
        this.emitDeployProgress(id, 'install', '正在更新 SDK...', 57)
        await manager.executeCommandStreaming(
          `${npmPathPrefix}npm install -g @anthropic-ai/claude-agent-sdk 2>&1`,
          (type, data) => {
            const lines = data.split('\n').filter(line => line.trim())
            for (const line of lines) {
              this.emitCommandOutput(id, type === 'stderr' ? 'error' : 'output', line)
            }
          }
        )
      } else {
        this.emitCommandOutput(id, 'output', 'SDK 版本未变更，跳过全局安装')
      }
    }

    // 4. Upload local patched SDK (if changed)
    // Only upload sdk.mjs when a patch file exists — uploading an unpatched sdk.mjs
    // from a different version would cause protocol mismatch with the remote CLI.
    this.emitDeployProgress(id, 'sdk', '正在检查 SDK 补丁...', 65)
    const projectRoot = app.isPackaged ? process.resourcesPath : app.getAppPath()
    const localSdkPath = path.join(projectRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
    const remoteSdkPath = `${DEPLOY_AGENT_PATH}/node_modules/@anthropic-ai/claude-agent-sdk`
    const localSdkFile = path.join(localSdkPath, 'sdk.mjs')

    const hasPatch = fs.existsSync(patchesDir) &&
      fs.readdirSync(patchesDir).some((f: string) => f.endsWith('.patch'))

    if (hasPatch && fs.existsSync(localSdkFile)) {
      const localSdkMd5 = this.computeMd5(localSdkFile)
      const remoteSdkMd5Result = await manager.executeCommandFull(`md5sum ${remoteSdkPath}/sdk.mjs 2>/dev/null | awk '{print $1}' || echo ""`)
      if (localSdkMd5 !== remoteSdkMd5Result.stdout.trim()) {
        await manager.executeCommand(`mkdir -p ${remoteSdkPath}`)
        await manager.uploadFile(localSdkFile, `${remoteSdkPath}/sdk.mjs`)
        this.emitCommandOutput(id, 'output', 'SDK 补丁已更新')
      } else {
        this.emitCommandOutput(id, 'output', 'SDK 补丁未变更，跳过上传')
      }
    } else if (!hasPatch) {
      this.emitCommandOutput(id, 'output', '无 SDK 补丁，使用远程 npm 安装版本')
    }

    // 5. Upload patches (if changed)
    if (fs.existsSync(patchesDir)) {
      const patchFiles = fs.readdirSync(patchesDir)
      let patchChanged = 0
      for (const file of patchFiles) {
        const localPath = path.join(patchesDir, file)
        if (fs.statSync(localPath).isFile()) {
          const localMd5 = this.computeMd5(localPath)
          const remoteMd5Result = await manager.executeCommandFull(`md5sum ${DEPLOY_AGENT_PATH}/patches/${file} 2>/dev/null | awk '{print $1}' || echo ""`)
          if (localMd5 !== remoteMd5Result.stdout.trim()) {
            await manager.uploadFile(localPath, `${DEPLOY_AGENT_PATH}/patches/${file}`)
            patchChanged++
          }
        }
      }
      if (patchChanged > 0) {
        this.emitCommandOutput(id, 'output', `patches: ${patchChanged} 个文件已更新`)
      }
    }

    // 6. Upload scripts (register-token.js etc.)
    const scriptsDir = path.join(packageDir, 'scripts')
    if (fs.existsSync(scriptsDir)) {
      const scriptFiles = fs.readdirSync(scriptsDir)
      let scriptChanged = 0
      await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/scripts`)
      for (const file of scriptFiles) {
        const localPath = path.join(scriptsDir, file)
        if (fs.statSync(localPath).isFile()) {
          const localMd5 = this.computeMd5(localPath)
          const remoteMd5Result = await manager.executeCommandFull(`md5sum ${DEPLOY_AGENT_PATH}/scripts/${file} 2>/dev/null | awk '{print $1}' || echo ""`)
          if (localMd5 !== remoteMd5Result.stdout.trim()) {
            await manager.uploadFile(localPath, `${DEPLOY_AGENT_PATH}/scripts/${file}`)
            scriptChanged++
          }
        }
      }
      if (scriptChanged > 0) {
        this.emitCommandOutput(id, 'output', `scripts: ${scriptChanged} 个文件已更新`)
      }
    }

    // 7. Sync system prompt
    this.emitDeployProgress(id, 'sync', '正在同步系统提示词...', 75)
    await this.syncSystemPrompt(id)

    // 8. Register this PC's auth token to the remote whitelist (tokens.json)
    // This ensures the token whitelist is created/updated even during incremental updates
    try {
      this.emitDeployProgress(id, 'token', '正在注册认证令牌...', 85)
      await this.registerTokenOnRemote(id)
      this.emitCommandOutput(id, 'success', '✓ 认证令牌已注册到白名单')
    } catch (tokenError) {
      this.emitCommandOutput(id, 'error', `⚠️ 令牌注册失败（非致命）：${tokenError}`)
    }

    // 9. Restart agent to apply changes (same logic as deployAgentCode)
    this.emitDeployProgress(id, 'restart', '检查 Agent 状态...', 90)
    try {
      const healthPort = (server.wsPort || 8080) + 1
      const checkHealthCmd = `curl -s --connect-timeout 2 http://localhost:${healthPort}/health 2>/dev/null || echo '{}'`
      const healthCheck = await manager.executeCommandFull(checkHealthCmd)

      let hasActiveSessions = false
      let agentRunning = false
      let activeSessionCount = 0

      try {
        const healthData = JSON.parse(healthCheck.stdout || '{}')
        if (healthData.status === 'ok') {
          agentRunning = true
          activeSessionCount = healthData.activeSessions || 0
          hasActiveSessions = activeSessionCount > 0
        }
      } catch (e) {
        agentRunning = false
      }

      if (hasActiveSessions) {
        this.emitCommandOutput(id, 'output', `⚠️ 检测到 ${activeSessionCount} 个活跃会话，跳过重启以避免中断`)
        this.emitCommandOutput(id, 'output', '提示：代码已更新，将在所有会话完成后手动重启生效')
      } else if (agentRunning) {
        await this.stopAgent(id)
        await new Promise(resolve => setTimeout(resolve, 1000))
        await this.startAgent(id)
        this.emitCommandOutput(id, 'success', '✓ Agent 重启成功')
      } else {
        await this.startAgent(id)
        this.emitCommandOutput(id, 'success', '✓ Agent 已启动')
      }
    } catch (restartError) {
      this.emitCommandOutput(id, 'error', `⚠️ Agent 重启失败：${restartError}`)
      // Don't throw - the code was deployed successfully
    }

    this.emitDeployProgress(id, 'complete', '✓ 更新完成!', 100)
    this.emitCommandOutput(id, 'success', '========================================')
    this.emitCommandOutput(id, 'success', '增量更新完成!')
    this.emitCommandOutput(id, 'success', '========================================')
  }

  /**
   * Compute MD5 hash of a local file
   */
  private computeMd5(filePath: string): string {
    return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex')
  }

  /**
   * Recursively list all files in a directory, returning POSIX-style relative paths.
   * Always uses forward slashes even on Windows, since remote servers are Linux.
   * e.g. ['index.js', 'proxy-apps/index.js', 'proxy-apps/manager.js']
   */
  private readdirRecursive(dir: string): string[] {
    const results: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        for (const sub of this.readdirRecursive(path.join(dir, entry.name))) {
          results.push(`${entry.name}/${sub}`)
        }
      } else {
        results.push(entry.name)
      }
    }
    return results
  }

  /**
   * Check if all dependencies listed in local package.json are resolvable on the remote server.
   * Returns comma-separated list of missing package names, or null if all present.
   */
  private async checkRemoteDependencies(
    id: string,
    manager: any,
    localPackageJsonPath: string
  ): Promise<string | null> {
    try {
      const pkg = JSON.parse(fs.readFileSync(localPackageJsonPath, 'utf-8'))
      const deps = Object.keys(pkg.dependencies || {})
      if (deps.length === 0) return null

      // Build a shell one-liner that probes each dependency via node -e "require.resolve()"
      const checks = deps.map(
        (name: string) => `node -e "require.resolve('${name}')" 2>/dev/null || echo "MISSING:${name}"`
      ).join(' && ')

      const result = await manager.executeCommandFull(
        `cd ${DEPLOY_AGENT_PATH} && (${checks}) 2>/dev/null`
      )

      const missing = (result.stdout || '').match(/MISSING:(\S+)/g)
      if (missing && missing.length > 0) {
        const names = missing.map((m: string) => m.replace('MISSING:', ''))
        console.log(`[RemoteDeployService] Missing dependencies on remote: ${names.join(', ')}`)
        return names.join(', ')
      }
      return null
    } catch (e) {
      // If check itself fails (e.g., SSH error), be conservative and trigger npm install
      console.warn('[RemoteDeployService] Dependency check failed, will run npm install:', e)
      return 'check-error'
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

    // Read and display build info before starting
    try {
      const versionJsonResult = await manager.executeCommandFull(`cat ${DEPLOY_AGENT_PATH}/dist/version.json 2>/dev/null || echo ""`)
      if (versionJsonResult.stdout.trim()) {
        const buildInfo = JSON.parse(versionJsonResult.stdout)
        const buildInfoMsg = [
          '========================================',
          'Remote Agent Build Info:',
          `  Version: ${buildInfo.version || 'unknown'}`,
          `  Build Time: ${buildInfo.buildTime || buildInfo.buildTimestamp || 'unknown'}`,
          `  Node: ${buildInfo.nodeVersion || 'unknown'}`,
          `  Platform: ${buildInfo.platform || 'unknown'} (${buildInfo.arch || 'unknown'})`,
          '========================================'
        ].join('\n')
        console.log('[RemoteDeployService] Remote agent build info:')
        console.log(buildInfoMsg)
        this.emitCommandOutput(id, 'output', buildInfoMsg)
      }
    } catch (e) {
      console.warn('[RemoteDeployService] Could not read remote build info:', e)
    }

    // Check if process is already running
    const checkResult = await manager.executeCommandFull(
      `pgrep -f "node.*${DEPLOY_AGENT_PATH}" || echo "not running"`
    )

    if (checkResult.exitCode === 0 && !checkResult.stdout.includes('not running')) {
      console.log('[RemoteDeployService] Agent already running, restarting...')
      await this.stopAgent(id)
    }

    // Register this PC's auth token to the remote whitelist (tokens.json)
    // This supports multiple PCs connecting to the same remote server simultaneously
    await this.registerTokenOnRemote(id)

    // Read the first token from tokens.json to use as bootstrap token for REMOTE_AGENT_AUTH_TOKEN
    // The bootstrap token ensures backward compatibility and allows at least one PC to connect
    let bootstrapToken = server.authToken
    try {
      const tokensResult = await manager.executeCommandFull(
        `node -e "const d=JSON.parse(require('fs').readFileSync('${DEPLOY_AGENT_PATH}/tokens.json','utf-8'));console.log(d.tokens[0]?.token||'')"`
      )
      if (tokensResult.exitCode === 0 && tokensResult.stdout.trim()) {
        bootstrapToken = tokensResult.stdout.trim()
        console.log(`[RemoteDeployService] Using bootstrap token from tokens.json (first of ${0})`)
      }
    } catch (e) {
      console.warn('[RemoteDeployService] Failed to read bootstrap token from tokens.json:', e)
    }

    // Start the agent server with environment variables
    const escapeEnvValue = (value: string | undefined): string => {
      if (!value) return "''"
      return `'${value.replace(/'/g, "'\\''")}'`
    }

    const envVars = [
      `REMOTE_AGENT_PORT=${server.wsPort || 8080}`,
      `REMOTE_AGENT_AUTH_TOKEN=${escapeEnvValue(bootstrapToken)}`,
      server.workDir ? `REMOTE_AGENT_WORK_DIR=${escapeEnvValue(server.workDir)}` : null,
      `IS_SANDBOX=1`,
      server.claudeApiKey ? `ANTHROPIC_API_KEY=${escapeEnvValue(server.claudeApiKey)}` : null,
      server.claudeBaseUrl ? `ANTHROPIC_BASE_URL=${escapeEnvValue(server.claudeBaseUrl)}` : null,
      server.claudeModel ? `ANTHROPIC_MODEL=${escapeEnvValue(server.claudeModel)}` : null
    ].filter(Boolean).join(' ')

    const indexPath = `${DEPLOY_AGENT_PATH}/dist/index.js`

    console.log(`[RemoteDeployService] Starting agent with env: PORT=${server.wsPort || 8080}, WORK_DIR=${server.workDir || '(not set, will use per-session workDir)'}`)

    const startCommand = `nohup env PATH="/usr/local/bin:/usr/local/node-v*/bin:$PATH" ${envVars} node ${indexPath} > ${DEPLOY_AGENT_PATH}/logs/output.log 2>&1 &`
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

      // Self-repair: if logs indicate missing dependencies, run npm install and retry once
      const missingDepPattern = /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/
      if (missingDepPattern.test(logOutput)) {
        console.log('[RemoteDeployService] Startup failed due to missing dependencies, attempting self-repair...')
        this.emitCommandOutput(id, 'output', '检测到依赖缺失，自动修复中...')

        // Stop any leftover process
        await manager.executeCommand(`pkill -f "node.*${DEPLOY_AGENT_PATH}" || true`)

        // Run npm install
        this.emitCommandOutput(id, 'output', '执行 npm install...')
        const repairResult = await manager.executeCommandStreaming(
          `cd ${DEPLOY_AGENT_PATH} && export PATH="/usr/local/bin:$PATH" && npm install --legacy-peer-deps 2>&1`,
          (type, data) => {
            const lines = data.split('\n').filter(line => line.trim())
            for (const line of lines) {
              this.emitCommandOutput(id, type === 'stderr' ? 'error' : 'output', line)
            }
          }
        )

        if (repairResult.exitCode !== 0) {
          throw new Error(`Failed to start agent - dependency repair failed. Logs: ${logOutput.slice(0, 500)}`)
        }

        this.emitCommandOutput(id, 'success', '✓ 依赖修复完成，重新启动 agent...')

        // Retry start
        await manager.executeCommand(startCommand)
        await new Promise(resolve => setTimeout(resolve, 5000))

        const retryResult = await manager.executeCommandFull(
          `(ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep ":${port}" || echo "NOT_RUNNING"`
        )

        if (retryResult.stdout.includes('NOT_RUNNING')) {
          let retryLog = ''
          try {
            const retryLogResult = await manager.executeCommandFull(`tail -30 ${DEPLOY_AGENT_PATH}/logs/output.log 2>&1 || echo ""`)
            retryLog = retryLogResult.stdout || ''
          } catch {}

          throw new Error(`Failed to start agent after dependency repair. Logs: ${retryLog.slice(0, 500)}`)
        }

        console.log(`[RemoteDeployService] Agent started after self-repair on: ${server.name}, port ${port}`)
        return
      }

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

    // Ensure SSH connection is established before executing command
    if (!manager.isConnected()) {
      await this.connectServer(id)
    }

    // Kill any node process running from the deployment directory
    await manager.executeCommand(
      `pkill -f "node.*${DEPLOY_AGENT_PATH}" || true`
    )

    console.log(`[RemoteDeployService] Agent stopped on: ${server.name}`)
  }

  /**
   * Register this PC's auth token to the remote server's tokens.json whitelist.
   * Called during startAgent() and connectServer() to ensure the PC's token is
   * in the whitelist before connecting via WebSocket.
   */
  async registerTokenOnRemote(id: string): Promise<void> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    const manager = this.getSSHManager(id)

    // Ensure SSH connection is established
    if (!manager.isConnected()) {
      await this.connectServer(id)
    }

    const token = server.authToken
    const clientId = server.id
    const hostname = os.hostname()

    console.log(`[RemoteDeployService] Registering token for ${server.name} (clientId: ${clientId})`)

    // Call the register-token.js script on the remote server
    const scriptPath = `${DEPLOY_AGENT_PATH}/scripts/register-token.cjs`
    const registerCmd = `node ${scriptPath} '${token}' '${clientId}' '${hostname}'`

    try {
      const result = await manager.executeCommandFull(registerCmd)
      if (result.stdout.includes('TOKEN_REGISTERED')) {
        console.log(`[RemoteDeployService] Token registered on remote (clientId: ${clientId})`)
      } else if (result.stdout.includes('TOKEN_UPDATED')) {
        console.log(`[RemoteDeployService] Token updated on remote (clientId: ${clientId})`)
      } else {
        console.warn(`[RemoteDeployService] Unexpected register-token output: ${result.stdout}`)
      }
    } catch (e) {
      console.error(`[RemoteDeployService] Failed to register token on remote:`, e)
      // Don't throw - the token may already be registered from a previous session
    }
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
   * Get the local agent package version and build info
   */
  getLocalAgentVersion(): { version?: string; buildTime?: string; buildTimestamp?: string } | null {
    try {
      const packageDir = getRemoteAgentProxyPath()
      const distDir = path.join(packageDir, 'dist')

      // First try to read version.json (generated by build script)
      const versionJsonPath = path.join(distDir, 'version.json')
      if (fs.existsSync(versionJsonPath)) {
        const versionJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf-8'))
        return {
          version: versionJson.version,
          buildTime: versionJson.buildTime,
          buildTimestamp: versionJson.buildTimestamp
        }
      }

      // Fallback to reading package.json
      const packageJsonPath = path.join(packageDir, 'package.json')
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
        return {
          version: packageJson.version,
          buildTime: packageJson.buildTime,
          buildTimestamp: packageJson.buildTimestamp
        }
      }
      return null
    } catch (error) {
      console.error('[RemoteDeployService] Failed to read local agent version:', error)
      return null
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
   * Send a chat message to the remote agent via WebSocket
   * Returns response with tokenUsage for display in chat UI
   */
  async sendAgentChat(
    id: string,
    params: { sessionId?: string; content: string; attachments?: any[] }
  ): Promise<{
    response: string
    sessionId?: string
    tokenUsage?: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheCreationTokens: number
      totalCostUsd: number
      contextWindow: number
    }
  }> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    // Get the WebSocket client for this server
    const wsClient = this.getOrCreateWsClient(id, server)

    try {
      // Send chat message with streaming
      const result = await wsClient.sendChatWithStream(params.sessionId || `session-${Date.now()}`, [
        { role: 'user', content: params.content }
      ])

      return {
        response: result.content,
        sessionId: params.sessionId,
        tokenUsage: result.tokenUsage ? {
          inputTokens: result.tokenUsage.inputTokens || 0,
          outputTokens: result.tokenUsage.outputTokens || 0,
          cacheReadTokens: result.tokenUsage.cacheReadTokens || 0,
          cacheCreationTokens: result.tokenUsage.cacheCreationTokens || 0,
          totalCostUsd: result.tokenUsage.totalCostUsd || 0,
          contextWindow: result.tokenUsage.contextWindow || 200000
        } : undefined
      }
    } catch (error) {
      console.error(`[RemoteDeployService] Failed to send chat to agent:`, error)
      throw error
    }
  }

  /**
   * Subscribe to real-time task updates from a remote server.
   * Forwards task:update events to the main window via IPC.
   */
  subscribeToTaskUpdates(serverId: string): () => void {
    const { BrowserWindow } = require('electron')
    const wsClient = this.getOrCreateWsClient(serverId, this.servers.get(serverId)!)
    const handler = (data: any) => {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) {
        win.webContents.send('remote-server:task-update', { serverId, data })
      }
    }
    wsClient.on('task:update', handler)
    return () => { wsClient.off('task:update', handler) }
  }

  /**
   * List background tasks on a remote server
   */
  listRemoteTasks(serverId: string): Promise<any[]> {
    const wsClient = this.getOrCreateWsClient(serverId, this.servers.get(serverId)!)
    return new Promise((resolve, reject) => {
      const handler = (data: any) => {
        wsClient.off('task:list', handler)
        resolve(data)
      }
      wsClient.on('task:list', handler)
      wsClient.listTasks()
      // Timeout after 5s
      setTimeout(() => { wsClient.off('task:list', handler); resolve([]) }, 5000)
    })
  }

  /**
   * Cancel a background task on a remote server
   */
  cancelRemoteTask(serverId: string, taskId: string): Promise<boolean> {
    const wsClient = this.getOrCreateWsClient(serverId, this.servers.get(serverId)!)
    return new Promise((resolve, reject) => {
      const handler = (data: any) => {
        wsClient.off('task:cancel', handler)
        resolve(data?.success ?? false)
      }
      wsClient.on('task:cancel', handler)
      wsClient.cancelTask(taskId)
      setTimeout(() => { wsClient.off('task:cancel', handler); resolve(false) }, 5000)
    })
  }

  /**
   * Get or create WebSocket client for a server
   */
  private getOrCreateWsClient(id: string, server: RemoteServerConfig): any {
    // Dynamic import to avoid circular dependency
    const { RemoteWsClient } = require('../remote-ws/remote-ws-client')

    // Check if we already have a client for this server
    const existingClient = (RemoteWsClient as any).getRemoteWsClient(id)
    if (existingClient) {
      return existingClient
    }

    // Create new WebSocket client
    const wsConfig = {
      serverId: id,
      host: server.ssh.host,
      port: 8080,  // Default WebSocket port for remote-agent-proxy
      useSshTunnel: false,  // TODO: Support SSH tunneling
      authToken: server.password || ''  // Use SSH password as auth token for now
    }

    const client = new RemoteWsClient(wsConfig)
    return client
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
  async checkAgentInstalled(id: string): Promise<{ installed: boolean; version?: string; buildTime?: string }> {
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

      // Also read the deployed package.json to get build timestamp
      let buildTime: string | undefined
      try {
        const packageJsonResult = await manager.executeCommandFull(`cat ${DEPLOY_AGENT_PATH}/package.json 2>/dev/null || echo ""`)
        if (packageJsonResult.stdout.trim()) {
          const remotePackageJson = JSON.parse(packageJsonResult.stdout)
          if (remotePackageJson.buildTime) {
            buildTime = remotePackageJson.buildTime
            console.log(`[RemoteDeployService] Remote agent build time: ${buildTime}`)
          }
          if (remotePackageJson.version && !version) {
            // Use package.json version as fallback
            version = remotePackageJson.version
          }
        }
      } catch (pkgError) {
        console.warn('[RemoteDeployService] Failed to read remote package.json:', pkgError)
      }

      return { installed, version, buildTime }
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
        const installNodeCmd = `ARCH=$(uname -m) && NODE_ARCH=$([ "$ARCH" = "aarch64" ] && echo "linux-arm64" || echo "linux-x64") && NODE_VER="v20.18.1" && if node --version > /dev/null 2>&1; then echo "Node.js already installed and working"; elif [ -f /etc/debian_version ]; then curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs; elif [ -f /etc/redhat-release ]; then curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs; elif grep -qE "EulerOS|openEuler|hce" /etc/os-release 2>/dev/null; then echo "Detected EulerOS/openEuler on $ARCH, installing Node.js $NODE_VER for $NODE_ARCH..." && rm -rf /usr/local/node-v* /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx 2>/dev/null && (curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$NODE_ARCH.tar.xz" -o /tmp/node.tar.xz || curl -fsSL "https://npmmirror.com/mirrors/node/$NODE_VER/node-$NODE_VER-$NODE_ARCH.tar.xz" -o /tmp/node.tar.xz) && tar -xJf /tmp/node.tar.xz -C /usr/local && rm /tmp/node.tar.xz && ln -sf /usr/local/node-$NODE_VER-$NODE_ARCH/bin/node /usr/local/bin/node && ln -sf /usr/local/node-$NODE_VER-$NODE_ARCH/bin/npm /usr/local/bin/npm && ln -sf /usr/local/node-$NODE_VER-$NODE_ARCH/bin/npx /usr/local/bin/npx; elif command -v apk > /dev/null 2>&1; then apk add nodejs npm; else echo "Unsupported OS: $(cat /etc/os-release 2>/dev/null | head -1)" && exit 1; fi`

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

      // Check if npx is installed (usually comes with Node.js, but may be missing in some installations)
      console.log('[RemoteDeployService] Checking npx installation...')
      this.emitCommandOutput(id, 'command', 'npx --version')
      try {
        const npxVersion = await manager.executeCommandFull('npx --version')
        console.log(`[RemoteDeployService] npx version: ${npxVersion.stdout.trim()}`)
        this.emitCommandOutput(id, 'output', `npx: ${npxVersion.stdout.trim()}`)
      } catch {
        // npx not found - install it using npm
        console.log('[RemoteDeployService] npx not found, installing...')
        this.emitCommandOutput(id, 'command', 'npm install -g npx --force')
        const npxInstallResult = await manager.executeCommandFull('npm install -g npx --force')
        if (npxInstallResult.stdout.trim()) {
          this.emitCommandOutput(id, 'output', npxInstallResult.stdout.trim())
        }
        if (npxInstallResult.exitCode !== 0 && !npxInstallResult.stderr.includes('EEXIST')) {
          this.emitCommandOutput(id, 'error', `Failed to install npx: ${npxInstallResult.stderr}`)
          throw new Error(`Failed to install npx: ${npxInstallResult.stderr}`)
        }
        this.emitCommandOutput(id, 'success', 'npx installed successfully')

        // STEP 1: Clean up old standalone npx package FIRST (causes cb.apply errors with npm 10.x)
        // Modern npm (v10+) includes npx built-in, standalone npx package conflicts with it
        console.log('[RemoteDeployService] Checking for standalone npx package...')
        const checkStandaloneNpx = await manager.executeCommandFull('npm list -g npx 2>/dev/null || echo "NOT_FOUND"')
        if (checkStandaloneNpx.stdout.includes('npx@') && !checkStandaloneNpx.stdout.includes('npm@')) {
          console.log('[RemoteDeployService] Found standalone npx package, removing...')
          const removeStandaloneCmd = 'npm uninstall -g npx 2>/dev/null || true'
          await manager.executeCommandFull(removeStandaloneCmd)
          this.emitCommandOutput(id, 'output', 'Removed standalone npx package (using npm built-in npx)')
        }

        // STEP 2: Clean npm cache to prevent cb.apply errors
        await manager.executeCommand('npm cache clean --force 2>/dev/null || true')

        // STEP 3: After cleanup, verify npx is in PATH and create/fix symlink
        try {
          // Get npm prefix to find the correct npx location
          const npmPrefixResult = await manager.executeCommandFull('npm config get prefix')
          const npmPrefix = npmPrefixResult.stdout.trim() || '/usr/local'

          // Find and create/fix symlink - always do this to ensure correct path
          const findAndLinkCmd = `
            NPX_BIN=""
            # Try npm prefix location first (npm built-in npx)
            if [ -f "${npmPrefix}/bin/npx" ]; then
              NPX_BIN="${npmPrefix}/bin/npx"
            # Try node installation directory
            elif [ -f "/usr/local/node-v20.18.1-linux-arm64/bin/npx" ]; then
              NPX_BIN="/usr/local/node-v20.18.1-linux-arm64/bin/npx"
            # Fallback: search for npx
            else
              NPX_BIN=$(find /usr/local -name npx -type f 2>/dev/null | head -1)
            fi
            if [ -n "$NPX_BIN" ] && [ -x "$NPX_BIN" ]; then
              rm -f /usr/local/bin/npx
              ln -sf "$NPX_BIN" /usr/local/bin/npx
              echo "Created symlink: /usr/local/bin/npx -> $NPX_BIN"
            else
              echo "Could not find npx binary"
              exit 1
            fi
          `
          const linkResult = await manager.executeCommandFull(findAndLinkCmd)
          if (linkResult.stdout.trim()) {
            this.emitCommandOutput(id, 'output', linkResult.stdout.trim())
          }
          if (linkResult.exitCode === 0) {
            this.emitCommandOutput(id, 'success', 'npx symlink created in /usr/local/bin')
          }

          // STEP 4: Verify npx works correctly after all fixes
          const verifyNpxCmd = await manager.executeCommandFull('npx --version 2>&1')
          if (verifyNpxCmd.exitCode === 0 && verifyNpxCmd.stdout.trim()) {
            this.emitCommandOutput(id, 'output', `npx version: ${verifyNpxCmd.stdout.trim()}`)
          } else if (verifyNpxCmd.stdout.includes('Error') || verifyNpxCmd.exitCode !== 0) {
            // npx still broken - try alternative approach: use npm exec instead
            console.log('[RemoteDeployService] npx still not working, creating alternative wrapper...')
            const createWrapperCmd = `
              cat > /usr/local/bin/npx << 'WRAPPER'
#!/bin/sh
exec node "${npmPrefix}/lib/node_modules/npm/bin/npx-cli.js" "$@"
WRAPPER
              chmod +x /usr/local/bin/npx
            `
            await manager.executeCommandFull(createWrapperCmd)
            this.emitCommandOutput(id, 'output', 'Created npx wrapper script')
          }
        } catch (linkError) {
          console.warn('[RemoteDeployService] Failed to create npx symlink:', linkError)
          // Don't throw - continue with deployment
        }
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

  /**
   * List skills installed on a remote server.
   * Uses a batch SSH command to minimize round-trips.
   */
  async listRemoteSkills(id: string): Promise<InstalledSkill[]> {
    const server = this.servers.get(id)
    if (!server) {
      throw new Error(`Server not found: ${id}`)
    }

    // Ensure SSH connection (always re-fetch manager after connectServer)
    if (!this.getSSHManager(id).isConnected()) {
      await this.connectServer(id)
    }
    const manager = this.getSSHManager(id)
    if (!manager.isConnected()) {
      throw new Error(`Failed to establish SSH connection to ${server.name}`)
    }

    // Batch-read all skill metadata in one SSH command
    // NOTE: Use regular string to avoid JS template literal interpolation of shell $vars
    // For SKILL.md: output entire file content (frontmatter + body), since system_prompt
    // lives in the markdown body, not the YAML frontmatter (Claude Code native format)
    // Scans both ~/.agents/skills/ and ~/.claude/skills/
    // For duplicates, keeps the one with the most recent directory modification time
    const batchCmd = [
      'declare -A best_mtime best_dir',
      'for skills_base in ~/.agents/skills ~/.claude/skills; do',
      '  [ -d "$skills_base" ] || continue',
      '  for dir in "$skills_base"/*/; do',
      '    [ -d "$dir" ] || continue',
      '    skill=$(basename "$dir")',
      '    mtime=$(stat -c %Y "$dir" 2>/dev/null || stat -f %m "$dir" 2>/dev/null || echo 0)',
      '    if [ -z "${best_mtime[$skill]}" ] || [ "$mtime" -gt "${best_mtime[$skill]}" ]; then',
      '      best_mtime[$skill]=$mtime',
      '      best_dir[$skill]=$dir',
      '    fi',
      '  done',
      'done',
      'for skill in "${!best_dir[@]}"; do',
      '  dir="${best_dir[$skill]}"',
      '  echo "===SKILL_START:${skill}==="',
      '  cat "$dir/META.json" 2>/dev/null || echo \'{}\'',
      '  echo "===META_END==="',
      '  echo "===SKILL_CONTENT==="',
      '  if [ -f "$dir/SKILL.md" ]; then cat "$dir/SKILL.md";',
      '  elif [ -f "$dir/SKILL.yaml" ]; then cat "$dir/SKILL.yaml";',
      '  fi',
      '  echo "===SKILL_CONTENT_END==="',
      'done',
    ].join('\n')

    console.log(`[RemoteDeployService] Listing skills on ${server.name}, executing batch command...`)
    const result = await manager.executeCommandFull(batchCmd)
    console.log(`[RemoteDeployService] Batch command result: exitCode=${result.exitCode}, stdoutLen=${result.stdout.length}, stderrLen=${result.stderr.length}`)
    const stdout = result.stdout.trim()
    console.log(`[RemoteDeployService] Raw stdout (first 500 chars): ${stdout.substring(0, 500)}`)

    if (!stdout) return []

    const skills: InstalledSkill[] = []
    const blocks = stdout.split('===SKILL_START:')

    for (const block of blocks) {
      if (!block.trim()) continue

      // Block starts with "skillId===\n...", extract the ID and skip past the header
      const skillId = block.split('===')[0].trim()
      if (!skillId) continue

      // Find where the actual content starts (after "skillId===\n")
      const headerEnd = block.indexOf('===\n')
      const contentStart = headerEnd === -1 ? 0 : headerEnd + '===\n'.length

      const metaEndIdx = block.indexOf('===META_END===')
      const contentEndIdx = block.indexOf('===SKILL_CONTENT_END===')
      if (metaEndIdx === -1 || contentEndIdx === -1) continue

      const metaPart = block.substring(contentStart, metaEndIdx).trim()
      const contentPart = block.substring(metaEndIdx + '===META_END==='.length, contentEndIdx).trim()
      // Strip the ===SKILL_CONTENT=== marker line
      const markerIdx = contentPart.indexOf('===SKILL_CONTENT===')
      const skillContent = markerIdx === -1 ? contentPart : contentPart.substring(markerIdx + '===SKILL_CONTENT==='.length).trim()

      let enabled = true
      let installedAt = ''
      try {
        const meta = JSON.parse(metaPart)
        enabled = meta.enabled ?? true
        installedAt = meta.installedAt ?? ''
      } catch {
        // Ignore parse errors
      }

      if (!skillContent) continue

      try {
        // Try parsing as SKILL.md format first (frontmatter + body)
        const frontmatterMatch = skillContent.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        if (frontmatterMatch) {
          // SKILL.md format: system_prompt comes from the markdown body
          const frontmatter = parseYaml(frontmatterMatch[1]) as any
          const body = skillContent.slice(frontmatterMatch[0].length).trim()
          skills.push({
            appId: skillId,
            spec: {
              name: frontmatter.name || skillId,
              description: frontmatter.description || '',
              version: frontmatter.version || '1.0',
              author: frontmatter.author || '',
              system_prompt: body || '',
              trigger_command: frontmatter.trigger_command || '',
              tags: frontmatter.tags || [],
              type: 'skill',
            },
            enabled,
            installedAt,
          })
        } else {
          // Pure YAML format (SKILL.yaml)
          const spec = parseYaml(skillContent) as any
          skills.push({
            appId: skillId,
            spec: {
              name: spec.name || skillId,
              description: spec.description || '',
              version: spec.version || '1.0',
              author: spec.author || '',
              system_prompt: spec.system_prompt || '',
              trigger_command: spec.trigger_command || '',
              tags: spec.tags || [],
              type: 'skill',
            },
            enabled,
            installedAt,
          })
        }
      } catch (e) {
        console.warn(`[RemoteDeployService] Failed to parse skill content for remote skill: ${skillId}`, e)
      }
    }

    return skills
  }

  /**
   * List files in a remote skill directory.
   * Returns a SkillFileNode tree matching the local SkillManager.getSkillFiles() interface.
   */
  async listRemoteSkillFiles(id: string, skillId: string): Promise<SkillFileNode[]> {
    const server = this.servers.get(id)
    if (!server) throw new Error(`Server not found: ${id}`)

    if (!this.getSSHManager(id).isConnected()) {
      await this.connectServer(id)
    }
    const manager = this.getSSHManager(id)
    if (!manager.isConnected()) {
      throw new Error(`Failed to establish SSH connection to ${server.name}`)
    }

    // Use find to get full recursive listing with file sizes
    // NOTE: Avoid -print0/read -d '' to prevent shell escaping issues
    // Look in both ~/.agents/skills/ and ~/.claude/skills/
    const cmd = [
      'skill_dir=""',
      'for base in ~/.agents/skills ~/.claude/skills; do',
      '  [ -d "$base/' + skillId + '" ] && skill_dir="$base/' + skillId + '" && break',
      'done',
      '[ -z "$skill_dir" ] && exit 1',
      'cd "$skill_dir"',
      'find . -not -path "./.git/*" -not -name "." | sort | while IFS= read -r item; do',
      '  if [ -z "$item" ]; then continue; fi',
      '  if [ -d "$item" ]; then',
      '    echo "DIR:${item:2}"',
      '  else',
      '    size=$(stat -c%s "$item" 2>/dev/null || echo 0)',
      '    echo "FILE:${item:2}:$size"',
      '  fi',
      'done',
    ].join('\n')

    console.log(`[RemoteDeployService] Listing files for remote skill: ${skillId}`)
    const result = await manager.executeCommandFull(cmd)
    console.log(`[RemoteDeployService] File list exitCode=${result.exitCode}, stdoutLen=${result.stdout.length}, stderr=${result.stderr.substring(0, 200)}`)
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      console.log(`[RemoteDeployService] No files found for skill: ${skillId}`)
      return []
    }

    // Build tree from flat listing
    const nodes: SkillFileNode[] = []

    const ensureDir = (dirPath: string): SkillFileNode => {
      const parts = dirPath.split('/')
      let current = nodes
      let parent: SkillFileNode | undefined
      for (const part of parts) {
        let existing = current.find(n => n.name === part && n.type === 'directory')
        if (!existing) {
          existing = { name: part, type: 'directory', path: dirPath.split('/').slice(0, parts.indexOf(part) + 1).join('/'), children: [] }
          if (parent) parent.children!.push(existing)
          else current.push(existing)
        }
        parent = existing
        current = existing.children!
      }
      return parent!
    }

    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue
      if (line.startsWith('DIR:')) {
        const dirPath = line.substring(4)
        ensureDir(dirPath)
      } else if (line.startsWith('FILE:')) {
        const rest = line.substring(5)
        const lastColon = rest.lastIndexOf(':')
        const filePath = rest.substring(0, lastColon)
        const size = parseInt(rest.substring(lastColon + 1)) || 0
        const name = filePath.split('/').pop()!
        const ext = name.includes('.') ? name.split('.').pop() : undefined

        // Ensure parent directories exist
        const dirParts = filePath.split('/')
        if (dirParts.length > 1) {
          const parentPath = dirParts.slice(0, -1).join('/')
          const parent = ensureDir(parentPath)
          parent.children!.push({ name, type: 'file', path: filePath, size, extension: ext })
        } else {
          nodes.push({ name, type: 'file', path: filePath, size, extension: ext })
        }
      }
    }

    // Sort: directories first, then files, alphabetically
    const sortNodes = (list: SkillFileNode[]) => {
      list.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      for (const node of list) {
        if (node.children) sortNodes(node.children)
      }
    }
    sortNodes(nodes)

    return nodes
  }

  /**
   * Read a file from a remote skill directory.
   */
  async readRemoteSkillFile(id: string, skillId: string, filePath: string): Promise<string | null> {
    const server = this.servers.get(id)
    if (!server) throw new Error(`Server not found: ${id}`)

    if (!this.getSSHManager(id).isConnected()) {
      await this.connectServer(id)
    }
    const manager = this.getSSHManager(id)
    if (!manager.isConnected()) {
      throw new Error(`Failed to establish SSH connection to ${server.name}`)
    }

    const result = await manager.executeCommandFull(
      [
        'skill_dir=""',
        'for base in ~/.agents/skills ~/.claude/skills; do',
        '  [ -d "$base/' + skillId + '" ] && skill_dir="$base/' + skillId + '" && break',
        'done',
        '[ -z "$skill_dir" ] && exit 1',
        'cat "$skill_dir/' + filePath + '"',
      ].join('\n')
    )

    if (result.exitCode !== 0) return null
    return result.stdout
  }

  /**
   * Ensure a fresh SSH connection for a server.
   * Always disconnects and reconnects to avoid stale connections.
   */
  private async ensureFreshConnection(id: string, serverName: string, onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void): Promise<SSHManager> {
    onOutput?.({ type: 'stdout', content: `[${serverName}] 正在连接...\n` })

    // Always disconnect first to avoid stale connections
    const manager = this.getSSHManager(id)
    if (manager.isConnected()) {
      manager.disconnect()
    }

    // Reconnect
    await this.connectServer(id)
    const freshManager = this.getSSHManager(id)
    if (!freshManager.isConnected()) {
      throw new Error(`Failed to connect to ${serverName}`)
    }
    return freshManager
  }

  /**
   * Execute a command with timeout protection.
   * Prevents commands from hanging indefinitely on broken connections.
   */
  private async executeWithTimeout(
    manager: SSHManager,
    command: string,
    timeoutMs: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs / 1000}s`)), timeoutMs)
    )
    return Promise.race([
      manager.executeCommandFull(command),
      timeoutPromise
    ])
  }

  /**
   * Install a skill on a remote server via SSH.
   * Executes `npx skills add <repo> --skill <name> -y --global` on the remote server.
   * Streams stdout/stderr back through onOutput callback.
   */
  async installRemoteSkill(
    id: string,
    skillId: string,
    githubRepo: string,
    skillName: string,
    onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void
  ): Promise<{ success: boolean; error?: string }> {
    const server = this.servers.get(id)
    if (!server) throw new Error(`Server not found: ${id}`)

    let manager: SSHManager
    try {
      manager = await this.ensureFreshConnection(id, server.name, onOutput)
    } catch (error) {
      const err = error as Error
      onOutput?.({ type: 'error', content: `[${server.name}] ${err.message}\n` })
      return { success: false, error: err.message }
    }

    // Ensure remote skills directory exists
    onOutput?.({ type: 'stdout', content: `[${server.name}] 准备远程环境...\n` })
    try {
      const remoteHome = (await manager.executeCommand('echo $HOME')).trim()
      const remoteSkillsDir = `${remoteHome}/.agents/skills`
      await manager.executeCommand(`mkdir -p ${remoteSkillsDir}`)
    } catch (error) {
      const err = error as Error
      onOutput?.({ type: 'error', content: `[${server.name}] 准备远程环境失败: ${err.message}\n` })
      return { success: false, error: err.message }
    }

    // Execute npx command on remote server
    const command = `cd ~ && npx --yes skills add https://github.com/${githubRepo} --skill ${skillName} -y --global 2>&1`
    onOutput?.({ type: 'stdout', content: `[${server.name}] $ npx skills add https://github.com/${githubRepo} --skill ${skillName} -y --global\n` })

    try {
      const result = await this.executeWithTimeout(manager, command, 180000)

      if (result.stdout) {
        onOutput?.({ type: 'stdout', content: result.stdout })
      }
      if (result.stderr) {
        // Filter out npm warnings
        const filtered = result.stderr
          .split('\n')
          .filter(line => !line.toLowerCase().includes('npm warn'))
          .join('\n')
          .trim()
        if (filtered) {
          onOutput?.({ type: 'stderr', content: filtered + '\n' })
        }
      }

      if (result.exitCode === 0) {
        onOutput?.({ type: 'complete', content: `[${server.name}] ✓ Skill installed successfully!\n` })
        return { success: true }
      } else {
        const error = `[${server.name}] Installation failed with exit code ${result.exitCode}`
        onOutput?.({ type: 'error', content: error + '\n' })
        return { success: false, error }
      }
    } catch (error) {
      const err = error as Error
      onOutput?.({ type: 'error', content: `[${server.name}] Error: ${err.message}\n` })
      return { success: false, error: err.message }
    }
  }

  /**
   * Sync a local skill to a remote server via SSH.
   * Reads local skill files and uploads them to ~/.agents/skills/<skillId>/ on the remote.
   */
  async syncLocalSkillToRemote(
    id: string,
    skillId: string,
    onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void
  ): Promise<{ success: boolean; error?: string }> {
    const server = this.servers.get(id)
    if (!server) throw new Error(`Server not found: ${id}`)

    let manager: SSHManager
    try {
      manager = await this.ensureFreshConnection(id, server.name, onOutput)
    } catch (error) {
      const err = error as Error
      onOutput?.({ type: 'error', content: `[${server.name}] ${err.message}\n` })
      return { success: false, error: err.message }
    }

    try {
      // Read local skill files
      const { readLocalSkillFiles } = await import('../skill/github-skill-source.service')
      const files = await readLocalSkillFiles(skillId)
      if (files.length === 0) {
        const error = `Skill "${skillId}" not found locally or has no files`
        onOutput?.({ type: 'error', content: `${error}\n` })
        return { success: false, error }
      }

      // Prepare remote directory
      onOutput?.({ type: 'stdout', content: `[${server.name}] Syncing skill "${skillId}" (${files.length} files)...\n` })
      const remoteHome = (await manager.executeCommand('echo $HOME')).trim()
      const remoteSkillDir = `${remoteHome}/.agents/skills/${skillId}`
      await manager.executeCommand(`mkdir -p ${remoteSkillDir}`)

      // Upload each file via base64 encoding
      for (const file of files) {
        const remotePath = `${remoteSkillDir}/${file.relativePath}`
        const remoteDir = path.dirname(remotePath)
        await manager.executeCommand(`mkdir -p '${remoteDir}'`)
        const base64Content = Buffer.from(file.content).toString('base64')
        await manager.executeCommand(`echo "${base64Content}" | base64 -d > '${remotePath}'`)
        onOutput?.({ type: 'stdout', content: `  ✓ ${file.relativePath}\n` })
      }

      onOutput?.({ type: 'complete', content: `[${server.name}] ✓ Skill "${skillId}" synced successfully (${files.length} files)!\n` })
      return { success: true }
    } catch (error) {
      const err = error as Error
      onOutput?.({ type: 'error', content: `[${server.name}] Error: ${err.message}\n` })
      return { success: false, error: err.message }
    }
  }

  /**
   * Uninstall a skill from a remote server via SSH.
   */
  async uninstallRemoteSkill(
    id: string,
    skillId: string,
    onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void
  ): Promise<{ success: boolean; error?: string }> {
    const server = this.servers.get(id)
    if (!server) throw new Error(`Server not found: ${id}`)

    let manager: SSHManager
    try {
      manager = await this.ensureFreshConnection(id, server.name, onOutput)
    } catch (error) {
      const err = error as Error
      onOutput?.({ type: 'error', content: `[${server.name}] ${err.message}\n` })
      return { success: false, error: err.message }
    }

    try {
      const remoteHome = (await manager.executeCommand('echo $HOME')).trim()

      onOutput?.({ type: 'stdout', content: `[${server.name}] Removing skill "${skillId}"...\n` })

      // Remove from both possible locations
      const removeCmd = [
        `rm -rf ${remoteHome}/.agents/skills/${skillId}`,
        `rm -rf ${remoteHome}/.claude/skills/${skillId}`,
      ].join(' && ')

      const result = await this.executeWithTimeout(manager, removeCmd, 30000)

      if (result.exitCode === 0) {
        onOutput?.({ type: 'complete', content: `[${server.name}] ✓ Skill "${skillId}" uninstalled successfully!\n` })
        return { success: true }
      } else {
        const error = `[${server.name}] Failed to uninstall skill (exit code ${result.exitCode})`
        onOutput?.({ type: 'error', content: error + '\n' })
        return { success: false, error }
      }
    } catch (error) {
      const err = error as Error
      onOutput?.({ type: 'error', content: `[${server.name}] Error: ${err.message}\n` })
      return { success: false, error: err.message }
    }
  }

  /**
   * Recursively upload a directory to remote server with incremental sync.
   * Only uploads files whose md5 differs from the remote copy.
   */
  private async uploadDirectoryRecursive(
    manager: SSHManager,
    localDir: string,
    remoteDir: string,
    stats?: { uploaded: number; skipped: number }
  ): Promise<void> {
    if (!stats) stats = { uploaded: 0, skipped: 0 }
    const entries = fs.readdirSync(localDir, { withFileTypes: true })

    for (const entry of entries) {
      const localPath = path.join(localDir, entry.name)
      const remotePath = `${remoteDir}/${entry.name}`

      if (entry.isDirectory()) {
        // Create remote directory and recurse
        await manager.executeCommand(`mkdir -p ${remotePath}`)
        await this.uploadDirectoryRecursive(manager, localPath, remotePath, stats)
      } else if (entry.isFile()) {
        // Compare md5 with remote, only upload if changed
        const localMd5 = this.computeMd5(localPath)
        const remoteMd5Result = await manager.executeCommandFull(
          `md5sum ${remotePath} 2>/dev/null | awk '{print $1}' || echo ""`
        )
        const remoteMd5 = remoteMd5Result.stdout.trim()

        if (localMd5 !== remoteMd5) {
          await manager.uploadFile(localPath, remotePath)
          stats.uploaded++
        } else {
          stats.skipped++
        }
      }
    }
  }
}

// Export singleton instance
export const remoteDeployService = new RemoteDeployService()
