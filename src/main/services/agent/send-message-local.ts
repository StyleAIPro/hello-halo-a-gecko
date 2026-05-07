/**
 * Agent Module - Local Send Message
 *
 * Core local message sending logic including:
 * - API credential resolution and routing
 * - V2 Session management
 * - SDK message streaming and processing
 * - Token-level streaming support
 * - Error handling and recovery
 * - Hyper Space routing
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
import {
  type FileChangesSummary,
  extractFileChangesSummaryFromThoughts,
} from '../../../shared/file-changes';
import { notifyTaskComplete } from '../notification.service';
import {
  AI_BROWSER_SYSTEM_PROMPT,
  createAIBrowserMcpServer,
  initializeAIBrowser,
} from '../ai-browser';
import { GH_SEARCH_SYSTEM_PROMPT, createGhSearchMcpServer } from '../gh-search';
import { createAicoBotAppsMcpServer } from '../../apps/conversation-mcp';
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
import {
  getOrCreateV2Session,
  closeV2Session,
  createSessionState,
  registerActiveSession,
  unregisterActiveSession,
  markSessionRequestStart,
  markSessionRequestComplete,
  activeSessions,
} from './session-manager';
import { formatCanvasContext, buildMessageContent } from './message-utils';
import { resolveCredentialsForSdk, buildBaseSdkOptions } from './sdk-config';
import { processStream, getAndClearInjection } from './stream-processor';
import { agentOrchestrator } from './orchestrator';
import { executeRemoteMessage } from './send-message-remote';

// Unified fallback error suffix - guides user to check logs
const FALLBACK_ERROR_HINT = 'Check logs in Settings > System > Logs.';

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
      // Skip setModel for compat (fake Claude) models — SDK would print confusing
      // "set model to claude-sonnet-4-6" which doesn't reflect the real model.
      if (v2Session.setModel && !resolvedCredentials.isCompatModel) {
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
