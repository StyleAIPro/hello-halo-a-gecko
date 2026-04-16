/**
 * Terminal Gateway - WebSocket server for shared terminal
 *
 * Features:
 * - Real bidirectional terminal sessions (local via node-pty, remote via SSH)
 * - Intercepts Agent Bash tool calls and forwards to frontend
 * - Receives user commands from frontend and writes to real terminal
 * - Manages terminal sessions per conversation
 */

import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import { validateToken } from '../../http/auth';
import { EventEmitter } from 'events';
import { getMainWindow } from '../window.service';
import { sendToRenderer } from '../agent/helpers';
import { sharedTerminalService, type TerminalSessionConfig } from './shared-terminal-service';
import { getSpace } from '../space.service';
import {
  saveAgentCommand,
  loadAgentCommands,
  type AgentCommandRecord,
} from '../conversation.service';
import { remoteDeployService } from '../remote-deploy/remote-deploy.service';
import { type TerminalHistoryStore } from './terminal-history-store';
import {
  saveTerminalOutputImmediate,
  loadTerminalOutput,
  flushAllPendingOutputWrites,
} from './terminal-output-store';
import * as os from 'os';

export interface TerminalSession {
  spaceId: string;
  conversationId: string;
  ws: WebSocket;
  authenticated: boolean;
  commandHistory: TerminalCommand[];
}

export interface TerminalCommand {
  id: string;
  command: string;
  cwd?: string; // Current working directory for prompt display
  cwdLabel?: string; // Full prompt like "user@host path %"
  pathOnly?: string; // Just the last path component
  source: 'agent' | 'user';
  output: string;
  exitCode: number | null;
  status: 'running' | 'completed' | 'error';
  timestamp: string;
}

export interface TerminalMessage {
  type: string;
  data?: any;
}

// Store active terminal sessions (keyed by conversationId)
const sessions = new Map<string, TerminalSession>();

// Track command IDs we've already seen (avoids disk reads to determine isNewCommand)
const knownCommandIds = new Set<string>();

// Track pending commands awaiting output (keyed by conversationId:toolId)
const pendingCommands = new Map<string, string>();

// Store event listener disposers for each session (keyed by sessionId)
const sessionEventListeners = new Map<string, { onData: () => void; onExit: () => void }>();

// WebSocket server instance (separate from main WebSocket server)
let terminalWss: WebSocketServer | null = null;
const TERMINAL_PORT = 8765;

/**
 * Get cwd and display label for a space
 * Returns full prompt info for terminal-style display
 * For remote spaces, uses remote server's username and hostname
 * Always returns valid values, even if space is not found
 */
function getSpaceCwdInfo(spaceId: string): {
  cwd: string | undefined;
  cwdLabel: string; // Full prompt like "user@host path %"
  pathOnly: string; // Just the last path component
} {
  const space = getSpace(spaceId);

  // Get username and hostname from OS (default for local spaces)
  let username = process.env.USER || process.env.USERNAME || 'user';
  let hostname = os.hostname().split('.')[0] || 'localhost';
  const defaultPrompt = `${username}@${hostname} ~ % `;

  if (!space) {
    return { cwd: undefined, cwdLabel: defaultPrompt, pathOnly: '~' };
  }

  // Remote space - use remote server's username and hostname
  if (space.claudeSource === 'remote' && space.remoteServerId) {
    // Get remote server config to fetch username and host
    const remoteServer = remoteDeployService.getServer(space.remoteServerId);
    if (remoteServer) {
      username = remoteServer.username || username; // Use remote username
      hostname = remoteServer.host || hostname; // Use remote hostname
      console.log(`[TerminalGateway] Using remote server info: ${username}@${hostname}`);
    }

    // Extract last part of path for display
    const remotePath = space.remotePath || '/home';
    const pathParts = remotePath.split(/[/\\]/).filter(Boolean);
    const pathName = pathParts.length > 0 ? pathParts[pathParts.length - 1] : '~';
    const displayPath =
      pathParts.length > 1 ? `${pathParts[pathParts.length - 2]}/${pathName}` : pathName;
    return {
      cwd: remotePath,
      cwdLabel: `${username}@${hostname} ${displayPath} % `,
      pathOnly: pathName,
    };
  }

  // Local space - use workingDir or path
  const dir = space.workingDir || space.path;
  if (dir) {
    const pathParts = dir.split(/[/\\]/).filter(Boolean);
    const pathName = pathParts.length > 0 ? pathParts[pathParts.length - 1] : '~';
    const displayPath =
      pathParts.length > 1 ? `${pathParts[pathParts.length - 2]}/${pathName}` : pathName;
    return {
      cwd: dir,
      cwdLabel: `${username}@${hostname} ${displayPath} % `,
      pathOnly: pathName,
    };
  }

  // Fallback to default prompt
  return { cwd: undefined, cwdLabel: defaultPrompt, pathOnly: '~' };
}

/**
 * Terminal Gateway events
 */
export class TerminalGateway extends EventEmitter {
  private historyStore: TerminalHistoryStore | null = null;
  outputFlushTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Set the terminal history store. Called after platform initialization.
   */
  setHistoryStore(store: TerminalHistoryStore): void {
    this.historyStore = store;
    console.log('[TerminalGateway] History store attached');

    // Start periodic flush timer for raw output persistence
    this.outputFlushTimer = setInterval(() => this.flushDirtySessions(), 2000);
    console.log('[TerminalGateway] Raw output flush timer started (2s interval)');
  }

  /**
   * Flush all sessions with dirty raw output to disk.
   */
  flushDirtySessions(): void {
    const sessionIds = sharedTerminalService.getSessionIds();
    for (const sid of sessionIds) {
      const session = sharedTerminalService.getSession(sid);
      if (session && session.isRawOutputDirty()) {
        // Extract spaceId and conversationId from sessionId format: "${spaceId}:${conversationId}"
        const colonIdx = sid.indexOf(':');
        if (colonIdx > 0) {
          const spaceId = sid.substring(0, colonIdx);
          const conversationId = sid.substring(colonIdx + 1);
          const rawOutput = session.getRawOutputBuffer();
          saveTerminalOutputImmediate(spaceId, conversationId, rawOutput);
          session.markRawOutputClean();
        }
      }
    }
  }
  /**
   * Called when agent executes a bash command
   * - Sends event to frontend for display in Agent Terminal panel
   * - Persists command to disk for history
   * - Does NOT execute in user's terminal (user terminal is for user only)
   */
  onAgentCommand(
    spaceId: string,
    conversationId: string,
    command: string,
    output: string,
    status: 'running' | 'completed' | 'error',
    exitCode?: number,
    commandId?: string, // Optional: provide existing commandId to update instead of creating new
    cwd?: string, // Optional: provide specific cwd (overrides space default)
  ): void {
    const session = sessions.get(conversationId);

    // Use provided commandId or generate new one
    const id = commandId || `agent-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // Get cwd info from space
    const spaceCwdInfo = getSpaceCwdInfo(spaceId);
    // If a specific cwd is provided, override the space default
    if (cwd) {
      const pathParts = cwd.split(/[/\\]/).filter(Boolean);
      const pathName = pathParts.length > 0 ? pathParts[pathParts.length - 1] : '~';
      const displayPath =
        pathParts.length > 1 ? `${pathParts[pathParts.length - 2]}/${pathName}` : pathName;
      spaceCwdInfo.cwd = cwd;
      spaceCwdInfo.cwdLabel = `${process.env.USER || process.env.USERNAME || 'user'}@${os.hostname().split('.')[0]} ${displayPath} % `;
      spaceCwdInfo.pathOnly = pathName;
    }

    const terminalCommand: TerminalCommand = {
      id,
      command,
      cwd: spaceCwdInfo.cwd,
      cwdLabel: spaceCwdInfo.cwdLabel,
      pathOnly: spaceCwdInfo.pathOnly,
      source: 'agent',
      output,
      exitCode: exitCode ?? null,
      status,
      timestamp: new Date().toISOString(),
    };

    // Persist command to disk for history
    // Use in-memory tracking to determine isNewCommand instead of reading disk every time
    const isNewCommand = !commandId || !knownCommandIds.has(commandId);
    let existingRecord: AgentCommandRecord | undefined;
    let commandRecord: AgentCommandRecord;

    console.log(
      `[TerminalGateway] onAgentCommand: id=${id}, commandId=${commandId}, isNew=${isNewCommand}, status=${status}, output.length=${output?.length || 0}`,
    );

    if (isNewCommand) {
      // Track this command ID so we recognize updates later
      if (commandId) knownCommandIds.add(commandId);
      // New command - create full record
      commandRecord = {
        id,
        command,
        output,
        exitCode: exitCode ?? null,
        status,
        timestamp: terminalCommand.timestamp,
        conversationId,
        cwd: spaceCwdInfo.cwd,
        cwdLabel: spaceCwdInfo.cwdLabel,
      };
    } else {
      // Update existing command - load from disk only when updating
      const existingCommands = loadAgentCommands(spaceId, conversationId);
      existingRecord = existingCommands.find((c) => c.id === commandId);

      if (!existingRecord) {
        // Edge case: knownCommandIds had it but disk doesn't - treat as new
        commandRecord = {
          id,
          command,
          output,
          exitCode: exitCode ?? null,
          status,
          timestamp: terminalCommand.timestamp,
          conversationId,
          cwd: spaceCwdInfo.cwd,
          cwdLabel: spaceCwdInfo.cwdLabel,
        };
      } else {
        console.log(
          `[TerminalGateway] Updating command ${commandId}, newOutput.length=${output?.length || 0}`,
        );

        // Merge: keep original command/cwd, append output and update status/exitCode
        commandRecord = {
          ...existingRecord,
          output: output ? existingRecord.output + output : existingRecord.output,
          exitCode: exitCode ?? existingRecord.exitCode,
          status,
        };
        // Also update the terminalCommand for in-memory history
        terminalCommand.command = existingRecord.command;
        terminalCommand.cwd = existingRecord.cwd;
        terminalCommand.cwdLabel = existingRecord.cwdLabel;
        terminalCommand.pathOnly =
          existingRecord.cwdLabel?.split(' ').pop()?.replace('%', '').trim() ||
          existingRecord.cwd?.split('/').pop();
      }
    }
    saveAgentCommand(spaceId, conversationId, commandRecord);

    // Also persist to SQLite terminal history store
    if (this.historyStore) {
      if (isNewCommand) {
        this.historyStore.insertCommand({
          id: commandRecord.id,
          command: commandRecord.command,
          source: 'agent',
          output: commandRecord.output,
          exit_code: commandRecord.exitCode,
          status: commandRecord.status,
          space_id: spaceId,
          conversation_id: conversationId,
          cwd: commandRecord.cwd || null,
          cwd_label: commandRecord.cwdLabel || null,
          timestamp: commandRecord.timestamp,
          created_at_ms: new Date(commandRecord.timestamp).getTime(),
        });
      } else {
        this.historyStore.updateCommand(commandId || id, {
          output: commandRecord.output,
          status: commandRecord.status,
          exit_code: commandRecord.exitCode,
        });
      }
    }

    // Update in-memory history
    if (session) {
      if (isNewCommand) {
        session.commandHistory.push(terminalCommand);
      } else {
        // Update existing command in history
        const existingIndex = session.commandHistory.findIndex((cmd) => cmd.id === commandId);
        if (existingIndex >= 0) {
          session.commandHistory[existingIndex] = terminalCommand;
        } else {
          session.commandHistory.push(terminalCommand);
        }
      }
    }

    // NOTE: We do NOT execute agent commands in the user's terminal
    // The user's terminal is for user input only
    // Agent commands are displayed in the left panel (Agent Terminal)

    // Send to frontend - Agent Terminal (left panel)
    // Only send 'start' event for new commands, not for updates
    if (isNewCommand) {
      // Send via WebSocket if session exists
      if (session) {
        this.sendToSession(session, {
          type: 'terminal:agent-command-start',
          data: {
            id,
            command,
            cwd: spaceCwdInfo.cwd,
            cwdLabel: spaceCwdInfo.cwdLabel,
            pathOnly: spaceCwdInfo.pathOnly,
            source: 'agent',
            timestamp: terminalCommand.timestamp,
            conversationId,
          },
        });
        // For new commands, send a "running" status indicator immediately
        // This ensures users see real-time feedback even before output arrives
        this.sendToSession(session, {
          type: 'terminal:agent-command-output',
          data: {
            commandId: id,
            output: '\x1b[33m⏳ 正在执行...\x1b[0m',
            isStream: true,
          },
        });
      }
      // Also send via IPC for components not connected via WebSocket
      sendToRenderer('terminal:agent-command-start', spaceId, conversationId, {
        id,
        command,
        cwd: spaceCwdInfo.cwd,
        cwdLabel: spaceCwdInfo.cwdLabel,
        pathOnly: spaceCwdInfo.pathOnly,
        source: 'agent',
        timestamp: terminalCommand.timestamp,
        conversationId,
      });
      // Also send "running" status via IPC
      sendToRenderer('terminal:agent-command-output', spaceId, conversationId, {
        commandId: id,
        output: '\x1b[33m⏳ 正在执行...\x1b[0m',
        isStream: true,
        conversationId,
      });
    }

    // Always send output event for completed commands, even if output is empty
    // For running commands, only send if there's actual output
    const shouldSendOutput = status === 'completed' || status === 'error' || output;
    if (shouldSendOutput) {
      // For completed commands with no output, show a message
      const displayOutput =
        (status === 'completed' || status === 'error') && !output
          ? '\x1b[90m(命令执行完成，无输出)\x1b[0m'
          : output;

      if (session) {
        this.sendToSession(session, {
          type: 'terminal:agent-command-output',
          data: {
            commandId: id,
            output: displayOutput,
            isStream: status === 'running',
          },
        });
      }
      // Also send via IPC
      sendToRenderer('terminal:agent-command-output', spaceId, conversationId, {
        commandId: id,
        output: displayOutput,
        isStream: status === 'running',
        conversationId,
      });
    }

    // Send complete event only for completed/error status
    if (status === 'completed' || status === 'error') {
      if (session) {
        this.sendToSession(session, {
          type: 'terminal:agent-command-complete',
          data: {
            commandId: id,
            exitCode: exitCode ?? 0,
          },
        });
      }
      // Also send via IPC
      sendToRenderer('terminal:agent-command-complete', spaceId, conversationId, {
        commandId: id,
        exitCode: exitCode ?? 0,
        conversationId,
      });
    }
  }

  /**
   * Stream output for long-running commands
   * Also send via IPC for components not connected via WebSocket
   */
  streamOutput(conversationId: string, commandId: string, output: string, isStream = true): void {
    const session = sessions.get(conversationId);
    if (!session) return;

    // Update command in sharedTerminalService - use consistent sessionId format
    const sessionId = `${session.spaceId}:${conversationId}`;
    const terminalSession = sharedTerminalService.getSession(sessionId);
    if (terminalSession) {
      terminalSession.updateCommandOutput(commandId, output, !isStream);
    }

    // Send via WebSocket
    this.sendToSession(session, {
      type: 'terminal:agent-command-output',
      data: { commandId, output, isStream },
    });

    // Also send via IPC for components not connected via WebSocket
    sendToRenderer('terminal:agent-command-output', session.spaceId, conversationId, {
      commandId,
      output,
      isStream,
    });
  }

  /**
   * Handle user command from frontend
   * Writes to real terminal session
   */
  onUserCommand(spaceId: string, conversationId: string, command: string): void {
    const session = sessions.get(conversationId);
    if (!session) return;

    // Write to real terminal session (sharedTerminalService)
    const sessionId = `${spaceId}:${conversationId}`;
    const terminalSession = sharedTerminalService.getSession(sessionId);
    if (terminalSession) {
      terminalSession.write(command + '\n');
    }

    const commandId = `user-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const terminalCommand: TerminalCommand = {
      id: commandId,
      command,
      source: 'user',
      output: '',
      exitCode: null,
      status: 'running',
      timestamp: new Date().toISOString(),
    };

    session.commandHistory.push(terminalCommand);

    // Persist user command to SQLite history store
    if (this.historyStore) {
      this.historyStore.insertCommand({
        id: commandId,
        command,
        source: 'user',
        output: '',
        exit_code: null,
        status: 'running',
        space_id: spaceId,
        conversation_id: conversationId,
        cwd: null,
        cwd_label: null,
        timestamp: terminalCommand.timestamp,
        created_at_ms: new Date(terminalCommand.timestamp).getTime(),
      });
    }

    // Echo back to user (will show in terminal)
    this.sendToSession(session, {
      type: 'terminal:user-command',
      data: {
        commandId,
        command,
        source: 'user',
      },
    });

    // Notify renderer about user command for agent to process
    const mainWindow = getMainWindow();
    if (mainWindow) {
      console.log(`[TerminalGateway] User command written to terminal: ${command}`);
      sendToRenderer('terminal:user-command', spaceId, conversationId, {
        commandId,
        command,
        source: 'user',
      });
    }

    this.emit('user-command', { spaceId, conversationId, command, commandId });
  }

  /**
   * Create real terminal session (local or remote)
   */
  async createTerminalSession(spaceId: string, conversationId: string): Promise<void> {
    try {
      // Get space to determine if it's remote and get working directory
      const space = await getSpace(spaceId);

      let config: TerminalSessionConfig;

      if (space?.remoteServerId) {
        // Remote space - get SSH config from remote server
        console.log(
          '[TerminalGateway] Creating remote terminal session for server:',
          space.remoteServerId,
        );
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
          console.log('[TerminalGateway] Using SSH config:', {
            host: remoteServer.host,
            port: remoteServer.sshPort,
            username: remoteServer.username,
          });
        } else {
          // Fallback to local if remote server not found
          console.warn(
            `[TerminalGateway] Remote server ${space.remoteServerId} not found, using local terminal`,
          );
          config = {
            spaceId,
            conversationId,
            type: 'local',
            workDir: space?.remotePath || space?.workingDir || process.env.HOME || os.homedir(),
          };
        }
      } else {
        // Local space - use local terminal with space's workingDir
        console.log('[TerminalGateway] Creating local terminal session');
        config = {
          type: 'local',
          spaceId,
          conversationId,
          workDir: space?.workingDir || process.env.HOME || os.homedir(),
        };
      }

      // Use sharedTerminalService to create session with consistent sessionId
      const sessionId = `${spaceId}:${conversationId}`;

      // Get or create the terminal session
      const terminalSession = await sharedTerminalService.getOrCreateSession(sessionId, config);

      // Remove old event listeners if they exist (for reconnection scenarios)
      const oldListeners = sessionEventListeners.get(sessionId);
      if (oldListeners) {
        sharedTerminalService.off('session:data', oldListeners.onData);
        sharedTerminalService.off('session:exit', oldListeners.onExit);
        console.log(`[TerminalGateway] Removed old event listeners for ${sessionId}`);
      }

      // Always register fresh event listeners (for both new and reconnection)
      const onDataHandler = (sid: string, data: string) => {
        if (sid === sessionId) {
          const session = sessions.get(conversationId);
          if (session) {
            this.sendToSession(session, {
              type: 'terminal:data',
              data: { content: data },
            });
          }
        }
      };

      const onExitHandler = (sid: string, data: { exitCode: number }) => {
        if (sid === sessionId) {
          const session = sessions.get(conversationId);
          if (session) {
            this.sendToSession(session, {
              type: 'terminal:exit',
              data: { exitCode: data.exitCode },
            });
          }
        }
      };

      // Register event listeners
      sharedTerminalService.on('session:data', onDataHandler);
      sharedTerminalService.on('session:exit', onExitHandler);

      // Store listeners for cleanup on reconnection
      sessionEventListeners.set(sessionId, { onData: onDataHandler, onExit: onExitHandler });
      console.log(`[TerminalGateway] Registered event listeners for ${sessionId}`);

      // Wait for terminal to be ready
      await new Promise<void>((resolve) => {
        if (terminalSession.isReady()) {
          resolve();
        } else {
          terminalSession.once('ready', () => resolve());
        }
      });

      // Restore persisted history if history store is available
      if (this.historyStore) {
        const persistedCommands = this.historyStore.getCommandsForConversation(conversationId, 500);
        if (persistedCommands.length > 0) {
          const commands = persistedCommands.map((row) => ({
            id: row.id,
            command: row.command,
            source: row.source as 'agent' | 'user',
            output: row.output,
            exitCode: row.exit_code,
            status: row.status as 'running' | 'completed' | 'error',
            timestamp: row.timestamp,
            spaceId: row.space_id,
            conversationId: row.conversation_id,
          }));
          terminalSession.restoreCommandHistory(commands);
          console.log(
            `[TerminalGateway] Restored ${commands.length} commands from SQLite for ${conversationId}`,
          );
        }

        const persistedOutput = loadTerminalOutput(spaceId, conversationId);
        if (persistedOutput) {
          terminalSession.restoreRawOutput(persistedOutput);
          console.log(
            `[TerminalGateway] Restored ${persistedOutput.length} bytes of raw output for ${conversationId}`,
          );
        }
      }

      // Send history output to client (for reconnection scenarios)
      const rawHistory = terminalSession.getRawOutputBuffer();
      if (rawHistory) {
        console.log(
          `[TerminalGateway] Sending ${rawHistory.length} bytes of history to ${conversationId}`,
        );
      }

      // Send ready signal to client
      const session = sessions.get(conversationId);
      if (session) {
        // Send history output BEFORE ready signal so terminal can replay it
        if (rawHistory) {
          this.sendToSession(session, {
            type: 'terminal:history-output',
            data: { content: rawHistory },
          });
        }

        this.sendToSession(session, {
          type: 'terminal:ready',
          data: { sessionId },
        });
      }

      console.log('[TerminalGateway] Terminal session created and ready');
    } catch (error) {
      console.error('[TerminalGateway] Failed to create terminal session:', error);

      // Send error to client
      const session = sessions.get(conversationId);
      if (session) {
        this.sendToSession(session, {
          type: 'terminal:error',
          data: { error: error instanceof Error ? error.message : 'Unknown error' },
        });
      }
    }
  }

  /**
   * Send message to a specific session
   */
  private sendToSession(session: TerminalSession, message: TerminalMessage): void {
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify(message));
    }
  }
}

// Export singleton instance
export const terminalGateway = new TerminalGateway();

/**
 * Initialize Terminal WebSocket server
 */
export function initTerminalGateway(): void {
  if (terminalWss) {
    console.log('[TerminalGateway] Already initialized');
    return;
  }

  try {
    terminalWss = new WebSocketServer({ port: TERMINAL_PORT, path: '/terminal' });
    console.log(`[TerminalGateway] Server started on port ${TERMINAL_PORT}`);

    terminalWss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const spaceId = url.searchParams.get('spaceId') || '';
      const conversationId = url.searchParams.get('conversationId') || '';
      const token = url.searchParams.get('token') || '';

      console.log(`[TerminalGateway] Connection request: space=${spaceId}, conv=${conversationId}`);

      // Validate token - accept 'local-electron-mode' for local connections
      // or validate against accessToken for remote connections
      const isLocalMode = token === 'local-electron-mode';
      const isValidRemoteToken = validateToken(token);

      if (!isLocalMode && !isValidRemoteToken) {
        console.log('[TerminalGateway] Invalid token, closing connection');
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid token' }));
        setTimeout(() => ws.close(), 100);
        return;
      }

      if (!spaceId || !conversationId) {
        console.log('[TerminalGateway] Missing spaceId or conversationId');
        ws.send(JSON.stringify({ type: 'error', error: 'Missing spaceId or conversationId' }));
        setTimeout(() => ws.close(), 100);
        return;
      }

      // Create or update session
      const session: TerminalSession = {
        spaceId,
        conversationId,
        ws,
        authenticated: true,
        commandHistory: [],
      };

      // Remove existing session for same conversation (reconnection)
      const existingSession = sessions.get(conversationId);
      let existingCommandHistory: TerminalCommand[] = [];
      if (existingSession) {
        // Preserve command history from existing session
        existingCommandHistory = [...existingSession.commandHistory];
        // Mark existing session as replaced so its close handler doesn't delete the new session
        (existingSession as any)._replaced = true;
        existingSession.ws.close();
        sessions.delete(conversationId);
      } else {
        // No existing WebSocket session - try to recover command history from sharedTerminalService
        const sessionId = `${spaceId}:${conversationId}`;
        const terminalSession = sharedTerminalService.getSession(sessionId);
        if (terminalSession) {
          const terminalCmdHistory = terminalSession.getCommandHistory();
          existingCommandHistory = terminalCmdHistory.map((cmd) => ({
            id: cmd.id,
            command: cmd.command,
            source: cmd.source,
            output: cmd.output,
            exitCode: cmd.exitCode,
            status: cmd.status,
            timestamp: cmd.timestamp,
          }));
          if (existingCommandHistory.length > 0) {
            console.log(
              `[TerminalGateway] Recovered ${existingCommandHistory.length} commands from sharedTerminalService for ${conversationId}`,
            );
          }
        }
      }

      sessions.set(conversationId, session);
      console.log(`[TerminalGateway] Session created for conversation ${conversationId}`);

      // Create real terminal session
      terminalGateway.createTerminalSession(spaceId, conversationId).catch((err) => {
        console.error('[TerminalGateway] Failed to create terminal session:', err);
      });

      // Send connection success
      ws.send(
        JSON.stringify({
          type: 'terminal:connected',
          data: { spaceId, conversationId },
        }),
      );

      // Send command history (last 100 commands) - preserved from previous session or loaded from sharedTerminalService
      ws.send(
        JSON.stringify({
          type: 'terminal:history',
          data: { commands: existingCommandHistory.slice(-100) },
        }),
      );

      // Handle messages from client
      ws.on('message', (data: Buffer) => {
        try {
          const message: TerminalMessage = JSON.parse(data.toString());
          handleMessage(session, message);
        } catch (error) {
          console.error('[TerminalGateway] Failed to parse message:', error);
        }
      });

      // Handle disconnection
      ws.on('close', () => {
        // Check if this session was replaced by a new connection
        const currentSession = sessions.get(conversationId);
        if (currentSession === session) {
          // This is the current session, safe to delete
          console.log(`[TerminalGateway] Session closed for conversation ${conversationId}`);
          sessions.delete(conversationId);

          // Remove event listeners when WebSocket closes
          // NOTE: We keep the sharedTerminalService session alive to preserve terminal history
          // The PTY will continue running and can be reconnected later
          const sessionId = `${session.spaceId}:${conversationId}`;
          const listeners = sessionEventListeners.get(sessionId);
          if (listeners) {
            sharedTerminalService.off('session:data', listeners.onData);
            sharedTerminalService.off('session:exit', listeners.onExit);
            sessionEventListeners.delete(sessionId);
            console.log(`[TerminalGateway] Cleaned up event listeners for ${sessionId}`);
          }
        } else {
          // This session was replaced by a new connection, don't delete the new session
          console.log(
            `[TerminalGateway] Old session closed for conversation ${conversationId} (already replaced)`,
          );
        }
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error(`[TerminalGateway] Session error ${conversationId}:`, error);
        // Only delete if this is still the current session
        const currentSession = sessions.get(conversationId);
        if (currentSession === session) {
          sessions.delete(conversationId);
        }
      });
    });

    terminalWss.on('error', (error) => {
      console.error('[TerminalGateway] Server error:', error);
    });
  } catch (error) {
    console.error('[TerminalGateway] Failed to start server:', error);
  }
}

/**
 * Handle incoming message from terminal client
 */
function handleMessage(session: TerminalSession, message: TerminalMessage): void {
  switch (message.type) {
    case 'terminal:user-command':
      terminalGateway.onUserCommand(
        session.spaceId,
        session.conversationId,
        message.data?.command || '',
      );
      break;

    case 'terminal:raw-input':
      // Raw keyboard input from user's terminal - write directly to PTY
      if (message.data?.input) {
        const sessionId = `${session.spaceId}:${session.conversationId}`;
        const terminalSession = sharedTerminalService.getSession(sessionId);
        if (terminalSession) {
          terminalSession.write(message.data.input);
        }
      }
      break;

    case 'ping':
      session.ws.send(JSON.stringify({ type: 'pong' }));
      break;

    case 'terminal:resize':
      if (message.data?.cols && message.data?.rows) {
        const sessionId = `${session.spaceId}:${session.conversationId}`;
        const terminalSession = sharedTerminalService.getSession(sessionId);
        if (terminalSession) {
          terminalSession.resize(message.data.cols, message.data.rows);
        }
      }
      break;

    default:
      console.log('[TerminalGateway] Unknown message type:', message.type);
  }
}

/**
 * Shutdown Terminal Gateway
 */
export function shutdownTerminalGateway(): void {
  // Flush all dirty raw output to disk before closing
  terminalGateway.flushDirtySessions();
  flushAllPendingOutputWrites();

  // Stop periodic flush timer
  if (terminalGateway.outputFlushTimer) {
    clearInterval(terminalGateway.outputFlushTimer);
    terminalGateway.outputFlushTimer = null;
  }

  if (terminalWss) {
    // Close all sessions
    for (const session of Array.from(sessions.values())) {
      session.ws.close();
    }
    sessions.clear();

    terminalWss.close();
    terminalWss = null;
    console.log('[TerminalGateway] Server shutdown');
  }
}

/**
 * Get active session count
 */
export function getSessionCount(): number {
  return sessions.size;
}
