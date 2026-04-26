/**
 * Agent Module - Send Message
 *
 * Core message sending logic including:
 * - API credential resolution and routing
 * - V2 Session management
 * - SDK message streaming and processing
 * - Token-level streaming support
 * - Error handling and recovery
 */

import type { BrowserWindow } from 'electron';
import { getConfig } from '../config.service';
import {
  getConversation,
  saveSessionId,
  addMessage,
  updateLastMessage,
} from '../conversation.service';
import { getSpace } from '../space.service';
import { getRemoteDeployService } from '../../ipc/remote-server';
import {
  RemoteWsClient,
  type RemoteWsClientConfig,
  registerActiveClient,
  acquireConnection,
  releaseConnection,
} from '../remote-ws/remote-ws-client';
import {
  type FileChangesSummary,
  extractFileChangesSummaryFromThoughts,
} from '../../../shared/file-changes';
import { notifyTaskComplete } from '../notification.service';
import { decryptString } from '../secure-storage.service';
import sshTunnelService from '../remote-ssh/ssh-tunnel.service';
import { SSHManager } from '../remote-ssh/ssh-manager';
import {
  AI_BROWSER_SYSTEM_PROMPT,
  createAIBrowserMcpServer,
  initializeAIBrowser,
} from '../ai-browser';
import { GH_SEARCH_SYSTEM_PROMPT, createGhSearchMcpServer } from '../gh-search';
import { createAicoBotAppsMcpServer } from '../../apps/conversation-mcp';
import { createHyperSpaceMcpServer } from './hyper-space-mcp';
import { getMcpProxyInstance } from '../mcp-proxy';
import { getAccessToken } from '../../http/auth';
import type { AgentRequest, SessionConfig } from './types';
import {
  getHeadlessElectronPath,
  getWorkingDir,
  getApiCredentials,
  getEnabledMcpServers,
  sendToRenderer,
  setMainWindow,
} from './helpers';
import { buildSystemPromptWithAIBrowser } from './system-prompt';
import { createLogger } from '../../utils/logger';

const log = createLogger('agent:remote');
import {
  getOrCreateV2Session,
  closeV2Session,
  createSessionState,
  registerActiveSession,
  unregisterActiveSession,
  v2Sessions,
  markSessionRequestStart,
  markSessionRequestComplete,
  activeSessions,
} from './session-manager';
import { formatCanvasContext, buildMessageContent } from './message-utils';
import { resolveCredentialsForSdk, buildBaseSdkOptions } from './sdk-config';
import { processStream, getAndClearInjection, type PendingInjection } from './stream-processor';
import { AicoBotMcpBridge } from '../remote-ws/aico-bot-mcp-bridge';
import { terminalGateway } from '../terminal/terminal-gateway';
import { agentOrchestrator } from './orchestrator';

// Unified fallback error suffix - guides user to check logs
const FALLBACK_ERROR_HINT = 'Check logs in Settings > System > Logs.';

// ============================================
// Auth Token Cache for Remote Connections
// ============================================

// ============================================
// Send Message
// ============================================

/**
 * Send message to agent (supports multiple concurrent sessions)
 *
 * This is the main entry point for sending messages to the AI agent.
 * It handles:
 * - API credential resolution (Anthropic, OpenAI, OAuth providers)
 * - V2 Session creation/reuse
 * - Message streaming with token-level updates
 * - Tool calls and permissions
 * - Error handling and recovery
 */
export async function sendMessage(
  mainWindow: BrowserWindow | null,
  request: AgentRequest,
): Promise<void> {
  setMainWindow(mainWindow);

  const {
    spaceId,
    conversationId,
    message,
    resumeSessionId,
    images,
    aiBrowserEnabled,
    thinkingEnabled,
    canvasContext,
  } = request;

  console.log('[Agent] ========== FUNCTION START ==========');
  console.log('[Agent] sendMessage: conv=', conversationId);
  console.log('[Agent] sendMessage: spaceId=', spaceId);

  // === Remote execution routing ===
  console.log('[Agent] ===== BEFORE GETSPACE =====');
  console.log('[Agent] getSpace function type:', typeof getSpace);
  console.log('[Agent] ===== AFTER GETSPACE =====');
  console.log(`[Agent] About to call getSpace with spaceId=${spaceId}`);
  const space = getSpace(spaceId);
  console.log(
    `[Agent] getSpace returned:`,
    space
      ? {
          id: space.id,
          name: space.name,
          claudeSource: space.claudeSource,
          remoteServerId: space.remoteServerId,
          useSshTunnel: space.useSshTunnel,
        }
      : 'null',
  );
  console.log(
    `[Agent] Remote routing check: space=${space ? space.name : 'null'}, claudeSource=${space?.claudeSource}, remoteServerId=${space?.remoteServerId}, useSshTunnel=${space?.useSshTunnel}`,
  );
  if (space?.claudeSource === 'remote' && space.remoteServerId) {
    // Default to using SSH tunnel for security (most servers don't expose ports publicly)
    const useSshTunnel = space.useSshTunnel !== false; // Default true, only false if explicitly set
    console.log(
      `[Agent] *** ROUTING TO REMOTE EXECUTION *** server=${space.remoteServerId}, path=${space.remotePath || '/home'}, useSshTunnel=${useSshTunnel}`,
    );
    try {
      console.log('[Agent] Calling executeRemoteMessage...');
      await executeRemoteMessage(
        mainWindow,
        request,
        space.remoteServerId,
        space.remotePath || '/home',
        useSshTunnel,
        space.systemPrompt,
      );
      console.log('[Agent] executeRemoteMessage completed');
    } catch (error) {
      console.error('[Agent] executeRemoteMessage error:', error);
      throw error;
    }
    return;
  }
  // === Remote routing end ===

  // === Hyper Space execution routing ===
  // Hyper Space routes messages to specific agents based on agentId
  // - With @mention: agentId is specified, route to that agent
  // - Without @mention: default to leader agent
  if (space?.spaceType === 'hyper' && space.agents && space.agents.length > 0) {
    const targetAgentId = request.agentId || 'leader'; // Default to leader if not specified
    console.log(
      `[Agent] *** ROUTING TO HYPER SPACE *** spaceId=${spaceId}, targetAgentId=${targetAgentId}`,
    );

    try {
      // Ensure team exists for this space
      let team = agentOrchestrator.getTeamBySpace(spaceId);
      if (!team) {
        // Create team from space configuration
        team = agentOrchestrator.createTeam({
          spaceId,
          conversationId,
          agents: space.agents,
          config: space.orchestration,
        });
        console.log(`[Agent] Created new team ${team.id} for Hyper Space ${spaceId}`);
      }

      // Find the target agent (leader or specific worker)
      const targetAgent = agentOrchestrator.findAgentInTeam(team, targetAgentId);
      if (!targetAgent) {
        throw new Error(`Agent ${targetAgentId} not found in team ${team.id}`);
      }

      console.log(
        `[Agent] Routing message to agent: ${targetAgent.config.name} (${targetAgent.id})`,
      );

      // Build user message content (with images if provided)
      const userContent = await buildMessageContent(message, images);

      // Add user message to conversation
      addMessage(spaceId, conversationId, {
        role: 'user',
        content: message,
        images: images,
      });

      // Add placeholder for assistant response
      addMessage(spaceId, conversationId, {
        role: 'assistant',
        content: '',
        toolCalls: [],
        agentId: targetAgentId,
        agentName: targetAgent.config.name,
        agentRole: targetAgent.config.role,
      });

      // Determine if this is a @mention direct selection or default routing to leader
      // - With @mention: agentId is explicitly specified, agent should answer directly
      // - Without @mention (agentId defaults to 'leader'): Leader can delegate to workers
      const isDirectMention = request.agentId && request.agentId !== 'leader';

      // Build appropriate system prompt based on routing type
      let routingPrompt = '';
      if (isDirectMention) {
        // @mention: Agent should answer directly without delegating
        routingPrompt = `[IMPORTANT: You have been directly selected by the user via @${targetAgent.config.name || targetAgent.id}. The user wants YOU to answer their question directly. Do NOT use spawn_subagent or delegate to other agents. Answer their question directly and helpfully.]\n\n`;
      }
      // For Leader default routing: NO prompt restriction - Leader is free to delegate!

      // Get team context for the agent (includes delegation instructions for leaders)
      const teamContext = await agentOrchestrator.getTeamContextForPrompt(spaceId, targetAgent.id);

      const combinedSystemPrompt = targetAgent.config.systemPromptAddition
        ? `${routingPrompt}${teamContext}\n\n${targetAgent.config.systemPromptAddition}`
        : `${routingPrompt}${teamContext}`;

      // For @mention mode: emit worker:started so frontend creates a WorkerSessionState
      // with interactionMode: 'mention' — this causes worker output to display inline in main conversation
      const mentionTaskId = `mention-${Date.now()}`;
      if (isDirectMention) {
        sendToRenderer('worker:started', spaceId, conversationId, {
          agentId: targetAgent.id,
          agentName: targetAgent.config.name || targetAgent.id,
          taskId: mentionTaskId,
          task: message,
          type: targetAgent.config.type || 'local',
          interactionMode: 'mention',
        });
      }

      try {
        // Execute on the target agent's session
        await agentOrchestrator.executeOnSingleAgent({
          team,
          agent: targetAgent,
          task: message,
          conversationId,
          systemPrompt: combinedSystemPrompt,
        });
      } finally {
        if (isDirectMention) {
          // Emit worker:completed for mention mode
          sendToRenderer('worker:completed', spaceId, conversationId, {
            agentId: targetAgent.id,
            agentName: targetAgent.config.name || targetAgent.id,
            taskId: mentionTaskId,
            status: 'completed',
          });
        }
      }

      // Notify task complete
      notifyTaskComplete(space.name || 'Hyper Space');

      console.log('[Agent] Hyper Space execution completed');
      return;
    } catch (error) {
      console.error('[Agent] Hyper Space execution error:', error);

      // Update assistant message with error
      updateLastMessage(spaceId, conversationId, {
        content: `Hyper Space execution failed: ${error instanceof Error ? error.message : String(error)}`,
      });

      // Notify renderer of error
      sendToRenderer('agent:error', spaceId, conversationId, {
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }
  // === Hyper Space routing end ===

  const config = getConfig();
  const workDir = getWorkingDir(spaceId);

  // Create abort controller for this session
  const abortController = new AbortController();

  // Accumulate stderr for detailed error messages
  let stderrBuffer = '';

  // Create session state (registered as active AFTER session is ready, see below)
  const sessionState = createSessionState(spaceId, conversationId, abortController);

  // Add user message to conversation (with images if provided)
  addMessage(spaceId, conversationId, {
    role: 'user',
    content: message,
    images: images, // Include images in the saved message
  });

  // Add placeholder for assistant response
  addMessage(spaceId, conversationId, {
    role: 'assistant',
    content: '',
    toolCalls: [],
  });

  try {
    // Get API credentials and resolve for SDK use (inside try/catch so errors reach frontend)
    const credentials = await getApiCredentials(config);
    console.log(`[Agent] sendMessage using: ${credentials.provider}, model: ${credentials.model}`);

    // Resolve credentials for SDK (handles OpenAI compat router for non-Anthropic providers)
    const resolvedCredentials = await resolveCredentialsForSdk(credentials);

    // Get conversation for session resumption
    const conversation = getConversation(spaceId, conversationId);
    const sessionId = resumeSessionId || conversation?.sessionId;
    // Use headless Electron binary (outside .app bundle on macOS to prevent Dock icon)
    const electronPath = getHeadlessElectronPath();
    console.log(`[Agent] Using headless Electron as Node runtime: ${electronPath}`);

    // Get enabled MCP servers
    const enabledMcpServers = getEnabledMcpServers(config.mcpServers || {});

    // Build MCP servers config (including AI Browser if enabled)
    const mcpServers: Record<string, any> = enabledMcpServers ? { ...enabledMcpServers } : {};
    if (aiBrowserEnabled) {
      // Initialize AI Browser module with mainWindow before creating MCP server
      // This ensures browserContext.mainWindow is set for IPC notifications
      if (mainWindow) {
        initializeAIBrowser(mainWindow);
        console.log(`[Agent][${conversationId}] AI Browser module initialized`);
      }
      mcpServers['ai-browser'] = createAIBrowserMcpServer();
      console.log(`[Agent][${conversationId}] AI Browser MCP server added`);
    }

    // Always add aico-bot-apps MCP for automation control
    mcpServers['aico-bot-apps'] = createAicoBotAppsMcpServer(spaceId);
    console.log(`[Agent][${conversationId}] AICO-Bot Apps MCP server added`);

    // Always add gh-search MCP for GitHub search capabilities
    mcpServers['gh-search'] = createGhSearchMcpServer();
    console.log(`[Agent][${conversationId}] GitHub Search MCP server added`);

    console.log(`[mcpServers]${Object.keys(mcpServers)}`);
    // Build base SDK options using shared configuration
    const sdkOptions = buildBaseSdkOptions({
      credentials: resolvedCredentials,
      workDir,
      electronPath,
      spaceId,
      conversationId,
      abortController,
      stderrHandler: (data: string) => {
        console.error(`[Agent][${conversationId}] CLI stderr:`, data);
        stderrBuffer += data; // Accumulate for error reporting
      },
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : null,
      maxTurns: config.agent?.maxTurns,
      contextWindow: resolvedCredentials.contextWindow,
    });

    // Apply dynamic configurations (AI Browser system prompt, Thinking mode)
    // These are specific to sendMessage and not part of base options
    if (aiBrowserEnabled) {
      sdkOptions.systemPrompt = {
        type: 'preset' as const,
        append: buildSystemPromptWithAIBrowser(
          { workDir, modelInfo: resolvedCredentials.displayModel },
          AI_BROWSER_SYSTEM_PROMPT,
        ),
      };
    }
    if (thinkingEnabled) {
      sdkOptions.maxThinkingTokens = 10240;
    }

    const t0 = Date.now();
    console.log(`[Agent][${conversationId}] Getting or creating V2 session...`);

    // Log MCP servers if configured (only enabled ones)
    const mcpServerNames = enabledMcpServers ? Object.keys(enabledMcpServers) : [];
    if (mcpServerNames.length > 0) {
      console.log(
        `[Agent][${conversationId}] MCP servers configured: ${mcpServerNames.join(', ')}`,
      );
    }

    // Session config for rebuild detection
    const sessionConfig: SessionConfig = {
      aiBrowserEnabled: !!aiBrowserEnabled,
    };

    // Get or create persistent V2 session for this conversation
    // Pass config for rebuild detection when aiBrowserEnabled changes
    // Pass workDir for session migration support (from old ~/.claude to new config dir)
    let v2Session = await getOrCreateV2Session(spaceId, conversationId, {
      sdkOptions,
      sessionId,
      config: sessionConfig,
      workDir,
    });

    // Register as active AFTER session is ready, so getOrCreateV2Session's
    // in-flight check doesn't mistake the current request as a concurrent one
    // (which would incorrectly defer session rebuild when aiBrowserEnabled changes)
    registerActiveSession(conversationId, sessionState);

    // Dynamic runtime parameter adjustment (via SDK patch)
    // Note: Model switching is handled by session rebuild (model change triggers
    // credentialsGeneration bump in config.service). setModel is kept for SDK
    // compatibility but is not effective for actual model routing when all providers
    // route through the OpenAI compat router (model is baked into ANTHROPIC_API_KEY).
    try {
      // Set model in SDK (informational; actual model determined by session credentials)
      if (v2Session.setModel) {
        await v2Session.setModel(resolvedCredentials.sdkModel);
        console.log(`[Agent][${conversationId}] Model set: ${resolvedCredentials.sdkModel}`);
      }

      // Set thinking tokens dynamically
      if (v2Session.setMaxThinkingTokens) {
        await v2Session.setMaxThinkingTokens(thinkingEnabled ? 10240 : null);
        console.log(
          `[Agent][${conversationId}] Thinking mode: ${thinkingEnabled ? 'ON (10240 tokens)' : 'OFF'}`,
        );
      }
    } catch (e) {
      console.error(`[Agent][${conversationId}] Failed to set dynamic params:`, e);
    }
    console.log(`[Agent][${conversationId}] ⏱️ V2 session ready: ${Date.now() - t0}ms`);

    // Prepare message content (canvas context prefix + multi-modal images)
    // CRITICAL: For local execution, do NOT upload images — pass base64 directly.
    // The Claude Code SDK natively supports base64 image sources and does not need
    // to fetch images over HTTP. Uploading to localhost URLs adds unnecessary failure
    // points (server accessibility, IPv4/IPv6 mismatch, firewall, proxy, etc.) that
    // can cause the SDK subprocess to crash before the API call is even made.
    // Image upload is only needed for remote execution where the remote server needs
    // accessible URLs.
    if (images && images.length > 0) {
      console.log(`[Agent][${conversationId}] Message includes ${images.length} image(s) (base64)`);
    }
    const canvasPrefix = formatCanvasContext(canvasContext);
    const messageWithContext = canvasPrefix + message;
    const messageContent = buildMessageContent(messageWithContext, images);

    // Mark session request start for health tracking
    markSessionRequestStart(conversationId);

    try {
      // Process the stream using shared stream processor
      // The stream processor handles all streaming logic, renderer events,
      // token usage tracking, and end-of-stream error detection.
      // Caller-specific storage is handled via the onComplete callback.

      // Store initial message content for the first iteration
      let currentMessageContent = messageContent;
      const isFirstIteration = true;
      const maxInjectionCycles = 20; // Safety limit to prevent infinite loops from worker reports
      let injectionCycles = 0;

      // Auth retry state — when SDK detects 401 and gives up, rebuild session with fresh credentials
      const MAX_AUTH_RETRIES = 1;
      let authRetries = 0;

      // Loop to handle turn-level message injection
      while (true) {
        const result = await processStream({
          v2Session,
          sessionState,
          spaceId,
          conversationId,
          messageContent: currentMessageContent,
          displayModel: resolvedCredentials.displayModel,
          abortController,
          t0,
          contextWindow: resolvedCredentials.contextWindow,
          callbacks: {
            onComplete: (streamResult) => {
              // Only mark request complete and unregister if NOT continuing
              if (!streamResult.hasPendingInjection) {
                // Mark session request complete for health tracking
                markSessionRequestComplete(conversationId);
              }

              // Save session ID for future resumption
              if (streamResult.capturedSessionId) {
                saveSessionId(spaceId, conversationId, streamResult.capturedSessionId);
                console.log(
                  `[Agent][${conversationId}] Session ID saved:`,
                  streamResult.capturedSessionId,
                );
              }

              // Persist content and/or error to conversation
              const { finalContent, thoughts, tokenUsage, hasErrorThought, errorThought } =
                streamResult;
              if (finalContent || hasErrorThought) {
                if (finalContent) {
                  console.log(
                    `[Agent][${conversationId}] Saving content: ${finalContent.length} chars`,
                  );
                }
                if (hasErrorThought) {
                  console.log(
                    `[Agent][${conversationId}] Persisting error to message: ${errorThought?.content}`,
                  );
                }

                // Extract file changes summary for immediate display (without loading thoughts)
                let metadata: { fileChanges?: FileChangesSummary } | undefined;
                if (thoughts.length > 0) {
                  try {
                    const fileChangesSummary = extractFileChangesSummaryFromThoughts(thoughts);
                    if (fileChangesSummary) {
                      metadata = { fileChanges: fileChangesSummary };
                      console.log(
                        `[Agent][${conversationId}] File changes: ${fileChangesSummary.totalFiles} files, +${fileChangesSummary.totalAdded} -${fileChangesSummary.totalRemoved}`,
                      );
                    }
                  } catch (error) {
                    console.error(
                      `[Agent][${conversationId}] Failed to extract file changes:`,
                      error,
                    );
                  }
                }

                updateLastMessage(spaceId, conversationId, {
                  content: finalContent,
                  thoughts: thoughts.length > 0 ? [...thoughts] : undefined,
                  tokenUsage: tokenUsage || undefined,
                  metadata,
                  error: errorThought?.content,
                });
              } else {
                console.log(`[Agent][${conversationId}] No content to save`);
              }

              // CRITICAL: Unregister active session after completion
              // This ensures that getPageState returns isActive: false after completion,
              // preventing frontend from incorrectly restoring isGenerating state on refresh
              // Only unregister if NOT continuing with injection
              if (!streamResult.hasPendingInjection) {
                unregisterActiveSession(conversationId);
              }
            },
          },
        });

        // Check if we need to continue with a pending injection
        if (result.hasPendingInjection) {
          const injection = getAndClearInjection(conversationId);
          if (injection) {
            injectionCycles++;
            if (injectionCycles >= maxInjectionCycles) {
              console.warn(
                `[Agent][${conversationId}] Max injection cycles (${maxInjectionCycles}) reached, stopping loop`,
              );
              break;
            }
            console.log(
              `[Agent][${conversationId}] Continuing with injected message (cycle ${injectionCycles}): ${injection.content.slice(0, 50)}...`,
            );

            // Build the injection message content
            const injectionContent = buildMessageContent(injection.content, injection.images);

            // Update current message content for next iteration
            currentMessageContent = injectionContent;

            // Reset session state for the new message (but keep thoughts)
            sessionState.streamingContent = '';
            sessionState.isThinking = true;

            // Notify frontend that we're continuing
            sendToRenderer('agent:injection-start', spaceId, conversationId, {
              content: injection.content,
            });

            // Continue the loop to process the injection
            continue;
          }
        }

        // No pending injection, check if auth retry is needed
        if (result.needsAuthRetry && authRetries < MAX_AUTH_RETRIES) {
          authRetries++;
          console.warn(
            `[Agent][${conversationId}] Auth retry #${authRetries}: rebuilding session with fresh credentials`,
          );

          // Notify user that auth recovery is in progress
          sendToRenderer('agent:auth-retry', spaceId, conversationId, {
            attempt: authRetries,
            maxRetries: MAX_AUTH_RETRIES,
          });

          // Unregister active session first (so rebuild is allowed)
          unregisterActiveSession(conversationId);

          // Re-resolve credentials (triggers token refresh for OAuth providers)
          const freshCredentials = await getApiCredentials(config);
          const freshResolved = await resolveCredentialsForSdk(freshCredentials);

          // Close old session (force rebuild — fresh credentials will create a new session)
          closeV2Session(conversationId);

          // Re-build SDK options with fresh credentials
          const freshSdkOptions = buildBaseSdkOptions({
            credentials: freshResolved,
            workDir,
            electronPath,
            spaceId,
            conversationId,
            abortController,
            stderrHandler: (data: string) => {
              console.error(`[Agent][${conversationId}] CLI stderr (auth retry):`, data);
              stderrBuffer += data;
            },
            mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : null,
            maxTurns: config.agent?.maxTurns,
            contextWindow: freshResolved.contextWindow,
          });

          // Apply dynamic configurations (AI Browser system prompt, Thinking mode)
          if (aiBrowserEnabled) {
            freshSdkOptions.systemPrompt = buildSystemPromptWithAIBrowser(
              { workDir, modelInfo: freshResolved.displayModel },
              AI_BROWSER_SYSTEM_PROMPT,
            );
          }
          if (thinkingEnabled) {
            freshSdkOptions.maxThinkingTokens = 10240;
          }

          // Create fresh session (don't resume — safer after auth failure)
          v2Session = await getOrCreateV2Session(spaceId, conversationId, {
            sdkOptions: freshSdkOptions,
            config: sessionConfig,
            workDir,
          });

          // Re-register as active
          registerActiveSession(conversationId, sessionState);

          // Reset stream state for retry
          sessionState.streamingContent = '';
          sessionState.thoughts = []; // Clear thoughts from failed attempt
          currentMessageContent = messageContent; // Retry original message

          // Continue the loop to retry with fresh session
          continue;
        }

        break;
      }
    } catch (streamError) {
      // Mark session request complete on error too
      markSessionRequestComplete(conversationId);
      throw streamError;
    }

    // System notification for task completion (if window not focused)
    notifyTaskComplete(conversation?.title || 'Conversation');
  } catch (error: unknown) {
    const err = error as Error;

    // Don't report abort as error, but persist already generated content
    if (err.name === 'AbortError') {
      console.log(`[Agent][${conversationId}] Aborted by user`);

      // CRITICAL: Persist already generated content and thoughts when user stops
      // This ensures content survives after stop and page refresh
      const sessionState = activeSessions.get(conversationId);
      if (sessionState) {
        const accumulatedContent = sessionState.streamingContent || '';
        const hasContent = accumulatedContent.length > 0;
        const hasThoughts = sessionState.thoughts.length > 0;

        if (hasContent || hasThoughts) {
          // Extract file changes summary from thoughts
          let metadata: { fileChanges?: FileChangesSummary } | undefined;
          if (hasThoughts) {
            try {
              const fileChangesSummary = extractFileChangesSummaryFromThoughts(
                sessionState.thoughts,
              );
              if (fileChangesSummary) {
                metadata = { fileChanges: fileChangesSummary };
              }
            } catch (e) {
              console.error(
                `[Agent][${conversationId}] Failed to extract file changes on abort:`,
                e,
              );
            }
          }

          // Update the assistant message with accumulated content and thoughts
          updateLastMessage(spaceId, conversationId, {
            content: accumulatedContent, // CRITICAL: Persist streaming content
            thoughts: hasThoughts ? [...sessionState.thoughts] : undefined,
            metadata,
          });
          console.log(
            `[Agent][${conversationId}] Persisted on abort: ${accumulatedContent.length} chars, ${sessionState.thoughts.length} thoughts`,
          );
        }
      }

      // CRITICAL: Unregister active session after abort
      // This ensures that getSessionState returns isActive: false after abort,
      // preventing frontend from incorrectly restoring isGenerating state on refresh
      unregisterActiveSession(conversationId);
      console.log(`[Agent][${conversationId}] Unregistered active session after abort`);

      return;
    }

    console.error(`[Agent][${conversationId}] Error:`, error);

    // Extract detailed error message from stderr if available
    let errorMessage = err.message || `Unknown error. ${FALLBACK_ERROR_HINT}`;

    // Windows: Check for Git Bash related errors
    if (process.platform === 'win32') {
      const isExitCode1 =
        errorMessage.includes('exited with code 1') ||
        errorMessage.includes('process exited') ||
        errorMessage.includes('spawn ENOENT');
      const isBashError =
        stderrBuffer?.includes('bash') ||
        stderrBuffer?.includes('ENOENT') ||
        errorMessage.includes('ENOENT');

      if (isExitCode1 || isBashError) {
        // Check if Git Bash is properly configured
        const { detectGitBash } = require('../git-bash.service');
        const gitBashStatus = detectGitBash();

        if (!gitBashStatus.found) {
          errorMessage =
            'Command execution environment not installed. Please restart the app and complete setup, or install manually in settings.';
        } else {
          // Git Bash found but still got error - could be path issue
          errorMessage =
            'Command execution failed. This may be an environment configuration issue, please try restarting the app.\n\n' +
            `Technical details: ${err.message}`;
        }
      }
    }

    if (stderrBuffer && !errorMessage.includes('Command execution')) {
      // Try to extract the most useful error info from stderr
      const mcpErrorMatch = stderrBuffer.match(
        /Error: Invalid MCP configuration:[\s\S]*?(?=\n\s*at |$)/m,
      );
      const genericErrorMatch = stderrBuffer.match(/Error: [\s\S]*?(?=\n\s*at |$)/m);
      if (mcpErrorMatch) {
        errorMessage = mcpErrorMatch[0].trim();
      } else if (genericErrorMatch) {
        errorMessage = genericErrorMatch[0].trim();
      }
    }

    sendToRenderer('agent:error', spaceId, conversationId, {
      type: 'error',
      error: errorMessage,
    });

    // Persist error to the assistant placeholder message so it survives conversation reload
    updateLastMessage(spaceId, conversationId, {
      content: '',
      error: errorMessage,
    });

    // Emit health event for monitoring
    onAgentError(conversationId, errorMessage);

    // CRITICAL: Unregister active session on error
    // This ensures that getSessionState returns isActive: false after error,
    // preventing frontend from incorrectly restoring isGenerating state on refresh
    unregisterActiveSession(conversationId);
    console.log(`[Agent][${conversationId}] Unregistered active session after error`);
  }
}

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
async function executeRemoteMessage(
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
