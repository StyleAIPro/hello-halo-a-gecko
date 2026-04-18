/**
 * Shared Terminal Service - 人机共享终端核心服务
 *
 * 功能：
 * 1. Agent 命令显示区（只读）- 拦截 SDK 命令，在 xterm 中显示
 * 2. 用户 Terminal 区（真实 PTY）- 本地 node-pty 或远程 SSH
 * 3. Terminal 输出存储 - 最近 N 行输出供 Agent 查询
 * 4. 双向同步 - Agent 命令在真实终端执行，用户操作 Agent 可感知
 */

import type { IPty } from 'node-pty';
import pty from 'node-pty';
import { SSHManager } from '../remote-ssh/ssh-manager';
import type { ClientChannel } from 'ssh2';
import { EventEmitter } from 'events';
import type { Readable, Writable } from 'stream';
import { getSpace } from '../space.service';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { remoteDeployService } from '../remote-deploy/remote-deploy.service';
import os from 'os';

// ==================== Types ====================

export interface TerminalSessionConfig {
  spaceId: string;
  conversationId: string;
  type: 'local' | 'ssh';
  sshConfig?: {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
  };
  workDir?: string;
}

export interface TerminalOutputLine {
  id: string;
  content: string;
  source: 'agent-command' | 'agent-output' | 'user-command' | 'user-output' | 'system';
  timestamp: string;
  commandId?: string;
}

export interface TerminalCommandRecord {
  id: string;
  command: string;
  source: 'agent' | 'user';
  output: string;
  exitCode: number | null;
  status: 'running' | 'completed' | 'error';
  timestamp: string;
  spaceId: string;
  conversationId: string;
}

export interface TerminalSessionState {
  config: TerminalSessionConfig;
  // PTY sessions
  userPty: IPty | null; // 用户真实操作的终端
  userProcess: ChildProcess | null; // Fallback using child_process
  sshManager: SSHManager | null; // SSH 连接（远程空间）
  sshStreams: { stdout: Readable; stderr: Readable; stdin: Writable } | null;
  sshChannel: ClientChannel | null; // SSH channel for resize support
  // Output buffer for agent query
  outputBuffer: TerminalOutputLine[];
  maxBufferLines: number;
  // Raw output buffer for reconnection replay (preserves ANSI codes)
  rawOutputBuffer: string;
  maxRawBufferSize: number;
  // Command history
  commandHistory: TerminalCommandRecord[];
  // Ready state
  ready: boolean;
}

// ==================== Terminal Session Class ====================

export class SharedTerminalSession extends EventEmitter {
  private state: TerminalSessionState;
  private _ready = false;
  private rawOutputDirty = false;

  constructor(config: TerminalSessionConfig) {
    super();
    this.state = {
      config,
      userPty: null,
      userProcess: null,
      sshManager: null,
      sshStreams: null,
      sshChannel: null,
      outputBuffer: [],
      maxBufferLines: 500, // 最近 500 行输出
      rawOutputBuffer: '', // Raw output for reconnection replay
      maxRawBufferSize: 100000, // ~100KB of raw output
      commandHistory: [],
      ready: false,
    };
  }

  /**
   * 启动终端会话
   */
  async start(): Promise<void> {
    console.log(
      `[SharedTerminal] Starting session for ${this.state.config.spaceId}:${this.state.config.conversationId}`,
    );

    if (this.state.config.type === 'ssh') {
      await this.startSSH();
    } else {
      await this.startLocal();
    }

    // Note: ready state is set and emitted inside startLocal/startSSH
    // to avoid double-trigger. If neither set ready, something went wrong.
    if (!this._ready) {
      throw new Error('Failed to start terminal session');
    }
  }

  /**
   * 启动本地终端
   */
  private async startLocal(): Promise<void> {
    return new Promise((resolve, reject) => {
      const shell =
        process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
      const args = process.platform === 'win32' ? [] : ['--login'];
      const cwd =
        this.state.config.workDir || process.env.HOME || process.env.USERPROFILE || process.cwd();

      console.log(`[SharedTerminal] Attempting to spawn PTY: shell=${shell}, cwd=${cwd}`);

      // Try node-pty first for full terminal support
      try {
        this.state.userPty = pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
          } as { [key: string]: string },
        });

        this.state.userPty.onData((data: string) => {
          this.emit('data', data);
          this.addToOutputBuffer(data, 'user-output');
        });

        this.state.userPty.onExit(({ exitCode }) => {
          this._ready = false;
          this.emit('exit', { exitCode });
        });

        console.log('[SharedTerminal] Local PTY started successfully');
        this._ready = true;
        this.state.ready = true;
        this.emit('ready');
        resolve();
        return;
      } catch (error) {
        console.warn(
          '[SharedTerminal] node-pty failed, falling back to child_process:',
          (error as Error).message,
        );
      }

      // Fallback: Use child_process with pseudo-terminal emulation
      try {
        console.log(`[SharedTerminal] Starting fallback terminal with child_process`);

        const fallbackArgs = process.platform === 'win32' ? [] : ['-i'];
        this.state.userProcess = spawn(shell, fallbackArgs, {
          cwd,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            FORCE_COLOR: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.state.userProcess.stdout?.on('data', (data: Buffer) => {
          const str = data.toString();
          this.emit('data', str);
          this.addToOutputBuffer(str, 'user-output');
        });

        this.state.userProcess.stderr?.on('data', (data: Buffer) => {
          const str = data.toString();
          this.emit('data', str);
          this.addToOutputBuffer(str, 'user-output');
        });

        this.state.userProcess.on('exit', (code) => {
          this._ready = false;
          this.emit('exit', { exitCode: code ?? 1 });
        });

        this.state.userProcess.on('error', (error) => {
          console.error('[SharedTerminal] Fallback terminal error:', error);
          reject(error);
        });

        console.log('[SharedTerminal] Fallback terminal started with child_process');
        this._ready = true;
        this.state.ready = true;
        this.emit('ready');
        resolve();
      } catch (error) {
        console.error('[SharedTerminal] Failed to start terminal (all methods):', error);
        reject(error);
      }
    });
  }

  /**
   * 启动 SSH 远程终端
   */
  private async startSSH(): Promise<void> {
    const { sshConfig } = this.state.config;

    if (!sshConfig) {
      throw new Error('SSH config is required for remote terminal');
    }

    try {
      this.state.sshManager = new SSHManager();
      await this.state.sshManager.connect(sshConfig);

      // 获取交互式 shell
      const result = await this.state.sshManager.executeShell();

      if (result instanceof Error) {
        throw result;
      }

      this.state.sshStreams = result;

      // Store the channel for resize support.
      // executeShell returns {stdout: stream, stderr: stream.stderr, stdin: stream}
      // where stream is a ClientChannel with setWindow(rows, cols, height, width)
      if ('setWindow' in result.stdout) {
        this.state.sshChannel = result.stdout as unknown as ClientChannel;
      }

      // 处理 stdout
      result.stdout.on('data', (data: Buffer) => {
        const str = data.toString();
        this.emit('data', str);
        this.addToOutputBuffer(str, 'user-output');
      });

      // 处理 stderr
      result.stderr.on('data', (data: Buffer) => {
        const str = data.toString();
        this.emit('data', str);
        this.addToOutputBuffer(str, 'user-output');
      });

      // 切换到指定工作目录
      const workDir = this.state.config.workDir;
      if (workDir) {
        console.log(`[SharedTerminal] Changing to work directory: ${workDir}`);
        result.stdin.write(`cd "${workDir}"\n`);
      }

      console.log('[SharedTerminal] SSH shell started');
      this._ready = true;
      this.state.ready = true;
      this.emit('ready');
    } catch (error) {
      console.error('[SharedTerminal] Failed to start SSH terminal:', error);
      throw error;
    }
  }

  /**
   * 写入数据到终端
   */
  write(data: string): void {
    if (!this._ready) {
      return;
    }

    if (this.state.userPty) {
      this.state.userPty.write(data);
    } else if (this.state.userProcess) {
      this.state.userProcess.stdin?.write(data);
    } else if (this.state.sshStreams) {
      this.state.sshStreams.stdin.write(data);
    }
  }

  /**
   * 执行命令（用于 Agent 命令在真实终端执行）
   */
  executeCommand(command: string): void {
    // 在真实终端中执行命令
    this.write(command + '\n');

    // 记录到命令历史
    const record: TerminalCommandRecord = {
      id: `cmd-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      command,
      source: 'agent',
      output: '',
      exitCode: null,
      status: 'running',
      timestamp: new Date().toISOString(),
      spaceId: this.state.config.spaceId,
      conversationId: this.state.config.conversationId,
    };

    this.state.commandHistory.push(record);
    this.addToOutputBuffer(`$ ${command}\n`, 'agent-command', record.id);
  }

  /**
   * 更新命令输出
   */
  updateCommandOutput(
    commandId: string,
    output: string,
    isComplete: boolean = false,
    exitCode?: number,
  ): void {
    const record = this.state.commandHistory.find((r) => r.id === commandId);
    if (record) {
      record.output += output;
      if (isComplete) {
        record.status = exitCode === 0 ? 'completed' : 'error';
        record.exitCode = exitCode ?? null;
      }
    }

    if (output) {
      this.addToOutputBuffer(output, 'agent-output', commandId);
    }
  }

  /**
   * 添加输出到缓冲区
   */
  private addToOutputBuffer(
    content: string,
    source: TerminalOutputLine['source'],
    commandId?: string,
  ): void {
    const lines = content.split('\n');
    const timestamp = new Date().toISOString();

    for (const line of lines) {
      if (line.trim()) {
        this.state.outputBuffer.push({
          id: `line-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          content: line,
          source,
          timestamp,
          commandId,
        });

        // 限制缓冲区大小
        if (this.state.outputBuffer.length > this.state.maxBufferLines) {
          this.state.outputBuffer.shift();
        }
      }
    }

    // Also save raw output for reconnection replay (only for user output)
    if (source === 'user-output') {
      this.state.rawOutputBuffer += content;
      // Limit raw buffer size - remove from beginning if too large
      if (this.state.rawOutputBuffer.length > this.state.maxRawBufferSize) {
        this.state.rawOutputBuffer = this.state.rawOutputBuffer.slice(-this.state.maxRawBufferSize);
      }
      this.rawOutputDirty = true;
    }

    this.emit('output', { content, source, commandId });
  }

  /**
   * 获取最近 N 行输出（供 Agent 查询）
   */
  getRecentOutput(lines: number = 100): TerminalOutputLine[] {
    return this.state.outputBuffer.slice(-lines);
  }

  /**
   * 获取原始输出缓冲区（用于重连时重放）
   */
  getRawOutputBuffer(): string {
    return this.state.rawOutputBuffer;
  }

  /**
   * 获取命令历史
   */
  getCommandHistory(): TerminalCommandRecord[] {
    return [...this.state.commandHistory];
  }

  /**
   * Check if raw output buffer has unsaved changes
   */
  isRawOutputDirty(): boolean {
    return this.rawOutputDirty;
  }

  /**
   * Mark raw output buffer as saved
   */
  markRawOutputClean(): void {
    this.rawOutputDirty = false;
  }

  /**
   * Restore command history from persistent storage
   */
  restoreCommandHistory(commands: TerminalCommandRecord[]): void {
    this.state.commandHistory = commands;
  }

  /**
   * Restore raw output buffer from persistent storage
   */
  restoreRawOutput(rawOutput: string): void {
    this.state.rawOutputBuffer = rawOutput;
    this.rawOutputDirty = false;
  }

  /**
   * 清空输出缓冲区
   */
  clearBuffer(): void {
    this.state.outputBuffer = [];
    this.emit('cleared');
  }

  /**
   * 清空命令历史
   */
  clearCommandHistory(): void {
    this.state.commandHistory = [];
  }

  /**
   * 调整终端大小
   */
  resize(cols: number, rows: number): void {
    if (this.state.userPty) {
      this.state.userPty.resize(cols, rows);
    } else if (this.state.sshChannel) {
      // SSH ClientChannel supports setWindow for PTY resize
      this.state.sshChannel.setWindow(rows, cols, rows * 16, cols * 8);
    }
    // child_process doesn't support resize
  }

  /**
   * 关闭会话
   */
  kill(): void {
    this._ready = false;

    if (this.state.userPty) {
      this.state.userPty.kill();
      this.state.userPty = null;
    }

    if (this.state.userProcess) {
      this.state.userProcess.kill();
      this.state.userProcess = null;
    }

    if (this.state.sshManager) {
      this.state.sshManager.disconnect();
      this.state.sshManager = null;
      this.state.sshStreams = null;
    }

    this.removeAllListeners();
    console.log('[SharedTerminal] Session killed');
  }

  /**
   * 检查是否就绪
   */
  isReady(): boolean {
    return this._ready;
  }

  /**
   * 获取会话状态
   */
  getState(): TerminalSessionState {
    return { ...this.state };
  }
}

// ==================== Service Manager ====================

/**
 * Shared Terminal Service - 管理所有终端会话
 */
export class SharedTerminalService extends EventEmitter {
  private sessions: Map<string, SharedTerminalSession> = new Map();
  // Track event forwarding handlers per session for cleanup
  private sessionForwarders: Map<
    string,
    Array<{ event: string; handler: (...args: any[]) => void }>
  > = new Map();

  /**
   * 获取或创建终端会话
   */
  async getOrCreateSession(
    sessionId: string,
    config: TerminalSessionConfig,
  ): Promise<SharedTerminalSession> {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.isReady()) {
      return existing;
    }

    // 关闭旧会话并清理其事件转发器
    if (existing) {
      // Remove old event forwarders from this service
      const oldForwarders = this.sessionForwarders.get(sessionId);
      if (oldForwarders) {
        for (const { handler } of oldForwarders) {
          this.removeListener('session:data', handler);
          this.removeListener('session:exit', handler);
          this.removeListener('session:output', handler);
        }
        this.sessionForwarders.delete(sessionId);
      }
      existing.kill();
      this.sessions.delete(sessionId);
    }

    // 创建新会话
    const session = new SharedTerminalSession(config);

    // Register event forwarders and track them for cleanup
    const forwarders: Array<{ event: string; handler: (...args: any[]) => void }> = [];

    const dataHandler = (data: string) => this.emit('session:data', sessionId, data);
    const exitHandler = (data: { exitCode: number }) => this.emit('session:exit', sessionId, data);
    const outputHandler = (output: any) => this.emit('session:output', sessionId, output);

    session.on('data', dataHandler);
    session.on('exit', exitHandler);
    session.on('output', outputHandler);

    forwarders.push({ event: 'session:data', handler: dataHandler as any });
    forwarders.push({ event: 'session:exit', handler: exitHandler as any });
    forwarders.push({ event: 'session:output', handler: outputHandler as any });
    this.sessionForwarders.set(sessionId, forwarders);

    await session.start();
    this.sessions.set(sessionId, session);

    return session;
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string): SharedTerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 获取或创建会话的终端会话（用于 backward compatibility）
   */
  async getUserSession(spaceId: string, conversationId: string): Promise<SharedTerminalSession> {
    const sessionId = `${spaceId}:${conversationId}`;
    const space = await getSpace(spaceId);

    let config: TerminalSessionConfig;

    if (space?.remoteServerId) {
      // Remote space - get SSH config from remote server
      const remoteServer = remoteDeployService.getServer(space.remoteServerId);

      if (remoteServer) {
        config = {
          spaceId,
          conversationId,
          type: 'ssh',
          sshConfig: {
            host: remoteServer.host,
            port: remoteServer.sshPort,
            username: remoteServer.username,
            password: remoteServer.password,
          },
          workDir: space?.remotePath || remoteServer.workDir || '/tmp',
        };
      } else {
        // Fallback to local if remote server not found
        console.warn(
          `[SharedTerminal] Remote server ${space.remoteServerId} not found, using local terminal`,
        );
        config = {
          spaceId,
          conversationId,
          type: 'local',
          workDir: space?.remotePath || process.env.HOME || os.homedir(),
        };
      }
    } else {
      // Local space - use local terminal
      config = {
        spaceId,
        conversationId,
        type: 'local',
        workDir: process.env.HOME || os.homedir(),
      };
    }

    return this.getOrCreateSession(sessionId, config);
  }

  /**
   * 关闭会话
   */
  killSession(sessionId: string): void {
    // Remove event forwarders
    const forwarders = this.sessionForwarders.get(sessionId);
    if (forwarders) {
      for (const { handler } of forwarders) {
        this.removeListener('session:data', handler);
        this.removeListener('session:exit', handler);
        this.removeListener('session:output', handler);
      }
      this.sessionForwarders.delete(sessionId);
    }
    const session = this.sessions.get(sessionId);
    if (session) {
      session.kill();
      this.sessions.delete(sessionId);
    }
  }

  /**
   * 关闭所有会话
   */
  killAllSessions(): void {
    // Remove all event forwarders
    for (const [sessionId, forwarders] of this.sessionForwarders.entries()) {
      for (const { handler } of forwarders) {
        this.removeListener('session:data', handler);
        this.removeListener('session:exit', handler);
        this.removeListener('session:output', handler);
      }
    }
    this.sessionForwarders.clear();
    for (const session of this.sessions.values()) {
      session.kill();
    }
    this.sessions.clear();
  }

  /**
   * 获取会话数量
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * 获取所有活跃会话的 sessionId 列表
   */
  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * 根据 conversationId 查找匹配的会话
   * sessionId 格式为 "${spaceId}:${conversationId}"
   */
  getSessionByConversationId(conversationId: string): SharedTerminalSession | undefined {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (sessionId.endsWith(`:${conversationId}`)) {
        return session;
      }
    }
    return undefined;
  }
}

// 导出单例
export const sharedTerminalService = new SharedTerminalService();
