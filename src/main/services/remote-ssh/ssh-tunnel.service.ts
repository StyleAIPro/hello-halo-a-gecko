/**
 * SSH Tunnel Service - Manages SSH port forwarding for remote agent connections
 *
 * This service automatically establishes SSH tunnels when spaces need SSH tunneling.
 * Tunnel format: ssh -L localhost:8080:localhost:8080 user@host
 *
 * Uses forwardOut for local port forwarding (access remote service via localhost)
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

// Add isConnected check helper
function isClientConnected(client: Client): boolean {
  // ssh2 Client doesn't have isConnected method, check stream state
  return (client as any)._sock && (client as any)._sock.writable !== false
}

/**
 * Kill any process using the specified port
 */
function killPort(port: number): void {
  try {
    console.log(`[SshTunnel] Checking and killing process(es) using port ${port}...`)
    // On macOS/Linux, use lsof to find and kill the process
    const result = execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    if (result) {
      console.log(`[SshTunnel] Killed process(es) using port ${port}: ${result.trim()}`)
    } else {
      console.log(`[SshTunnel] Port ${port} is already free`)
    }
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
  }>()

  /**
   * Establish SSH tunnel for a space
   * Creates a local TCP server that forwards connections through SSH to remote port
   */
  async establishTunnel(config: SshTunnelConfig): Promise<void> {
    const tunnelKey = `${config.spaceId}-${config.serverId}`

    // Check if tunnel already exists
    if (this.tunnels.has(tunnelKey)) {
      const existing = this.tunnels.get(tunnelKey)!
      if (existing.client && isClientConnected(existing.client)) {
        console.log(`[SshTunnel] Tunnel already active for ${tunnelKey}`)
        return
      }
      // Remove inactive tunnel
      this.cleanupTunnel(tunnelKey)
    }

    console.log(`[SshTunnel] Establishing tunnel for ${tunnelKey}: localhost:${config.localPort} -> ${config.host}:localhost:${config.remotePort}`)

    return new Promise<void>((resolve, reject) => {
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

        // Kill any existing process on the local port before creating server
        killPort(config.localPort)

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
          // Store tunnel with server reference
          this.tunnels.set(tunnelKey, {
            client,
            config,
            server
          })

          console.log(`[SshTunnel] Tunnel established: localhost:${config.localPort} -> ${config.host}:localhost:${config.remotePort}`)
          this.emit('tunnel:established', tunnelKey)
          resolve()
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
   */
  closeTunnel(spaceId: string, serverId: string): boolean {
    const tunnelKey = `${spaceId}-${serverId}`
    return this.cleanupTunnel(tunnelKey)
  }

  /**
   * Check if tunnel is active for a space
   */
  isTunnelActive(spaceId: string, serverId: string): boolean {
    const tunnelKey = `${spaceId}-${serverId}`
    const tunnel = this.tunnels.get(tunnelKey)
    return tunnel !== undefined && isClientConnected(tunnel.client)
  }

  /**
   * Get all active tunnel statuses
   */
  getTunnelStatuses(): TunnelStatus[] {
    const statuses: TunnelStatus[] = []
    for (const [key, tunnel] of this.tunnels) {
      const [spaceId, serverId] = key.split('-')
      statuses.push({
        spaceId,
        serverId,
        host: tunnel.config.host,
        active: isClientConnected(tunnel.client),
        localPort: tunnel.config.localPort,
        remotePort: tunnel.config.remotePort
      })
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
