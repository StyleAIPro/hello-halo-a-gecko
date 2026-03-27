/**
 * SSH Tunnel Service - Manages SSH port forwarding for remote agent connections
 *
 * This service automatically establishes SSH tunnels when spaces need SSH tunneling.
 * Tunnel format: ssh -L localhost:LOCAL_PORT:localhost:REMOTE_PORT user@host
 *
 * Uses forwardOut for local port forwarding (access remote service via localhost)
 *
 * Features:
 * - Dynamic port allocation for multiple remote servers
 * - Port conflict resolution
 * - Automatic cleanup on disconnect
 */

import { Client, ConnectConfig } from 'ssh2'
import { EventEmitter } from 'events'
import * as net from 'net'
import { execSync } from 'child_process'

export interface SshTunnelConfig {
  spaceId: string
  serverId: string
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  localPort: number
  remotePort: number
}

export interface TunnelStatus {
  spaceId: string
  serverId: string
  host: string
  active: boolean
  localPort: number
  remotePort: number
  error?: string
}

// Default port range for dynamic allocation
const DEFAULT_BASE_PORT = 8080
const MAX_PORT_ATTEMPTS = 100

// Add isConnected check helper
function isClientConnected(client: Client): boolean {
  // ssh2 Client doesn't have isConnected method, check stream state
  return (client as any)._sock && (client as any)._sock.writable !== false
}

/**
 * Cross-platform synchronous port availability check.
 * Uses netstat on Windows, lsof on macOS/Linux.
 */
function isPortAvailableSync(port: number): boolean {
  try {
    if (process.platform === 'win32') {
      // Windows: use netstat to check if port is in LISTENING state
      const result = execSync(`netstat -ano | findstr ":${port} " | findstr "LISTENING"`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000
      })
      return result.trim() === ''
    } else {
      // macOS/Linux: use lsof
      const result = execSync(`lsof -i :${port} -t 2>/dev/null || echo ""`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000
      })
      return result.trim() === ''
    }
  } catch {
    // Command error → assume port is available
    return true
  }
}

/**
 * Find an available port starting from base port
 */
function findAvailablePort(startPort: number): number {
  for (let port = startPort; port < startPort + MAX_PORT_ATTEMPTS; port++) {
    if (isPortAvailableSync(port)) {
      return port
    }
  }
  throw new Error(`No available port found in range ${startPort}-${startPort + MAX_PORT_ATTEMPTS}`)
}

/**
 * Kill any process using the specified port
 */
function killPort(port: number): void {
  try {
    console.log(`[SshTunnel] Checking and killing process(es) using port ${port}...`)
    if (process.platform === 'win32') {
      // Windows: use netstat to find PID, then taskkill
      const result = execSync(`netstat -ano | findstr ":${port} " | findstr "LISTENING"`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const pids = new Set<string>()
      for (const line of result.trim().split('\n')) {
        const parts = line.trim().split(/\s+/)
        const pid = parts[parts.length - 1]
        if (pid && /^\d+$/.test(pid)) {
          pids.add(pid)
        }
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
          })
          console.log(`[SshTunnel] Killed process ${pid} using port ${port}`)
        } catch {
          // PID may have already exited
        }
      }
    } else {
      // macOS/Linux: use lsof to find and kill the process
      const result = execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      if (result) {
        console.log(`[SshTunnel] Killed process(es) using port ${port}: ${result.trim()}`)
      }
    }
    console.log(`[SshTunnel] Port cleanup completed (port ${port})`)
  } catch (error) {
    // Ignore errors - port might be free already
    console.log(`[SshTunnel] Port cleanup completed (port ${port})`)
  }
}

class SshTunnelService extends EventEmitter {
  private tunnels = new Map<string, {
    client: Client
    config: SshTunnelConfig
    server: net.Server
    spaces: Set<string>  // Track which spaces are using this tunnel
  }>()

  // Map serverId -> localPort for consistent port assignment per server
  private serverPortMap = new Map<string, number>()
  // Set of used local ports
  private usedPorts = new Set<number>()

  /**
   * Get or assign a local port for a server
   * Each server gets a unique local port to avoid conflicts
   */
  private getOrAssignLocalPort(serverId: string, remotePort: number): number {
    // Check if this server already has an assigned port
    const existingPort = this.serverPortMap.get(serverId)
    if (existingPort && !this.usedPorts.has(existingPort)) {
      return existingPort
    }

    // Find an available port starting from remotePort (usually 8080)
    // This keeps ports consistent when possible
    const basePort = remotePort || DEFAULT_BASE_PORT
    let assignedPort = findAvailablePort(basePort)

    // If base port is already in use, try to find next available
    while (this.usedPorts.has(assignedPort)) {
      assignedPort = findAvailablePort(assignedPort + 1)
    }

    // Record the assignment
    this.serverPortMap.set(serverId, assignedPort)
    this.usedPorts.add(assignedPort)
    console.log(`[SshTunnel] Assigned local port ${assignedPort} for server ${serverId}`)

    return assignedPort
  }

  /**
   * Get the local port for an existing tunnel
   */
  getTunnelLocalPort(serverId: string): number | undefined {
    return this.serverPortMap.get(serverId)
  }

  /**
   * Establish SSH tunnel for a space
   * Creates a local TCP server that forwards connections through SSH to remote port
   *
   * @param config - Tunnel config (localPort will be auto-assigned if not specified or in use)
   * @returns The actual local port used for the tunnel
   */
  async establishTunnel(config: SshTunnelConfig): Promise<number> {
    // Use serverId as tunnel key to allow tunnel sharing across spaces
    const tunnelKey = config.serverId

    // Check if tunnel already exists for this server
    if (this.tunnels.has(tunnelKey)) {
      const existing = this.tunnels.get(tunnelKey)!
      if (existing.client && isClientConnected(existing.client)) {
        console.log(`[SshTunnel] Reusing existing tunnel for server ${tunnelKey} on port ${existing.config.localPort}`)
        // Track that this space is using the tunnel
        existing.spaces.add(config.spaceId)
        return existing.config.localPort
      }
      // Remove inactive tunnel
      this.cleanupTunnel(tunnelKey)
    }

    // Auto-assign local port if not specified or if specified port is in use
    const localPort = this.getOrAssignLocalPort(config.serverId, config.remotePort)
    config.localPort = localPort

    console.log(`[SshTunnel] Establishing tunnel for ${tunnelKey}: localhost:${config.localPort} -> ${config.host}:localhost:${config.remotePort}`)

    return new Promise<number>((resolve, reject) => {
      const client = new Client()

      // SSH connection config
      const sshConfig: ConnectConfig = {
        host: config.host,
        port: config.port,
        username: config.username,
        readyTimeout: 30000,  // 30 seconds timeout
        keepaliveInterval: 30000,  // Send keepalive every 30 seconds
        keepaliveCountMax: 3
      }

      // Use password or private key for authentication
      if (config.privateKey) {
        sshConfig.privateKey = config.privateKey
      } else if (config.password) {
        sshConfig.password = config.password
      }

      client.on('ready', () => {
        console.log(`[SshTunnel] SSH connected to ${config.host}`)

        // Note: We don't need to kill existing processes on the port because:
        // 1. getOrAssignLocalPort() ensures we get a unique port per server
        // 2. If tunnel already exists, we return early above
        // 3. Killing processes on the port could kill our own tunnel server!

        // Create a local TCP server that forwards connections through SSH
        const server = net.createServer((socket) => {
          if (!isClientConnected(client)) {
            console.error(`[SshTunnel] SSH client not connected, destroying socket`)
            socket.destroy()
            return
          }

          // Forward the connection through SSH using forwardOut
          client.forwardOut(
            '127.0.0.1', config.localPort,
            'localhost', config.remotePort,
            (err, stream) => {
              if (err) {
                console.error(`[SshTunnel] forwardOut error:`, err)
                socket.destroy()
                return
              }

              // Pipe data between local socket and SSH stream
              socket.pipe(stream).pipe(socket)

              socket.on('error', (err) => {
                console.error(`[SshTunnel] Socket error:`, err)
                stream.destroy()
              })

              stream.on('error', (err) => {
                console.error(`[SshTunnel] Stream error:`, err)
                socket.destroy()
              })

              socket.on('close', () => {
                stream.destroy()
              })

              stream.on('close', () => {
                socket.destroy()
              })
            }
          )
        })

        // Start listening on local port
        server.listen(config.localPort, '127.0.0.1', () => {
          // Store tunnel with server reference and track spaces using it
          this.tunnels.set(tunnelKey, {
            client,
            config,
            server,
            spaces: new Set([config.spaceId])  // Track spaces using this tunnel
          })

          console.log(`[SshTunnel] Tunnel established: localhost:${config.localPort} -> ${config.host}:localhost:${config.remotePort}`)
          this.emit('tunnel:established', { tunnelKey, localPort: config.localPort })
          resolve(config.localPort)
        })

        server.on('error', (err) => {
          console.error(`[SshTunnel] Local server error for ${tunnelKey}:`, err)
          this.cleanupTunnel(tunnelKey)
          reject(err)
        })
      })

      client.on('error', (err) => {
        console.error(`[SshTunnel] SSH connection error for ${tunnelKey}:`, err)
        this.emit('tunnel:error', { tunnelKey, error: err.message || String(err) })
        reject(err)
      })

      client.on('close', () => {
        console.log(`[SshTunnel] SSH connection closed for ${tunnelKey}`)
        this.cleanupTunnel(tunnelKey)
        this.emit('tunnel:closed', tunnelKey)
      })

      // Connect to SSH server
      client.connect(sshConfig)
    })
  }

  /**
   * Close SSH tunnel for a space
   * Uses reference counting - only closes tunnel when last space disconnects
   */
  closeTunnel(spaceId: string, serverId: string): boolean {
    const tunnelKey = serverId
    const tunnel = this.tunnels.get(tunnelKey)

    if (!tunnel) {
      console.log(`[SshTunnel] No tunnel found for server ${serverId}`)
      return false
    }

    // Remove this space from the tunnel's users
    if (tunnel.spaces.has(spaceId)) {
      tunnel.spaces.delete(spaceId)
      console.log(`[SshTunnel] Space ${spaceId} released tunnel for server ${serverId}, ${tunnel.spaces.size} spaces still using it`)
    }

    // Only cleanup tunnel when no spaces are using it
    if (tunnel.spaces.size === 0) {
      console.log(`[SshTunnel] No more spaces using tunnel for server ${serverId}, closing tunnel`)
      return this.cleanupTunnel(tunnelKey)
    }

    return true
  }

  /**
   * Check if tunnel is active for a server
   */
  isTunnelActive(spaceId: string, serverId: string): boolean {
    const tunnelKey = serverId
    const tunnel = this.tunnels.get(tunnelKey)
    // Check if tunnel exists and this space is using it
    return tunnel !== undefined && isClientConnected(tunnel.client) && tunnel.spaces.has(spaceId)
  }

  /**
   * Get all active tunnel statuses
   */
  getTunnelStatuses(): TunnelStatus[] {
    const statuses: TunnelStatus[] = []
    for (const [serverId, tunnel] of this.tunnels) {
      // Create a status entry for each space using this tunnel
      for (const spaceId of tunnel.spaces) {
        statuses.push({
          spaceId,
          serverId,
          host: tunnel.config.host,
          active: isClientConnected(tunnel.client),
          localPort: tunnel.config.localPort,
          remotePort: tunnel.config.remotePort
        })
      }
    }
    return statuses
  }

  /**
   * Close all tunnels
   */
  closeAllTunnels(): void {
    for (const tunnelKey of this.tunnels.keys()) {
      this.cleanupTunnel(tunnelKey)
    }
  }

  /**
   * Internal: Clean up a tunnel
   */
  private cleanupTunnel(tunnelKey: string): boolean {
    const tunnel = this.tunnels.get(tunnelKey)
    if (!tunnel) return false

    // Release the port from used set
    this.usedPorts.delete(tunnel.config.localPort)

    // Close local server first
    if (tunnel.server) {
      try {
        tunnel.server.close()
        console.log(`[SshTunnel] Local server closed for ${tunnelKey}`)
      } catch (err) {
        console.error(`[SshTunnel] Error closing local server for ${tunnelKey}:`, err)
      }
    }

    // Close SSH client
    try {
      tunnel.client.end()
      tunnel.client.destroy()
    } catch (err) {
      console.error(`[SshTunnel] Error closing tunnel ${tunnelKey}:`, err)
    }

    // Remove from map
    this.tunnels.delete(tunnelKey)
    console.log(`[SshTunnel] Tunnel ${tunnelKey} closed and removed`)
    return true
  }
}

// Singleton instance
const sshTunnelService = new SshTunnelService()

export default sshTunnelService
export { SshTunnelService }
