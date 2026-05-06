/**
 * Agent Module - Remote Send Message
 *
 * Remote message execution logic including:
 * - WebSocket connection to remote-agent-proxy
 * - SSH tunnel establishment
 * - MCP Bridge setup for remote tool calls
 * - Full streaming response handling
 * - Session persistence and resumption
 */

import type { BrowserWindow } from 'electron';
import { getConfig } from '../config.service';
import {
  getConversation,
  saveSessionId,
  addMessage,
  updateLastMessage,
} from '../conversation.service';
import { getRemoteDeployService } from '../../ipc/remote-server';
import {
  type RemoteWsClientConfig,
  registerActiveClient,
  acquireConnection,
  releaseConnection,
} from '../remote-ws/remote-ws-client';
import {
  type FileChangesSummary,
  extractFileChangesSummaryFromThoughts,
} from '../../../shared/file-changes';
import { decryptString } from '../auth/secure-storage.service';
import sshTunnelService from '../remote-ssh/ssh-tunnel.service';
import { SSHManager } from '../remote-ssh/ssh-manager';
import { getMcpProxyInstance } from '../mcp-proxy';
import { getAccessToken } from '../../http/auth';
import type { AgentRequest } from './types';
import {
  sendToRenderer,
} from './helpers';
import { createLogger } from '../../utils/logger';
import {
  createSessionState,
  registerActiveSession,
  unregisterActiveSession,
} from './session-manager';
import { AicoBotMcpBridge } from '../remote-ws/aico-bot-mcp-bridge';
import { terminalGateway } from '../terminal/terminal-gateway';

const log = createLogger('agent:remote');

/**
 * Execute remote message (via WebSocket to remote-agent-proxy)
 *
 * Features:
 * - Full message history for multi-turn conversations
 * - Session persistence and resumption
 * - Tool calls with approval flow
 * - Terminal output streaming
 * - Image attachments support
 */
export async function executeRemoteMessage(
  mainWindow: BrowserWindow | null,
  request: AgentRequest,
  serverId: string,
  remotePath: string,
  useSshTunnel?: boolean, // Use SSH port forwarding (localhost:8080) instead of direct connection
  systemPrompt?: string, // Custom system prompt for the space
): Promise<void> {
  log.debug(' ===== FUNCTION START =====');
  log.debug(' serverId=', serverId, 'remotePath=', remotePath, 'useSshTunnel=', useSshTunnel);
  const deployService = getRemoteDeployService();
  const server = deployService.getServer(serverId);

  if (!server) {
    throw new Error(`Remote server not found: ${serverId}`);
  }

  if (server.status !== 'connected') {
    throw new Error(`Remote server is not connected: ${server.name}`);
  }

  const {
    spaceId,
    conversationId,
    message,
    images,
    thinkingEnabled,
    aiBrowserEnabled,
    resumeSessionId,
  } = request;

  log.info(
    `Executing on server: ${serverId}, path: ${remotePath}, useSshTunnel=${useSshTunnel}, message: ${message.substring(0, 50)}...`,
  );

  // Get API key and model config
  // Priority: server card config (resolved via aiSourceId) > global AI source > legacy config
  // Each PC can configure different model services for the same remote server
  const config = getConfig();
  const sourceId = server.aiSourceId || config.aiSources?.currentId;
  const currentSource = sourceId
    ? config.aiSources?.sources?.find((s) => s.id === sourceId)
    : undefined;
  const apiKeyRaw = server.claudeApiKey || currentSource?.apiKey || config.api?.apiKey;
  const apiKey = apiKeyRaw ? decryptString(apiKeyRaw) : undefined;
  const baseUrl = server.claudeBaseUrl || currentSource?.apiUrl;
  const model =
    server.claudeModel || currentSource?.model || config.api?.model || 'claude-sonnet-4-6';
  log.info(`Using model: ${model}`);

  // Get conversation for message history and session ID
  const conversation = getConversation(spaceId, conversationId);
  const sessionId = resumeSessionId || conversation?.sessionId;

  // Add user message to conversation (with images if provided)
  addMessage(spaceId, conversationId, {
    role: 'user',
    content: message,
    images: images || [],
  });

  // Add assistant placeholder for streaming response
  addMessage(spaceId, conversationId, {
    role: 'assistant',
    content: '',
    toolCalls: [],
  });

  // CRITICAL: sessionState must be declared here (before try block) so it's accessible in catch block
  // It will be initialized inside the try block after abortController is created
  let sessionState: { thoughts: any[]; streamingContent?: string; isRemote?: boolean } | undefined;

  // CRITICAL: Declare these variables before try block so they're accessible in catch block
  // These need to be accessible in catch block for content persistence on abort
  let streamingContent = '';
  const streamChunks: string[] = [];
  const thoughts: any[] = [];
  const terminalOutputs: any[] = [];
  const toolCalls: any[] = [];
  const eventCleanups: Array<() => void> = []; // Event handler cleanup for pooled connections

  // WebSocket MCP Bridge — initialized early so it's accessible in catch block for cleanup
  let mcpBridge: AicoBotMcpBridge | null = null;

  try {
    // ── Phase 1: SSH tunnel establishment ──

    // SSH tunnel establishment (only if required)
    const sshTunnelPromise = (async (): Promise<number> => {
      let tunnelPort = server.assignedPort;
      if (useSshTunnel) {
        log.info(`Establishing SSH tunnel to ${server.host}:${server.assignedPort}...`);
        const decryptedPassword = decryptString(server.password || '');
        tunnelPort = await sshTunnelService.establishTunnel({
          spaceId,
          serverId,
          host: server.host,
          port: server.sshPort || 22,
          username: server.username,
          password: decryptedPassword,
          localPort: server.assignedPort,
          remotePort: server.assignedPort,
        });
        log.info(`SSH tunnel established on local port ${tunnelPort}`);
      }
      return tunnelPort;
    })().catch((err: Error) => {
      log.error('Failed to establish SSH tunnel:', err);
      throw new Error(`SSH tunnel failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    const localTunnelPort = await sshTunnelPromise;

    // Additional variables for SDK session management
    let sdkSessionId: string | undefined;
    // CRITICAL: effectiveSessionId always equals conversationId for consistent session
    // lookup on remote server. sdkSessionId (SDK's internal session ID) is only used
    // for the --resume parameter. This prevents session key mismatch across turns.
    const effectiveSessionId = conversationId;

    // Establish reverse SSH tunnel for MCP proxy (remote -> AICO-Bot)
    // NOTE: This is the legacy fallback path. The preferred path is WebSocket MCP Bridge
    // (mcp:tools:register), which doesn't need a reverse tunnel.
    // The reverse tunnel is skipped when useSshTunnel is true (WebSocket bridge is preferred).
    let mcpProxyRemotePort: number | null = null;
    const useWebSocketMcpBridge = true; // Always prefer WebSocket MCP Bridge
    if (useSshTunnel && !useWebSocketMcpBridge) {
      const mcpProxyInstance = getMcpProxyInstance();
      if (mcpProxyInstance) {
        try {
          mcpProxyRemotePort = await sshTunnelService.createReverseTunnel({
            serverId,
            spaceId,
            host: server.host,
            port: server.sshPort || 22,
            username: server.username,
            password: decryptString(server.password || ''),
            localPort: server.assignedPort,
            remotePort: server.assignedPort,
            remoteListenPort: 3848,
            localTargetPort: mcpProxyInstance.getPort(),
          });
          log.debug(
            `MCP proxy reverse tunnel established: remote:${mcpProxyRemotePort} -> local:${mcpProxyInstance.getPort()}`,
          );
        } catch (mcpTunnelError) {
          log.warn(`Failed to establish MCP proxy reverse tunnel (non-fatal):`, mcpTunnelError);
          mcpProxyRemotePort = null;
        }
      }
    } else if (useSshTunnel && useWebSocketMcpBridge) {
      log.debug(`Using WebSocket MCP Bridge (skipping reverse tunnel)`);
    }

    // ── Phase 2: Agent check/start + WebSocket connection (both depend on tunnel, independent of each other) ──

    // Helper: check remote agent is running (no auto-start)
    const checkAndStartAgent = async (): Promise<void> => {
      log.info(`Checking if remote agent is running...`);
      const isAgentRunning = await checkRemoteAgentRunning(serverId);
      log.debug(`Agent running status:`, isAgentRunning);

      if (!isAgentRunning) {
        throw new Error(
          `Remote agent proxy is not running on server "${server.name || serverId}". Please deploy and start the agent first.`,
        );
      }
      log.info(`Agent is already running`);
    };

    // Build WebSocket config (depends only on tunnel port, already available)
    const wsConfig: RemoteWsClientConfig = {
      serverId,
      host: useSshTunnel ? 'localhost' : server.host,
      port: useSshTunnel ? localTunnelPort : server.assignedPort,
      authToken: server.authToken || '',
      useSshTunnel,
      apiKey: apiKey || undefined,
      baseUrl: currentSource?.apiUrl || undefined,
      model: model || undefined,
    };
    log.info(`Creating WebSocket client with config:`, {
      useSshTunnel: wsConfig.useSshTunnel,
      host: wsConfig.host,
      port: wsConfig.port,
    });

    // sessionId is the SDK session ID for resumption (if available from a previous turn)
    const sessionId = resumeSessionId || conversation?.sessionId;

    // OPTIMIZATION: Run agent check and WebSocket connection in parallel.
    // Both only depend on the SSH tunnel being ready — they don't depend on each other.
    // acquireConnection just establishes the WebSocket to proxy; actual chat messages
    // are sent after both tasks complete.
    const [_, client] = await Promise.all([
      checkAndStartAgent(),
      acquireConnection(serverId, wsConfig, conversationId),
    ]);

    // Register this client for interrupt support
    // CRITICAL: Use conversationId (not effectiveSessionId) for consistent lookup in stopGeneration
    // This ensures the client can be found regardless of session resumption
    registerActiveClient(conversationId, client);

    // CRITICAL: Also register to activeSessions so stopGeneration can find this remote session
    // Without this, stopGeneration would skip the remote interrupt logic (it's inside if(session) block)
    const abortController = new AbortController();
    sessionState = createSessionState(spaceId, conversationId, abortController);
    sessionState.isRemote = true; // Mark this as a remote session
    sessionState.thoughts = thoughts; // Share reference (avoid array copies on every thought event)
    registerActiveSession(conversationId, sessionState);
    log.info(`Registered remote session to activeSessions for: ${conversationId}`);

    // ============================================
    // WebSocket MCP Bridge Setup
    // Register local MCP tools so remote Claude can call them
    // ============================================
    mcpBridge = new AicoBotMcpBridge();
    const mcpToolDefs = mcpBridge.collectTools(spaceId, !!aiBrowserEnabled);
    const mcpCapabilities = mcpBridge.getCapabilities();
    log.debug(
      `MCP Bridge: ${mcpToolDefs.length} tools, capabilities: ${JSON.stringify(mcpCapabilities)}`,
    );

    // Event handler cleanup - required for pooled connections to prevent stale handlers
    const addHandler = (event: string, handler: (...args: any[]) => void) => {
      client.on(event, handler);
      eventCleanups.push(() => client.off(event, handler));
    };

    // Handle incoming MCP tool calls from remote proxy
    addHandler('mcp:tool:call', async (data) => {
      if (data.sessionId === effectiveSessionId) {
        const { callId, toolName, arguments: toolArgs } = data.data;
        log.debug(`MCP tool call received: ${toolName} (callId=${callId})`);
        try {
          const result = await mcpBridge.handleToolCall(toolName, toolArgs);
          client.sendMcpToolResult(effectiveSessionId, callId, result);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log.error(`MCP tool call error (${toolName}):`, errorMessage);
          client.sendMcpToolError(effectiveSessionId, callId, errorMessage);
        }
      }
    });

    // Register event handlers for streaming response
    // Variables already declared above

    // SDK session ID event - capture for session resumption
    addHandler('claude:session', (data) => {
      if (data.sessionId === effectiveSessionId) {
        const receivedSdkSessionId = data.data?.sdkSessionId;
        if (receivedSdkSessionId) {
          sdkSessionId = receivedSdkSessionId;
          log.debug(`Captured SDK session_id: ${sdkSessionId}`);
        }
      }
    });

    // Tool call events - format matches frontend ToolCall interface
    // Track pending Bash commands (toolId -> commandId) for remote agent
    const remoteToolCommands = new Map<string, string>();
    // Track active commandId for terminal output streaming (only one Bash command runs at a time)
    let activeBashCommandId: string | null = null;
    // Accumulate terminal output for each commandId (to be used when tool:result arrives)
    const commandOutputBuffer = new Map<string, string>();

    // Helper function to get accumulated output for a command
    const getCommandOutput = (commandId: string): string => {
      return commandOutputBuffer.get(commandId) || '';
    };

    // Helper function to accumulate output for a command
    const accumulateCommandOutput = (commandId: string, output: string) => {
      const existing = commandOutputBuffer.get(commandId) || '';
      commandOutputBuffer.set(commandId, existing + output);
    };

    addHandler('tool:call', (data) => {
      if (data.sessionId === effectiveSessionId) {
        const toolData = data.data;
        log.debug(`Tool call received:`, {
          name: toolData.name,
          status: toolData.status,
          id: toolData.id,
          input: toolData.input ? JSON.stringify(toolData.input).substring(0, 200) : 'empty',
        });
        toolCalls.push(toolData);

        // Intercept Bash tool calls for terminal panel
        if (toolData.name === 'Bash' && toolData.input?.command) {
          const command = toolData.input.command as string;
          const toolId = toolData.id as string;
          log.debug(`Bash command intercepted: ${command}`);

          // Generate commandId and store for later update
          const commandId = `agent-${Date.now()}-${Math.random().toString(36).substring(7)}`;
          remoteToolCommands.set(toolId, commandId);
          // Set as active command for terminal output streaming
          activeBashCommandId = commandId;

          // Notify Terminal Gateway about agent command
          terminalGateway.onAgentCommand(
            spaceId,
            conversationId,
            command,
            '', // Output will come via terminal:output
            'running',
            undefined,
            commandId,
          );
        } else if (toolData.name === 'Bash') {
          log.warn(
            `Bash tool call received but input.command is missing:`,
            JSON.stringify(toolData.input),
          );
        }

        // Send in format expected by handleAgentToolCall
        sendToRenderer('agent:tool-call', spaceId, conversationId, {
          id: toolData.id,
          name: toolData.name,
          status: toolData.status || 'running',
          input: toolData.input || {},
          requiresApproval: false,
        });
      }
    });

    addHandler('tool:delta', (data) => {
      if (data.sessionId === effectiveSessionId) {
        // Handle tool delta for streaming tool input
        log.debug(`Tool delta received`);
        // Tool deltas are handled via thought events
      }
    });

    addHandler('tool:result', (data) => {
      if (data.sessionId === effectiveSessionId) {
        const toolData = data.data;
        // Try to get tool name from toolData, or look it up from remoteToolCommands map
        // The name field may be empty in some SDK responses, but we can infer it from the tool ID
        const toolName = toolData.name || (remoteToolCommands.has(toolData.id) ? 'Bash' : '');
        log.debug(
          `Tool result received, name=${toolData.name}, inferredName=${toolName}, output.length=${toolData.output?.length || 0}`,
        );

        // Notify Terminal Gateway about Bash command completion
        // Check both explicit name and inferred name (for remote commands tracked in remoteToolCommands)
        if (toolName === 'Bash') {
          const exitCode = toolData.exit_code !== undefined ? (toolData.exit_code as number) : 0;
          const toolId = toolData.id as string;
          const commandId = remoteToolCommands.get(toolId);

          if (commandId) {
            // Get accumulated terminal output (SDK's tool_result block may have empty content
            // while actual output was streamed via terminal:output events)
            const accumulatedOutput = getCommandOutput(commandId);
            // Use accumulated output if toolData.output is empty
            const finalOutput = toolData.output || accumulatedOutput;

            log.debug(
              `Updating Bash command ${commandId}, toolData.output.length=${toolData.output?.length || 0}, accumulated.length=${accumulatedOutput.length}, finalOutput.length=${finalOutput.length}`,
            );

            // Also send the command string (in case it wasn't preserved from tool:call)
            const commandString = (toolData.input?.command as string) || '';

            terminalGateway.onAgentCommand(
              spaceId,
              conversationId,
              commandString, // Command string from tool input
              finalOutput, // Use accumulated output if SDK output is empty
              'completed',
              exitCode,
              commandId, // Use stored commandId to update existing command
            );
            remoteToolCommands.delete(toolId);
            // Clear active command ID and output buffer
            if (activeBashCommandId === commandId) {
              activeBashCommandId = null;
            }
            commandOutputBuffer.delete(commandId);
          } else {
            log.warn(`No commandId found for tool ${toolId}`);
          }
        }

        sendToRenderer('agent:tool-result', spaceId, conversationId, {
          toolId: toolData.id,
          result: toolData.output || '',
          isError: false,
        });
      }
    });

    addHandler('tool:error', (data) => {
      if (data.sessionId === effectiveSessionId) {
        const toolData = data.data;
        log.error(`Tool error:`, toolData);
        sendToRenderer('agent:tool-result', spaceId, conversationId, {
          toolId: toolData.id,
          result: toolData.error || 'Tool execution failed',
          isError: true,
        });
      }
    });

    // Terminal output events
    addHandler('terminal:output', (data) => {
      if (data.sessionId === effectiveSessionId) {
        const output = data.data;
        log.debug(
          `terminal:output received: content.length=${output.content?.length || 0}, activeBashCommandId=${activeBashCommandId}`,
        );
        terminalOutputs.push(output);
        sendToRenderer('agent:terminal', spaceId, conversationId, output);

        // Accumulate output for the active command (to be saved when command completes)
        // This is critical because SDK's tool_result block may have empty content
        // while actual output is streamed via terminal:output events
        if (activeBashCommandId) {
          accumulateCommandOutput(activeBashCommandId, output.content || '');

          // Forward to Terminal Gateway for streaming to frontend
          terminalGateway.streamOutput(
            conversationId,
            activeBashCommandId, // Use tracked commandId for proper output association
            output.content || '',
            true, // isStream
          );
        } else {
          log.warn(`terminal:output received but no activeBashCommandId set`);
        }
      }
    });

    // Streaming text events - use agent:message format expected by frontend
    addHandler('claude:stream', (data) => {
      if (data.sessionId === effectiveSessionId) {
        const text = data.data?.text || data.data?.content || '';
        streamChunks.push(text);
        streamingContent = streamChunks.join('');
        // CRITICAL: Also update sessionState for error handling (preserve content on interrupt)
        sessionState.streamingContent = streamingContent;
        // Send in the format expected by handleAgentMessage
        sendToRenderer('agent:message', spaceId, conversationId, {
          delta: text,
          isStreaming: true,
          isComplete: false,
        });
      }
    });

    // Thought events - for thinking process display (aligned with local agent:thought)
    addHandler('thought', (data) => {
      if (data.sessionId === effectiveSessionId) {
        const thoughtData = data.data;
        log.debug(`Thought received: type=${thoughtData.type}, id=${thoughtData.id}`);

        // Store thought for final message
        thoughts.push(thoughtData);
        // sessionState.thoughts already points to the same array (no copy needed)

        // Send to renderer in the same format as local agent:thought
        // Spread agentId/agentName to top level so handleAgentThought can route to worker session
        sendToRenderer('agent:thought', spaceId, conversationId, {
          thought: thoughtData,
          ...(thoughtData.agentId && { agentId: thoughtData.agentId }),
          ...(thoughtData.agentName && { agentName: thoughtData.agentName }),
        });
      }
    });

    // Thought delta events - for streaming updates (aligned with local agent:thought-delta)
    addHandler('thought:delta', (data) => {
      if (data.sessionId === effectiveSessionId) {
        const deltaData = data.data;

        // Debug: Log tool result deltas
        if (deltaData.isToolResult || deltaData.toolResult) {
          log.debug(`Received thought:delta with toolResult for thought ${deltaData.thoughtId}`);
        }

        // Send to renderer in the same format as local agent:thought-delta
        sendToRenderer('agent:thought-delta', spaceId, conversationId, deltaData);

        // Update stored thought content/properties if applicable
        const thought = thoughts.find((t) => t.id === deltaData.thoughtId);
        if (thought) {
          // Update content (for thinking/text)
          if (deltaData.content) {
            thought.content = deltaData.content;
          }
          // Update tool result (for tool_use with result)
          if (deltaData.toolResult) {
            thought.toolResult = deltaData.toolResult;
            log.debug(`Updated toolResult for thought ${deltaData.thoughtId}`);
          }
          // Update tool input (when complete)
          if (deltaData.toolInput) {
            thought.toolInput = deltaData.toolInput;
          }
          // Update streaming state
          if (deltaData.isComplete !== undefined) {
            thought.isStreaming = !deltaData.isComplete;
          }
          // Update ready state (for tool_use)
          if (deltaData.isReady !== undefined) {
            thought.isReady = deltaData.isReady;
          }
          // sessionState.thoughts already points to the same array (no copy needed)
        }
      }
    });

    // MCP status events - forward to renderer (aligned with local agent:mcp-status)
    addHandler('mcp:status', (data) => {
      if (data.sessionId === effectiveSessionId) {
        log.debug(`MCP status received:`, data.data);
        // Import broadcastMcpStatus from mcp-manager
        import('./mcp-manager')
          .then(({ broadcastMcpStatus }) => {
            broadcastMcpStatus(data.data.servers);
          })
          .catch((err) => log.error(' Failed to import broadcastMcpStatus:', err));
      }
    });

    // Compact boundary events - context compression notification
    addHandler('compact:boundary', (data) => {
      if (data.sessionId === effectiveSessionId) {
        log.debug(`Compact boundary received:`, data.data);
        sendToRenderer('agent:compact', spaceId, conversationId, {
          type: 'compact',
          trigger: data.data.trigger,
          preTokens: data.data.preTokens,
        });
      }
    });

    // Subagent worker lifecycle events (from SDK Agent tool usage)
    addHandler('worker:started', (data) => {
      if (data.sessionId === effectiveSessionId) {
        log.debug(`Worker started: ${data.data.agentId} - ${data.data.agentName}`);
        sendToRenderer('worker:started', spaceId, conversationId, data.data);
      }
    });

    addHandler('worker:completed', (data) => {
      if (data.sessionId === effectiveSessionId) {
        log.debug(`Worker completed: ${data.data.agentId}`);
        sendToRenderer('worker:completed', spaceId, conversationId, data.data);
      }
    });

    // AskUserQuestion forwarding - remote Claude asks user a question
    addHandler('ask:question', (data) => {
      if (data.sessionId === effectiveSessionId) {
        log.debug(
          `AskUserQuestion: id=${data.data.id}, questions=${data.data.questions?.length || 0}`,
        );
        sendToRenderer('agent:ask-question', spaceId, conversationId, data.data);
      }
    });

    // Auth retry notification from remote proxy
    addHandler('auth_retry', (data) => {
      if (data.sessionId === effectiveSessionId) {
        log.info(`Auth retry in progress (remote): ${data.data?.attempt}/${data.data?.maxRetries}`);
        sendToRenderer('agent:auth-retry', spaceId, conversationId, data.data);
      }
    });

    // Text block start signal - for proper text block reset in frontend
    addHandler('text:block-start', (data) => {
      if (data.sessionId === effectiveSessionId) {
        sendToRenderer('agent:message', spaceId, conversationId, {
          type: 'message',
          content: '',
          isComplete: false,
          isStreaming: false,
          isNewTextBlock: true, // Signal: new text block started
        });
      }
    });

    // ============================================
    // Proxy Orchestrator Events (Phase 2)
    // These events come from the remote proxy's independent Hyper-Space orchestrator.
    // They are forwarded to the local agent orchestrator for injection into leader sessions.
    // ============================================

    addHandler('proxy:report', (data) => {
      if (data.sessionId === effectiveSessionId) {
        const eventData = data.data;
        log.debug(`Proxy report: from=${eventData.workerName}, type=${eventData.reportType}`);
        // Forward to local orchestrator for injection into the leader's session
        import('./orchestrator')
          .then(({ getAgentOrchestrator }) => {
            const orchestrator = getAgentOrchestrator();
            orchestrator.reportToLeader(eventData);
          })
          .catch((err) => log.error(' Failed to handle proxy:report:', err));
      }
    });

    addHandler('proxy:announce', (data) => {
      if (data.sessionId === effectiveSessionId) {
        const eventData = data.data;
        log.debug(`Proxy announce: worker=${eventData.workerName}, status=${eventData.status}`);
        import('./orchestrator')
          .then(({ getAgentOrchestrator }) => {
            const orchestrator = getAgentOrchestrator();
            orchestrator.sendAnnouncement(eventData);
          })
          .catch((err) => log.error(' Failed to handle proxy:announce:', err));
      }
    });

    addHandler('proxy:question', (data) => {
      if (data.sessionId === effectiveSessionId) {
        const eventData = data.data;
        log.debug(`Proxy question: from=${eventData.workerName}, target=${eventData.target}`);
        import('./orchestrator')
          .then(({ getAgentOrchestrator }) => {
            const orchestrator = getAgentOrchestrator();
            orchestrator.sendAgentMessage(eventData);
          })
          .catch((err) => log.error(' Failed to handle proxy:question:', err));
      }
    });

    addHandler('proxy:message', (data) => {
      if (data.sessionId === effectiveSessionId) {
        const eventData = data.data;
        log.debug(`Proxy message: from=${eventData.workerName}, to=${eventData.recipient}`);
        import('./orchestrator')
          .then(({ getAgentOrchestrator }) => {
            const orchestrator = getAgentOrchestrator();
            orchestrator.broadcastAgentMessage(eventData);
          })
          .catch((err) => log.error(' Failed to handle proxy:message:', err));
      }
    });

    // ============================================
    // Proxy App Status Events (Phase 3/4)
    // Remote proxy sends app status changes when a digital human is
    // created, triggered, paused, or completes a run.
    // ============================================

    addHandler('proxy:app:status', (data) => {
      const eventData = data.data;
      if (eventData._eventType === 'app:status') {
        log.debug(`Proxy app status: ${eventData.name} -> ${eventData.status}`);
        // Forward to renderer for UI display (status card in chat)
        sendToRenderer('app:status_changed', spaceId, conversationId, {
          appId: eventData.appId,
          name: eventData.name,
          status: eventData.status,
          lastRunAt: eventData.lastRunAt,
          lastRunOutcome: eventData.lastRunOutcome,
          lastErrorMessage: eventData.lastErrorMessage,
          activityEntries: eventData.activityEntries,
          isRemote: true,
        });
      } else {
        // Regular proxy:report event that contains app data
        // Already handled by proxy:report handler above
      }
    });

    // Register MCP tools with remote proxy (only once per connection lifetime)
    // registerMcpTools() internally checks send() return value and only sets
    // the flag when the message is actually sent successfully.
    if (mcpToolDefs.length > 0 && !client.mcpToolsRegistered) {
      const sent = client.registerMcpTools(mcpToolDefs, mcpCapabilities);
      if (sent) {
        log.info(`Registered ${mcpToolDefs.length} MCP tools with pooled connection`);
      } else {
        log.warn(
          `Failed to register ${mcpToolDefs.length} MCP tools — connection not ready, will retry on next message`,
        );
      }
    }

    // Build message payload - incremental when resuming a session
    // When sdkSessionId exists, the remote SDK already has full conversation context.
    // We only send the current user message (incremental) to reduce payload size.
    const sdkSessionIdForResume = sdkSessionId || sessionId;
    const isResumingSession = !!sdkSessionIdForResume;

    // Helper: build user message content with optional images
    const buildUserMessage = (text: string, imgs?: any[]): any => {
      const content: any[] = [{ type: 'text', text }];
      if (imgs && imgs.length > 0) {
        for (const image of imgs) {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mediaType,
              data: image.data,
            },
          });
        }
      }
      return {
        role: 'user',
        content: content.length === 1 ? content[0].text : content,
      };
    };

    let messagesToSend: Array<{ role: string; content: any }>;

    if (isResumingSession) {
      // Session resumption: remote SDK has full conversation context
      // Only send the current user message (incremental)
      messagesToSend = [buildUserMessage(message, images)];
      log.info(
        `Sending incremental message (session resumption, sdkSessionId=${sdkSessionIdForResume})`,
      );
    } else {
      // First message: send full history (remote SDK has no context yet)
      log.debug(`Building full message history for conversation ${conversationId}...`);

      const messageHistory: Array<{ role: string; content: any }> = [];

      if (conversation && conversation.messages) {
        // Filter out the last assistant placeholder message we just added
        const messagesForHistory = conversation.messages.slice(0, -1);

        for (const msg of messagesForHistory) {
          const content: any[] = [];
          if (msg.content) content.push({ type: 'text', text: msg.content });
          if (msg.images && msg.images.length > 0) {
            for (const image of msg.images) {
              content.push({
                type: 'image',
                source: { type: 'base64', media_type: image.mediaType, data: image.data },
              });
            }
          }
          messageHistory.push({
            role: msg.role,
            content: content.length === 1 && content[0].type === 'text' ? content[0].text : content,
          });
        }
      }

      messageHistory.push(buildUserMessage(message, images));
      messagesToSend = messageHistory;
      log.info(`Sending full history: ${messageHistory.length} messages (new session)`);
    }

    // CRITICAL: effectiveSessionId stays as conversationId throughout.
    // The server uses this as the key for its sessions Map.
    log.info(
      `Sending chat request to remote Claude (sessionId=${effectiveSessionId}, sdkSessionId=${sdkSessionIdForResume || 'new'}, workDir=${remotePath})...`,
    );

    const response = await client.sendChatWithStream(
      effectiveSessionId, // Conversation ID for WebSocket routing
      messagesToSend,
      {
        apiKey,
        baseUrl: baseUrl || undefined,
        model,
        maxTokens: config.agent?.maxTokens || 8192,
        system: systemPrompt || undefined, // Custom system prompt from space config
        maxThinkingTokens: thinkingEnabled ? 10240 : undefined,
        workDir: remotePath, // CRITICAL: Pass workDir from Space config
        sdkSessionId: sdkSessionIdForResume, // Pass SDK session ID for resumption
        contextWindow: currentSource?.contextWindow, // Context window for compression and display
        aicoBotMcpUrl: mcpProxyRemotePort
          ? `http://127.0.0.1:${mcpProxyRemotePort}/mcp`
          : undefined,
        aicoBotMcpToken: mcpProxyRemotePort ? await getAccessToken() : undefined,
      },
    );

    log.info(`Received response from remote Claude: ${response.content?.substring(0, 100)}...`);

    // Send final message content (the streaming already sent deltas)
    // response is { content: string, tokenUsage?: any }
    sendToRenderer('agent:message', spaceId, conversationId, {
      content: streamingContent || response.content,
      isComplete: true,
      isStreaming: false,
    });

    // Send completion event
    sendToRenderer('agent:complete', spaceId, conversationId, {});

    // Extract file changes summary for immediate display (aligned with local conversation)
    let metadata: { fileChanges?: FileChangesSummary } | undefined;
    if (thoughts.length > 0) {
      try {
        const fileChangesSummary = extractFileChangesSummaryFromThoughts(thoughts);
        if (fileChangesSummary) {
          metadata = { fileChanges: fileChangesSummary };
          log.info(
            `File changes: ${fileChangesSummary.totalFiles} files, +${fileChangesSummary.totalAdded} -${fileChangesSummary.totalRemoved}`,
          );
        }
      } catch (error) {
        log.error(`Failed to extract file changes:`, error);
      }
    }

    // Update the assistant message with the response
    // Note: Don't include toolCalls in final message - tools are already shown in thinking process
    // Instead, show file changes summary (aligned with local space behavior)
    // response is { content: string, tokenUsage?: any }
    updateLastMessage(spaceId, conversationId, {
      content: streamingContent || response.content,
      // toolCalls is intentionally NOT included - tools are displayed in thinking process
      terminalOutputs: terminalOutputs.length > 0 ? terminalOutputs : undefined,
      thoughts: thoughts.length > 0 ? thoughts : undefined,
      metadata,
      tokenUsage: response.tokenUsage,
    });

    // Save session ID for future resumption
    // Use SDK's real session ID if captured, otherwise fall back to conversationId
    const sessionToSave = sdkSessionId || sessionId;
    if (sessionToSave) {
      saveSessionId(spaceId, conversationId, sessionToSave);
      log.info(`Session ID saved: ${sessionToSave}`);
    }

    log.info(`Remote Claude execution completed`);

    // Clean up event handlers and release pooled connection
    for (const cleanup of eventCleanups) cleanup();
    releaseConnection(serverId, conversationId);

    // CRITICAL: Unregister active session after completion
    // This ensures that getSessionState returns isActive: false after completion,
    // preventing frontend from incorrectly restoring isGenerating state on refresh
    unregisterActiveSession(conversationId);
    log.info(`Unregistered active session: ${conversationId}`);
  } catch (error) {
    log.error(' Execute error:', error);
    const err = error as Error;

    // Check if this is an abort/stop action (user intentionally stopped)
    // Also check for AbortError name (standard abort signal)
    // Use case-insensitive matching for 'interrupt' to match 'Interrupted by user'
    const isAbort =
      err.name === 'AbortError' ||
      err.message?.includes('aborted') ||
      err.message?.toLowerCase().includes('interrupt');

    // CRITICAL: Use sessionState for content/thoughts - it's updated in real-time by event handlers
    // This ensures we have the latest accumulated content even if interrupt happened mid-stream
    // Note: sessionState may be undefined if error occurred before it was initialized
    const accumulatedContent = sessionState?.streamingContent || streamingContent;
    const accumulatedThoughts =
      (sessionState?.thoughts?.length ?? 0) > 0 ? sessionState!.thoughts : thoughts;

    // Always persist already generated content and thoughts
    // This ensures content survives after stop and page refresh
    const hasContent = accumulatedContent.length > 0;
    const hasThoughts = accumulatedThoughts.length > 0;

    if (hasContent || hasThoughts) {
      log.debug(
        `Persisting on abort: ${accumulatedContent.length} chars, ${accumulatedThoughts.length} thoughts`,
      );
    }

    // CRITICAL: Update the assistant message with accumulated content and thoughts
    // This is the same logic as the normal completion path
    updateLastMessage(spaceId, conversationId, {
      content: accumulatedContent, // Keep already generated content
      terminalOutputs: terminalOutputs.length > 0 ? terminalOutputs : undefined,
      thoughts: hasThoughts ? accumulatedThoughts : undefined, // Keep already generated thoughts
      error: isAbort ? undefined : err.message, // Only show error if not user-initiated abort
    });

    // CRITICAL: Send completion event to notify frontend to stop streaming and reload
    // This ensures the frontend knows the generation is complete and can display the final content
    sendToRenderer('agent:complete', spaceId, conversationId, {});

    // Clean up event handlers and release pooled connection on error too
    try {
      for (const cleanup of eventCleanups) cleanup();
      releaseConnection(serverId, conversationId);
    } catch {}

    // CRITICAL: Unregister active session on error too
    // This ensures that getSessionState returns isActive: false after error,
    // preventing frontend from incorrectly restoring isGenerating state on refresh
    unregisterActiveSession(conversationId);
    log.info(`Unregistered active session on error: ${conversationId}`);

    // Clean up MCP bridge
    mcpBridge?.dispose();

    // Don't throw if user intentionally stopped
    if (!isAbort) {
      throw err;
    }
  }
}

/**
 * Check if remote agent is running
 */
async function checkRemoteAgentRunning(serverId: string): Promise<boolean> {
  const deployService = getRemoteDeployService();
  const server = deployService.getServer(serverId);

  if (!server) {
    return false;
  }

  // Ensure SSH connection is established before checking
  try {
    await deployService.ensureSshConnection(serverId);
  } catch {
    return false;
  }

  const manager = deployService.getSSHManagerForServer(serverId);
  if (!manager) {
    return false;
  }

  try {
    // Check 1: Check if the node process is running from the deployment directory
    const processResult = await manager.executeCommandFull(
      `pgrep -f "node.*dist/index.js" || echo "NO_PROCESS"`,
    );
    if (processResult.stdout.includes('NO_PROCESS')) {
      return false;
    }

    // Check 2: Check if the port is listening
    const portResult = await manager.executeCommandFull(
      `(ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep ":${server.assignedPort}" || echo "NOT_LISTENING"`,
    );

    return !portResult.stdout.includes('NOT_LISTENING');
  } catch {
    return false;
  }
}
