/**
 * Terminal Service - Provides real terminal sessions
 *
 * Features:
 * - Local terminal using node-pty
 * - Remote terminal via SSH
 * - Bidirectional I/O streaming
 */

import type { IPty } from 'node-pty';
import pty from 'node-pty';
import { SSHManager } from '../remote-ssh/ssh-manager';
import { EventEmitter } from 'events';
import type { Readable, Writable } from 'stream';
import os from 'os';

export interface TerminalSessionConfig {
  type: 'local' | 'remote';
  spaceId: string;
  conversationId: string;
  workDir?: string;
  sshConfig?: {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
  };
}

export interface TerminalData {
  data: string;
  timestamp: string;
}

export interface TerminalError {
  error: string;
  timestamp: string;
}

/**
 * Terminal session with PTY
 */
export class TerminalSession extends EventEmitter {
  private ptyProcess: IPty | null = null;
  private sshManager: SSHManager | null = null;
  private sshStreams: { stdout: Readable; stderr: Readable; stdin: Writable } | null = null;
  private config: TerminalSessionConfig;
  private _ready = false;

  constructor(config: TerminalSessionConfig) {
    super();
    this.config = config;
  }

  /**
   * Initialize terminal session
   */
  async start(): Promise<void> {
    if (this.config.type === 'remote') {
      return this.startRemote();
    } else {
      return this.startLocal();
    }
  }

  /**
   * Start local terminal using node-pty
   */
  private async startLocal(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
        const args = process.platform === 'win32' ? [] : ['--login'];

        this.ptyProcess = pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: this.config.workDir || process.env.HOME || os.homedir() || process.cwd(),
          env: process.env as { [key: string]: string },
        });

        this.ptyProcess.onData((data: string) => {
          this.emit('data', { data, timestamp: new Date().toISOString() });
        });

        this.ptyProcess.onExit(({ exitCode }) => {
          this._ready = false;
          this.emit('exit', { exitCode, timestamp: new Date().toISOString() });
        });

        this._ready = true;
        console.log('[TerminalSession] Local terminal started');
        resolve();
      } catch (error) {
        console.error('[TerminalSession] Failed to start local terminal:', error);
        reject(error);
      }
    });
  }

  /**
   * Start remote terminal via SSH
   */
  private async startRemote(): Promise<void> {
    if (!this.config.sshConfig) {
      throw new Error('SSH config is required for remote terminal');
    }

    try {
      this.sshManager = new SSHManager();
      await this.sshManager.connect(this.config.sshConfig);

      // Execute interactive shell
      const result = await this.sshManager.executeShell();

      if (result instanceof Error) {
        throw result;
      }

      this.sshStreams = result;

      // Handle stdout
      result.stdout.on('data', (data: Buffer) => {
        this.emit('data', { data: data.toString(), timestamp: new Date().toISOString() });
      });

      // Handle stderr
      result.stderr.on('data', (data: Buffer) => {
        this.emit('data', { data: data.toString(), timestamp: new Date().toISOString() });
      });

      this._ready = true;
      console.log('[TerminalSession] Remote terminal started');
    } catch (error) {
      console.error('[TerminalSession] Failed to start remote terminal:', error);
      throw error;
    }
  }

  /**
   * Write data to terminal
   */
  write(data: string): void {
    if (!this._ready) {
      console.warn('[TerminalSession] Terminal not ready');
      return;
    }

    if (this.ptyProcess) {
      this.ptyProcess.write(data);
    } else if (this.sshStreams) {
      this.sshStreams.stdin.write(data);
    }
  }

  /**
   * Resize terminal
   */
  resize(cols: number, rows: number): void {
    if (this.ptyProcess) {
      this.ptyProcess.resize(cols, rows);
    }
  }

  /**
   * Kill terminal session
   */
  kill(): void {
    this._ready = false;

    if (this.ptyProcess) {
      this.ptyProcess.kill();
      this.ptyProcess = null;
    }

    if (this.sshManager) {
      this.sshManager.disconnect();
      this.sshManager = null;
      this.sshStreams = null;
    }

    this.removeAllListeners();
    console.log('[TerminalSession] Terminal killed');
  }

  /**
   * Check if terminal is ready
   */
  isReady(): boolean {
    return this._ready;
  }
}

/**
 * Terminal Service - manages multiple terminal sessions
 */
export class TerminalService extends EventEmitter {
  private sessions: Map<string, TerminalSession> = new Map();

  /**
   * Create or get terminal session
   */
  async getOrCreateSession(
    sessionId: string,
    config: TerminalSessionConfig,
  ): Promise<TerminalSession> {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.isReady()) {
      return existing;
    }

    const session = new TerminalSession(config);

    session.on('data', (data: TerminalData) => {
      this.emit('session:data', sessionId, data);
    });

    session.on('exit', (data: { exitCode: number; timestamp: string }) => {
      this.emit('session:exit', sessionId, data);
      this.sessions.delete(sessionId);
    });

    session.on('error', (error: TerminalError) => {
      this.emit('session:error', sessionId, error);
    });

    await session.start();
    this.sessions.set(sessionId, session);

    return session;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Write to session
   */
  writeToSession(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.write(data);
    } else {
      console.warn(`[TerminalService] Session ${sessionId} not found`);
    }
  }

  /**
   * Kill session
   */
  killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.kill();
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Kill all sessions
   */
  killAllSessions(): void {
    for (const [sessionId, session] of this.sessions.entries()) {
      session.kill();
    }
    this.sessions.clear();
  }
}

// Export singleton instance
export const terminalService = new TerminalService();
