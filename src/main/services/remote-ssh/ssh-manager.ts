/**
 * SSH Manager Service
 * Handles SSH connections, command execution, and file transfers
 */

import { Client as SSHClient, SFTPWrapper } from 'ssh2'
import { promisify } from 'util'
import { Readable, Writable } from 'stream'

export interface SSHConfig {
  host: string
  port: number
  username: string
  password: string
  privateKey?: string
}

export interface SSHExecuteResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

export class SSHManager {
  private client: SSHClient | null = null
  private sftp: SFTPWrapper | null = null
  private config: SSHConfig | null = null
  private _ready = false // Custom ready state tracker
  private localForwardServers: Map<number, any> = new Map() // Local port -> net.Server
  private interactiveShell: any | null = null // Stored interactive shell stream

  /**
   * Establish SSH connection
   */
  async connect(config: SSHConfig): Promise<void> {
    console.log('[SSHManager] connect called with:', { host: config.host, port: config.port, username: config.username })

    // If already connected with same config, just return
    if (this._ready && this.config) {
      if (this.config.host === config.host &&
          this.config.port === config.port &&
          this.config.username === config.username) {
        console.log('[SSHManager] Already connected to same server')
        return
      }
    }

    // Clean up existing connection
    if (this.client) {
      console.log('[SSHManager] Cleaning up existing connection...')
      this._ready = false
      try {
        this.client.end()
      } catch (e) {
        console.log('[SSHManager] Error closing connection:', e)
      }
      this.client = null
      this.sftp = null
    }

    this.config = config

    return new Promise<void>((resolve, reject) => {
      this.client = new SSHClient()

      this.client.on('ready', () => {
        this._ready = true
        console.log('[SSHManager] Ready event fired - connection ready')
        resolve()
      })

      this.client.on('error', (err) => {
        this._ready = false
        console.error('[SSHManager] Connection error:', err)
        reject(err)
      })

      this.client.on('close', (reason) => {
        this._ready = false
        console.log('[SSHManager] Connection closed, reason:', reason)
        this.client = null
        this.sftp = null
      })

      // Simplified connection config - use basic keepalive
      const connectionConfig: any = {
        host: config.host,
        port: config.port,
        username: config.username,
        // Basic keepalive to prevent timeout
        keepaliveInterval: 30000,     // Send keepalive every 30 seconds
        keepaliveCountMax: 10,         // Max keepalive failures before closing
        // Disable ready timeout - let SSH negotiate normally
        readyTimeout: 30000,            // 30 second ready timeout
      }

      if (config.privateKey) {
        connectionConfig.privateKey = config.privateKey
      } else if (config.password) {
        connectionConfig.password = config.password
      }

      console.log('[SSHManager] Connecting with basic config')
      this.client.connect(connectionConfig)
    })
  }

  /**
   * Execute a command on the remote server
   */
  async executeCommand(command: string): Promise<string> {
    if (!this._ready || !this.client) {
      throw new Error('Not connected')
    }

    console.log(`[SSHManager] Executing command: ${command}`)

    return new Promise((resolve, reject) => {
      this.client!.exec(command, (err, stream) => {
        if (err) {
          console.error('[SSHManager] Command execution error:', err)
          return reject(err)
        }

        let stdout = ''
        let stderr = ''

        stream.on('data', (data: Buffer) => {
          stdout += data.toString()
        })

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        stream.on('close', (code: number | null) => {
          console.log(`[SSHManager] Command completed with exit code: ${code}`)
          if (code !== 0 && code !== null) {
            reject(new Error(`Command failed with exit code ${code}: ${stderr}`))
          } else {
            resolve(stdout)
          }
        })

        stream.on('error', (err) => {
          console.error('[SSHManager] Stream error:', err)
          reject(err)
        })
      })
    })
  }

  /**
   * Execute a command and return full result including stderr and exit code
   */
  async executeCommandFull(command: string): Promise<SSHExecuteResult> {
    if (!this._ready || !this.client) {
      throw new Error('Not connected')
    }

    console.log(`[SSHManager] Executing command (full): ${command}`)

    return new Promise((resolve, reject) => {
      this.client!.exec(command, (err, stream) => {
        if (err) {
          console.error('[SSHManager] Command execution error:', err)
          return reject(err)
        }

        let stdout = ''
        let stderr = ''

        stream.on('data', (data: Buffer) => {
          stdout += data.toString()
        })

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        stream.on('close', (code: number | null) => {
          console.log(`[SSHManager] Command completed with exit code: ${code}`)
          resolve({ stdout, stderr, exitCode: code })
        })

        stream.on('error', (err) => {
          console.error('[SSHManager] Stream error:', err)
          reject(err)
        })
      })
    })
  }

  /**
   * Execute a command with streaming output
   * Calls onOutput callback for each chunk of stdout/stderr
   * Returns when command completes
   */
  async executeCommandStreaming(
    command: string,
    onOutput: (type: 'stdout' | 'stderr', data: string) => void
  ): Promise<SSHExecuteResult> {
    if (!this._ready || !this.client) {
      throw new Error('Not connected')
    }

    console.log(`[SSHManager] Executing command (streaming): ${command}`)

    return new Promise((resolve, reject) => {
      this.client!.exec(command, (err, stream) => {
        if (err) {
          console.error('[SSHManager] Command execution error:', err)
          return reject(err)
        }

        let stdout = ''
        let stderr = ''

        stream.on('data', (data: Buffer) => {
          const chunk = data.toString()
          stdout += chunk
          onOutput('stdout', chunk)
        })

        stream.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString()
          stderr += chunk
          onOutput('stderr', chunk)
        })

        stream.on('close', (code: number | null) => {
          console.log(`[SSHManager] Streaming command completed with exit code: ${code}`)
          resolve({ stdout, stderr, exitCode: code })
        })

        stream.on('error', (err) => {
          console.error('[SSHManager] Stream error:', err)
          reject(err)
        })
      })
    })
  }

  /**
   * Initialize SFTP subsystem for file operations
   */
  private async initSFTP(): Promise<void> {
    if (this.sftp) {
      return
    }

    if (!this._ready || !this.client) {
      throw new Error('Not connected')
    }

    return new Promise((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) {
          console.error('[SSHManager] SFTP initialization error:', err)
          return reject(err)
        }
        this.sftp = sftp
        console.log('[SSHManager] SFTP initialized')
        resolve()
      })
    })
  }

  /**
   * Upload a file to the remote server
   */
  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await this.initSFTP()

    console.log(`[SSHManager] Uploading ${localPath} to ${remotePath}`)

    return new Promise((resolve, reject) => {
      const fs = require('fs')
      const fastPut = promisify(this.sftp!.fastPut)

      fastPut.call(this.sftp!, localPath, remotePath)
        .then(() => {
          console.log(`[SSHManager] Upload completed`)
          resolve()
        })
        .catch((err) => {
          console.error('[SSHManager] Upload error:', err)
          reject(err)
        })
    })
  }

  /**
   * Download a file from the remote server
   */
  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    await this.initSFTP()

    console.log(`[SSHManager] Downloading ${remotePath} to ${localPath}`)

    return new Promise((resolve, reject) => {
      const fastGet = promisify(this.sftp!.fastGet)

      fastGet.call(this.sftp!, remotePath, localPath)
        .then(() => {
          console.log(`[SSHManager] Download completed`)
          resolve()
        })
        .catch((err) => {
          console.error('[SSHManager] Download error:', err)
          reject(err)
        })
    })
  }

  /**
   * Create a directory on the remote server
   */
  async mkdir(remotePath: string, recursive: boolean = true): Promise<void> {
    await this.initSFTP()

    return new Promise((resolve, reject) => {
      this.sftp!.mkdir(remotePath, { mode: 0o755 }, (err) => {
        if (err) {
          // If directory already exists, that's okay
          if (err.message && err.message.includes('exists')) {
            resolve()
            return
          }
          console.error('[SSHManager] mkdir error:', err)
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }

  /**
   * Create SSH local port forwarding (local -> remote)
   * This allows connecting to a remote service via localhost
   * Uses forwardOut to create outbound connections through SSH
   */
  async createLocalPortForward(localPort: number, remotePort: number, remoteHost: string = 'localhost'): Promise<void> {
    if (!this._ready || !this.client) {
      throw new Error('Not connected')
    }

    // Check if we already have a server on this port
    if (this.localForwardServers.has(localPort)) {
      console.log(`[SSHManager] Local port forward already exists on ${localPort}`)
      return
    }

    console.log(`[SSHManager] Creating local port forward: localhost:${localPort} -> ${remoteHost}:${remotePort}`)

    return new Promise((resolve, reject) => {
      const net = require('net')

      const server = net.createServer((socket) => {
        if (!this._ready || !this.client) {
          socket.destroy()
          return
        }

        // Forward connection through SSH
        this.client!.forwardOut('127.0.0.1', localPort, remoteHost, remotePort, (err, stream) => {
          if (err) {
            console.error('[SSHManager] forwardOut error:', err)
            socket.destroy()
            return
          }

          // Pipe data between socket and SSH stream
          socket.pipe(stream).pipe(socket)

          socket.on('error', (err: Error) => {
            console.error('[SSHManager] Socket error:', err)
            stream.destroy()
          })

          stream.on('error', (err: Error) => {
            console.error('[SSHManager] Stream error:', err)
            socket.destroy()
          })

          socket.on('close', () => {
            stream.destroy()
          })

          stream.on('close', () => {
            socket.destroy()
          })
        })
      })

      server.listen(localPort, '127.0.0.1', () => {
        this.localForwardServers.set(localPort, server)
        console.log(`[SSHManager] Local port forward server listening on 127.0.0.1:${localPort}`)
        resolve()
      })

      server.on('error', (err: Error) => {
        console.error('[SSHManager] Local forward server error:', err)
        reject(err)
      })
    })
  }

  /**
   * Close a local port forward
   */
  closeLocalPortForward(localPort: number): void {
    const server = this.localForwardServers.get(localPort)
    if (server) {
      server.close()
      this.localForwardServers.delete(localPort)
    }
  }

  /**
   * Create a reverse (remote) port forward.
   * Makes the remote machine listen on remotePort, forwarding connections
   * back to a local service on AICO-Bot's machine.
   *
   * @param remotePort - Port to listen on the remote machine
   * @param localPort - Port on the local (AICO-Bot) machine to forward to
   * @param localHost - Local host to forward to (default '127.0.0.1')
   * @returns The remote port that was bound (may differ if 0 is passed)
   */
  async createReversePortForward(
    remotePort: number,
    localPort: number,
    localHost: string = '127.0.0.1'
  ): Promise<number> {
    if (!this._ready || !this.client) {
      throw new Error('Not connected')
    }

    return new Promise((resolve, reject) => {
      this.client!.forwardIn('127.0.0.1', remotePort, (err, remotePortBound) => {
        if (err) {
          console.error(`[SSHManager] forwardIn failed for remote port ${remotePort}:`, err)
          reject(err)
          return
        }

        console.log(`[SSHManager] Reverse port forward established: remote:${remotePortBound} -> ${localHost}:${localPort}`)

        // Handle incoming connections from the remote side
        this.client!.on('tcpip', (info: { destPort: number; destIP: string; srcPort: number; srcIP: string }, accept: () => any, reject: () => any) => {
          // Only handle connections to our reverse forward port
          if (info.destPort !== remotePortBound) return

          try {
            const channel = accept()
            const net = require('net')
            const socket = net.connect(localPort, localHost, () => {
              console.log(`[SSHManager] Reverse forward connection: remote:${info.srcPort} -> ${localHost}:${localPort}`)
            })

            channel.pipe(socket).pipe(channel)

            socket.on('error', (err: Error) => {
              console.error('[SSHManager] Reverse forward socket error:', err)
              channel.close()
            })

            channel.on('error', (err: Error) => {
              console.error('[SSHManager] Reverse forward channel error:', err)
              socket.destroy()
            })

            socket.on('close', () => {
              channel.close()
            })

            channel.on('close', () => {
              socket.destroy()
            })
          } catch (err) {
            console.error('[SSHManager] Error accepting reverse forward connection:', err)
            try { reject() } catch { /* ignore */ }
          }
        })

        resolve(remotePortBound)
      })
    })
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this._ready
  }

  /**
   * Start an interactive shell session
   * Returns streams for bidirectional communication
   */
  async executeShell(): Promise<{
    stdout: Readable
    stderr: Readable
    stdin: Writable
  } | Error> {
    if (!this._ready || !this.client) {
      return new Error('Not connected')
    }

    console.log('[SSHManager] Starting interactive shell...')

    return new Promise((resolve) => {
      this.client!.shell((err, stream) => {
        if (err) {
          console.error('[SSHManager] Shell execution error:', err)
          return resolve(err)
        }

        console.log('[SSHManager] Interactive shell started')
        this.interactiveShell = stream
        resolve({
          stdout: stream,
          stderr: stream.stderr,
          stdin: stream
        })
      })
    })
  }

  /**
   * Write data to the interactive shell (uses existing shell session)
   */
  writeShell(data: string): void {
    if (!this.interactiveShell) {
      console.warn('[SSHManager] No active shell session to write to')
      return
    }
    this.interactiveShell.write(data)
  }

  /**
   * Disconnect from the remote server
   */
  disconnect(): void {
    // Close all local forward servers
    for (const [port, server] of this.localForwardServers) {
      try {
        server.close()
        console.log(`[SSHManager] Closed local port forward on ${port}`)
      } catch (e) {
        console.error(`[SSHManager] Error closing port forward ${port}:`, e)
      }
    }
    this.localForwardServers.clear()

    if (this.client) {
      console.log('[SSHManager] Disconnecting')
      this._ready = false
      this.client.end()
      this.client = null
      this.sftp = null
      this.config = null
      this.interactiveShell = null
    }
  }
}
