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

import { BrowserWindow } from 'electron'
import { getConfig } from '../config.service'
import { getConversation, saveSessionId, addMessage, updateLastMessage } from '../conversation.service'
import { getSpace } from '../space.service'
import { getRemoteDeployService } from '../../ipc/remote-server'
import { RemoteWsClient, type RemoteWsClientConfig } from '../remote-ws/remote-ws-client'
import { type FileChangesSummary, extractFileChangesSummaryFromThoughts } from '../../../shared/file-changes'
import { notifyTaskComplete } from '../notification.service'
import { decryptString } from '../secure-storage.service'
import sshTunnelService from '../remote-ssh/ssh-tunnel.service'
import { SSHManager } from '../remote-ssh/ssh-manager'
import {
  AI_BROWSER_SYSTEM_PROMPT,
  createAIBrowserMcpServer
} from '../ai-browser'
import { createHaloAppsMcpServer } from '../../apps/conversation-mcp'
import type {
  AgentRequest,
  SessionConfig,
} from './types'
import {
  getHeadlessElectronPath,
  getWorkingDir,
  getApiCredentials,
  getEnabledMcpServers,
  sendToRenderer,
  setMainWindow
} from './helpers'
import { buildSystemPromptWithAIBrowser } from './system-prompt'
import {
  getOrCreateV2Session,
  closeV2Session,
  createSessionState,
  registerActiveSession,
  unregisterActiveSession,
  v2Sessions
} from './session-manager'
import {
  formatCanvasContext,
  buildMessageContent,
} from './message-utils'
import { onAgentError, runPpidScanAndCleanup } from '../health'
import { resolveCredentialsForSdk, buildBaseSdkOptions } from './sdk-config'
import { processStream } from './stream-processor'

// Unified fallback error suffix - guides user to check logs
const FALLBACK_ERROR_HINT = 'Check logs in Settings > System > Logs.'

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
  request: AgentRequest
): Promise<void> {
  setMainWindow(mainWindow)

  const {
    spaceId,
    conversationId,
    message,
    resumeSessionId,
    images,
    aiBrowserEnabled,
    thinkingEnabled,
    canvasContext
  } = request

  console.log('[Agent] ========== FUNCTION START ==========')
  console.log('[Agent] sendMessage: conv=', conversationId)
  console.log('[Agent] sendMessage: spaceId=', spaceId)

  // === Remote execution routing ===
  console.log('[Agent] ===== BEFORE GETSPACE =====')
  console.log('[Agent] getSpace function type:', typeof getSpace)
  console.log('[Agent] ===== AFTER GETSPACE =====')
  console.log(`[Agent] About to call getSpace with spaceId=${spaceId}`)
  const space = getSpace(spaceId)
  console.log(`[Agent] getSpace returned:`, space ? { id: space.id, name: space.name, claudeSource: space.claudeSource, remoteServerId: space.remoteServerId, useSshTunnel: space.useSshTunnel } : 'null')
  console.log(`[Agent] Remote routing check: space=${space ? space.name : 'null'}, claudeSource=${space?.claudeSource}, remoteServerId=${space?.remoteServerId}, useSshTunnel=${space?.useSshTunnel}`)
  if (space?.claudeSource === 'remote' && space.remoteServerId) {
    // Default to using SSH tunnel for security (most servers don't expose ports publicly)
    const useSshTunnel = space.useSshTunnel !== false  // Default true, only false if explicitly set
    console.log(`[Agent] *** ROUTING TO REMOTE EXECUTION *** server=${space.remoteServerId}, path=${space.remotePath || '/root'}, useSshTunnel=${useSshTunnel}`)
    try {
      console.log('[Agent] Calling executeRemoteMessage...')
      await executeRemoteMessage(
        mainWindow,
        request,
        space.remoteServerId,
        space.remotePath || '/root',
        useSshTunnel
      )
      console.log('[Agent] executeRemoteMessage completed')
    } catch (error) {
      console.error('[Agent] executeRemoteMessage error:', error)
      throw error
    }
    return
  }
  // === Remote routing end ===

  const config = getConfig()
  const workDir = getWorkingDir(spaceId)

  // Create abort controller for this session
  const abortController = new AbortController()

  // Accumulate stderr for detailed error messages
  let stderrBuffer = ''

  // Create session state (registered as active AFTER session is ready, see below)
  const sessionState = createSessionState(spaceId, conversationId, abortController)

  // Add user message to conversation (with images if provided)
  addMessage(spaceId, conversationId, {
    role: 'user',
    content: message,
    images: images  // Include images in the saved message
  })

  // Add placeholder for assistant response
  addMessage(spaceId, conversationId, {
    role: 'assistant',
    content: '',
    toolCalls: []
  })

  try {
    // Get API credentials and resolve for SDK use (inside try/catch so errors reach frontend)
    const credentials = await getApiCredentials(config)
    console.log(`[Agent] sendMessage using: ${credentials.provider}, model: ${credentials.model}`)

    // Resolve credentials for SDK (handles OpenAI compat router for non-Anthropic providers)
    const resolvedCredentials = await resolveCredentialsForSdk(credentials)

    // Get conversation for session resumption
    const conversation = getConversation(spaceId, conversationId)
    const sessionId = resumeSessionId || conversation?.sessionId
    // Use headless Electron binary (outside .app bundle on macOS to prevent Dock icon)
    const electronPath = getHeadlessElectronPath()
    console.log(`[Agent] Using headless Electron as Node runtime: ${electronPath}`)

    // Get enabled MCP servers
    const enabledMcpServers = getEnabledMcpServers(config.mcpServers || {})

    // Build MCP servers config (including AI Browser if enabled)
    const mcpServers: Record<string, any> = enabledMcpServers ? { ...enabledMcpServers } : {}
    if (aiBrowserEnabled) {
      mcpServers['ai-browser'] = createAIBrowserMcpServer()
      console.log(`[Agent][${conversationId}] AI Browser MCP server added`)
    }

    // Always add halo-apps MCP for automation control
    mcpServers['halo-apps'] = createHaloAppsMcpServer(spaceId)
    console.log(`[Agent][${conversationId}] Halo Apps MCP server added`)
    console.log(`[mcpServers]${Object.keys(mcpServers)}`)
    // Build base SDK options using shared configuration
    const sdkOptions = buildBaseSdkOptions({
      credentials: resolvedCredentials,
      workDir,
      electronPath,
      spaceId,
      conversationId,
      abortController,
      stderrHandler: (data: string) => {
        console.error(`[Agent][${conversationId}] CLI stderr:`, data)
        stderrBuffer += data  // Accumulate for error reporting
      },
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : null,
      maxTurns: config.agent?.maxTurns
    })

    // Apply dynamic configurations (AI Browser system prompt, Thinking mode)
    // These are specific to sendMessage and not part of base options
    if (aiBrowserEnabled) {
      sdkOptions.systemPrompt = buildSystemPromptWithAIBrowser(
        { workDir, modelInfo: resolvedCredentials.displayModel },
        AI_BROWSER_SYSTEM_PROMPT
      )
    }
    if (thinkingEnabled) {
      sdkOptions.maxThinkingTokens = 10240
    }

    const t0 = Date.now()
    console.log(`[Agent][${conversationId}] Getting or creating V2 session...`)

    // Log MCP servers if configured (only enabled ones)
    const mcpServerNames = enabledMcpServers ? Object.keys(enabledMcpServers) : []
    if (mcpServerNames.length > 0) {
      console.log(`[Agent][${conversationId}] MCP servers configured: ${mcpServerNames.join(', ')}`)
    }

    // Session config for rebuild detection
    const sessionConfig: SessionConfig = {
      aiBrowserEnabled: !!aiBrowserEnabled
    }

    // Get or create persistent V2 session for this conversation
    // Pass config for rebuild detection when aiBrowserEnabled changes
    // Pass workDir for session migration support (from old ~/.claude to new config dir)
    const v2Session = await getOrCreateV2Session(spaceId, conversationId, sdkOptions, sessionId, sessionConfig, workDir)

    // Register as active AFTER session is ready, so getOrCreateV2Session's
    // in-flight check doesn't mistake the current request as a concurrent one
    // (which would incorrectly defer session rebuild when aiBrowserEnabled changes)
    registerActiveSession(conversationId, sessionState)

    // Dynamic runtime parameter adjustment (via SDK patch)
    // Note: Model switching is handled by session rebuild (model change triggers
    // credentialsGeneration bump in config.service). setModel is kept for SDK
    // compatibility but is not effective for actual model routing when all providers
    // route through the OpenAI compat router (model is baked into ANTHROPIC_API_KEY).
    try {
      // Set model in SDK (informational; actual model determined by session credentials)
      if (v2Session.setModel) {
        await v2Session.setModel(resolvedCredentials.sdkModel)
        console.log(`[Agent][${conversationId}] Model set: ${resolvedCredentials.sdkModel}`)
      }

      // Set thinking tokens dynamically
      if (v2Session.setMaxThinkingTokens) {
        await v2Session.setMaxThinkingTokens(thinkingEnabled ? 10240 : null)
        console.log(`[Agent][${conversationId}] Thinking mode: ${thinkingEnabled ? 'ON (10240 tokens)' : 'OFF'}`)
      }
    } catch (e) {
      console.error(`[Agent][${conversationId}] Failed to set dynamic params:`, e)
    }
    console.log(`[Agent][${conversationId}] ⏱️ V2 session ready: ${Date.now() - t0}ms`)

    // Prepare message content (canvas context prefix + multi-modal images)
    if (images && images.length > 0) {
      console.log(`[Agent][${conversationId}] Message includes ${images.length} image(s)`)
    }
    const canvasPrefix = formatCanvasContext(canvasContext)
    const messageWithContext = canvasPrefix + message
    const messageContent = buildMessageContent(messageWithContext, images)

    // Process the stream using shared stream processor
    // The stream processor handles all streaming logic, renderer events,
    // token usage tracking, and end-of-stream error detection.
    // Caller-specific storage is handled via the onComplete callback.
    await processStream({
      v2Session,
      sessionState,
      spaceId,
      conversationId,
      messageContent,
      displayModel: resolvedCredentials.displayModel,
      abortController,
      t0,
      callbacks: {
        onComplete: (streamResult) => {
          // Save session ID for future resumption
          if (streamResult.capturedSessionId) {
            saveSessionId(spaceId, conversationId, streamResult.capturedSessionId)
            console.log(`[Agent][${conversationId}] Session ID saved:`, streamResult.capturedSessionId)
          }

          // Persist content and/or error to conversation
          const { finalContent, thoughts, tokenUsage, hasErrorThought, errorThought } = streamResult
          if (finalContent || hasErrorThought) {
            if (finalContent) {
              console.log(`[Agent][${conversationId}] Saving content: ${finalContent.length} chars`)
            }
            if (hasErrorThought) {
              console.log(`[Agent][${conversationId}] Persisting error to message: ${errorThought?.content}`)
            }

            // Extract file changes summary for immediate display (without loading thoughts)
            let metadata: { fileChanges?: FileChangesSummary } | undefined
            if (thoughts.length > 0) {
              try {
                const fileChangesSummary = extractFileChangesSummaryFromThoughts(thoughts)
                if (fileChangesSummary) {
                  metadata = { fileChanges: fileChangesSummary }
                  console.log(`[Agent][${conversationId}] File changes: ${fileChangesSummary.totalFiles} files, +${fileChangesSummary.totalAdded} -${fileChangesSummary.totalRemoved}`)
                }
              } catch (error) {
                console.error(`[Agent][${conversationId}] Failed to extract file changes:`, error)
              }
            }

            updateLastMessage(spaceId, conversationId, {
              content: finalContent,
              thoughts: thoughts.length > 0 ? [...thoughts] : undefined,
              tokenUsage: tokenUsage || undefined,
              metadata,
              error: errorThought?.content
            })
          } else {
            console.log(`[Agent][${conversationId}] No content to save`)
          }
        }
      }
    })

    // System notification for task completion (if window not focused)
    notifyTaskComplete(conversation?.title || 'Conversation')

  } catch (error: unknown) {
    const err = error as Error

    // Don't report abort as error
    if (err.name === 'AbortError') {
      console.log(`[Agent][${conversationId}] Aborted by user`)
      return
    }

    console.error(`[Agent][${conversationId}] Error:`, error)

    // Extract detailed error message from stderr if available
    let errorMessage = err.message || `Unknown error. ${FALLBACK_ERROR_HINT}`

    // Windows: Check for Git Bash related errors
    if (process.platform === 'win32') {
      const isExitCode1 = errorMessage.includes('exited with code 1') ||
                          errorMessage.includes('process exited') ||
                          errorMessage.includes('spawn ENOENT')
      const isBashError = stderrBuffer?.includes('bash') ||
                          stderrBuffer?.includes('ENOENT') ||
                          errorMessage.includes('ENOENT')

      if (isExitCode1 || isBashError) {
        // Check if Git Bash is properly configured
        const { detectGitBash } = require('../git-bash.service')
        const gitBashStatus = detectGitBash()

        if (!gitBashStatus.found) {
          errorMessage = 'Command execution environment not installed. Please restart the app and complete setup, or install manually in settings.'
        } else {
          // Git Bash found but still got error - could be path issue
          errorMessage = 'Command execution failed. This may be an environment configuration issue, please try restarting the app.\n\n' +
                        `Technical details: ${err.message}`
        }
      }
    }

    if (stderrBuffer && !errorMessage.includes('Command execution')) {
      // Try to extract the most useful error info from stderr
      const mcpErrorMatch = stderrBuffer.match(/Error: Invalid MCP configuration:[\s\S]*?(?=\n\s*at |$)/m)
      const genericErrorMatch = stderrBuffer.match(/Error: [\s\S]*?(?=\n\s*at |$)/m)
      if (mcpErrorMatch) {
        errorMessage = mcpErrorMatch[0].trim()
      } else if (genericErrorMatch) {
        errorMessage = genericErrorMatch[0].trim()
      }
    }

    sendToRenderer('agent:error', spaceId, conversationId, {
      type: 'error',
      error: errorMessage
    })

    // Persist error to the assistant placeholder message so it survives conversation reload
    updateLastMessage(spaceId, conversationId, {
      content: '',
      error: errorMessage
    })

    // Emit health event for monitoring
    onAgentError(conversationId, errorMessage)
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
  useSshTunnel?: boolean  // Use SSH port forwarding (localhost:8080) instead of direct connection
): Promise<void> {
  console.log('[Agent][Remote] ===== FUNCTION START =====')
  console.log('[Agent][Remote] serverId=', serverId, 'remotePath=', remotePath, 'useSshTunnel=', useSshTunnel)
  const deployService = getRemoteDeployService()
  const server = deployService.getServer(serverId)

  if (!server) {
    throw new Error(`Remote server not found: ${serverId}`)
  }

  if (server.status !== 'connected') {
    throw new Error(`Remote server is not connected: ${server.name}`)
  }

  const DEPLOY_AGENT_PATH = '/opt/claude-deployment'

  const {
    spaceId,
    conversationId,
    message,
    images,
    thinkingEnabled,
    resumeSessionId
  } = request

  console.log(`[Agent][Remote] Executing on server: ${serverId}, path: ${remotePath}, useSshTunnel=${useSshTunnel}, message: ${message.substring(0, 50)}...`)

  // Get API key and model config
  const config = getConfig()
  const apiKey = config.api?.apiKey || config.aiSources?.sources?.find(s => s.id === config.aiSources?.currentId)?.apiKey
  const currentSource = config.aiSources?.sources?.find(s => s.id === config.aiSources?.currentId)
  const model = currentSource?.model || config.api?.model || 'claude-sonnet-4-20250514'
  console.log(`[Agent][Remote] Using model: ${model}`)

  // Get conversation for message history and session ID
  const conversation = getConversation(spaceId, conversationId)
  const sessionId = resumeSessionId || conversation?.sessionId

  // Add user message to conversation (with images if provided)
  addMessage(spaceId, conversationId, {
    role: 'user',
    content: message,
    images: images || []
  })

  // Add assistant placeholder for streaming response
  addMessage(spaceId, conversationId, {
    role: 'assistant',
    content: '',
    toolCalls: []
  })

  try {
    // Sync auth token from remote server before connecting
    // This ensures we always use the correct token
    try {
      console.log(`[Agent][Remote] Syncing auth token from remote server...`)
      const decryptedPassword = decryptString(server.password || '')

      // Create temporary SSH manager to read auth token
      const tempManager = new SSHManager()
      await tempManager.connect({
        host: server.host,
        port: server.sshPort || 22,
        username: server.username,
        password: decryptedPassword
      })

      const envContent = await tempManager.executeCommand(`cat ${DEPLOY_AGENT_PATH}/.env 2>/dev/null || echo ""`)
      // Match AUTH_TOKEN at the start of a line (not ANTHROPIC_AUTH_TOKEN)
      const authTokenMatch = envContent.match(/^AUTH_TOKEN=(.+)/m)
      if (authTokenMatch && authTokenMatch[1]) {
        const remoteAuthToken = authTokenMatch[1].trim()
        if (remoteAuthToken !== server.authToken) {
          console.log(`[Agent][Remote] Updating local auth token to match remote`)
          server.authToken = remoteAuthToken
          // Update server in deploy service
          await deployService.updateServer(serverId, { authToken: remoteAuthToken })
        } else {
          console.log(`[Agent][Remote] Auth token already matches`)
        }
      }

      // Close temporary SSH connection - SSHManager doesn't have close(), use end()
      try {
        ;(tempManager as any).end?.()
      } catch {}
    } catch (syncError) {
      console.warn(`[Agent][Remote] Failed to sync auth token:`, syncError)
      // Continue anyway, using existing token
    }

    // Track the local port for WebSocket connection
    let localTunnelPort = server.wsPort || 8080

    // Establish SSH tunnel if required (default: true for security)
    if (useSshTunnel) {
      console.log(`[Agent][Remote] Establishing SSH tunnel to ${server.host}:${server.wsPort || 8080}...`)

      // Decrypt password from server config
      const decryptedPassword = decryptString(server.password || '')

      try {
        // establishTunnel returns the actual local port used (may differ from requested)
        localTunnelPort = await sshTunnelService.establishTunnel({
          spaceId,
          serverId,
          host: server.host,
          port: server.sshPort || 22,
          username: server.username,
          password: decryptedPassword,
          localPort: server.wsPort || 8080,  // Starting port (may be changed if in use)
          remotePort: server.wsPort || 8080
        })
        console.log(`[Agent][Remote] SSH tunnel established on local port ${localTunnelPort}`)
      } catch (tunnelError) {
        console.error('[Agent][Remote] Failed to establish SSH tunnel:', tunnelError)
        throw new Error(`SSH tunnel failed: ${tunnelError instanceof Error ? tunnelError.message : String(tunnelError)}`)
      }
    }

    // Check if remote agent is running before connecting
    console.log(`[Agent][Remote] Checking if remote agent is running...`)
    const isAgentRunning = await checkRemoteAgentRunning(serverId)
    console.log(`[Agent][Remote] Agent running status:`, isAgentRunning)

    if (!isAgentRunning) {
      console.log(`[Agent][Remote] Agent not running, deploying and starting...`)

      // Deploy agent if not installed
      const isDeployed = await checkRemoteAgentDeployed(serverId)
      console.log(`[Agent][Remote] Agent deployed status:`, isDeployed)

      if (!isDeployed) {
        console.log(`[Agent][Remote] Agent not deployed, deploying...`)
        await deployRemoteAgent(serverId)
        console.log(`[Agent][Remote] Deployment completed`)
      }

      // Start the agent
      console.log(`[Agent][Remote] Starting agent...`)
      await startRemoteAgent(serverId)

      // Wait for agent to start
      console.log(`[Agent][Remote] Waiting for agent to start...`)
      await new Promise(resolve => setTimeout(resolve, 3000))

      // Verify agent is running
      const verifyRunning = await checkRemoteAgentRunning(serverId)
      console.log(`[Agent][Remote] Agent start verification:`, verifyRunning)

      if (!verifyRunning) {
        const error = 'Failed to start remote agent - process not running after start command'
        console.error('[Agent][Remote]', error)
        throw new Error(error)
      }

      console.log(`[Agent][Remote] Agent started and verified`)
    } else {
      console.log(`[Agent][Remote] Agent is already running`)
    }

    // Create remote client (WebSocket connection)
    // Use localTunnelPort for SSH tunnel, original port for direct connection
    const wsConfig: RemoteWsClientConfig = {
      serverId,
      host: useSshTunnel ? 'localhost' : server.host,
      port: useSshTunnel ? localTunnelPort : (server.wsPort || 8080),
      authToken: server.authToken || '',
      useSshTunnel  // Pass SSH tunnel flag
    }
    console.log(`[Agent][Remote] Creating WebSocket client with config:`, { useSshTunnel: wsConfig.useSshTunnel, host: wsConfig.host, port: wsConfig.port })
    const client = new RemoteWsClient(wsConfig)

    // Register event handlers for streaming response
    const toolCalls: any[] = []
    const terminalOutputs: any[] = []
    let streamingContent = ''
    const thoughts: any[] = []

    // Tool call events - format matches frontend ToolCall interface
    client.on('tool:call', (data) => {
      if (data.sessionId === conversationId) {
        const toolData = data.data
        console.log(`[Agent][Remote] Tool call received:`, toolData.name)
        toolCalls.push(toolData)
        // Send in format expected by handleAgentToolCall
        sendToRenderer('agent:tool-call', spaceId, conversationId, {
          id: toolData.id,
          name: toolData.name,
          status: toolData.status || 'running',
          input: toolData.input || {},
          requiresApproval: false
        })
      }
    })

    client.on('tool:delta', (data) => {
      if (data.sessionId === conversationId) {
        // Handle tool delta for streaming tool input
        console.log(`[Agent][Remote] Tool delta received`)
        // Tool deltas are handled via thought events
      }
    })

    client.on('tool:result', (data) => {
      if (data.sessionId === conversationId) {
        const toolData = data.data
        console.log(`[Agent][Remote] Tool result received`)
        sendToRenderer('agent:tool-result', spaceId, conversationId, {
          toolId: toolData.id,
          result: toolData.output || '',
          isError: false
        })
      }
    })

    client.on('tool:error', (data) => {
      if (data.sessionId === conversationId) {
        const toolData = data.data
        console.error(`[Agent][Remote] Tool error:`, toolData)
        sendToRenderer('agent:tool-result', spaceId, conversationId, {
          toolId: toolData.id,
          result: toolData.error || 'Tool execution failed',
          isError: true
        })
      }
    })

    // Terminal output events
    client.on('terminal:output', (data) => {
      if (data.sessionId === conversationId) {
        const output = data.data
        terminalOutputs.push(output)
        sendToRenderer('agent:terminal', spaceId, conversationId, output)
      }
    })

    // Streaming text events - use agent:message format expected by frontend
    client.on('claude:stream', (data) => {
      if (data.sessionId === conversationId) {
        const text = data.data?.text || data.data?.content || ''
        streamingContent += text
        // Send in the format expected by handleAgentMessage
        sendToRenderer('agent:message', spaceId, conversationId, {
          delta: text,
          isStreaming: true,
          isComplete: false
        })
      }
    })

    // Thought events - for thinking process display (aligned with local agent:thought)
    client.on('thought', (data) => {
      if (data.sessionId === conversationId) {
        const thoughtData = data.data
        console.log(`[Agent][Remote] Thought received: type=${thoughtData.type}, id=${thoughtData.id}`)

        // Store thought for final message
        thoughts.push(thoughtData)

        // Send to renderer in the same format as local agent:thought
        sendToRenderer('agent:thought', spaceId, conversationId, { thought: thoughtData })
      }
    })

    // Thought delta events - for streaming updates (aligned with local agent:thought-delta)
    client.on('thought:delta', (data) => {
      if (data.sessionId === conversationId) {
        const deltaData = data.data
        // Send to renderer in the same format as local agent:thought-delta
        sendToRenderer('agent:thought-delta', spaceId, conversationId, deltaData)

        // Update stored thought content if applicable
        if (deltaData.content) {
          const thought = thoughts.find(t => t.id === deltaData.thoughtId)
          if (thought) {
            thought.content = deltaData.content
          }
        }
      }
    })

    // Connect if not already connected
    if (!client.isConnected()) {
      const connectionUrl = `ws://${wsConfig.host}:${wsConfig.port}/agent`
      console.log(`[Agent][Remote] Connecting to WebSocket at ${connectionUrl} (useSshTunnel=${wsConfig.useSshTunnel})...`)
      try {
        await client.connect()
        console.log(`[Agent][Remote] Client connected, ready to send`)
      } catch (connectError) {
        console.error(`[Agent][Remote] Failed to connect WebSocket:`, connectError)
        throw connectError
      }
    } else {
      console.log(`[Agent][Remote] Client already connected`)
    }

    // Build complete message history for multi-turn conversation
    console.log(`[Agent][Remote] Building message history for conversation ${conversationId}...`)

    const messageHistory: Array<{ role: string; content: any }> = []

    if (conversation && conversation.messages) {
      // Filter out the last assistant placeholder message we just added
      const messagesToSend = conversation.messages.slice(0, -1)

      for (const msg of messagesToSend) {
        // Build content array (supports text + images)
        const content: any[] = []

        // Add text content
        if (msg.content) {
          content.push({ type: 'text', text: msg.content })
        }

        // Add images if present
        if (msg.images && msg.images.length > 0) {
          for (const image of msg.images) {
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: image.mediaType,
                data: image.data
              }
            })
          }
        }

        messageHistory.push({
          role: msg.role,
          content: content.length === 1 && content[0].type === 'text' ? content[0].text : content
        })
      }
    }

    // Add current user message
    const currentUserContent: any[] = []
    currentUserContent.push({ type: 'text', text: message })

    if (images && images.length > 0) {
      for (const image of images) {
        currentUserContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mediaType,
            data: image.data
          }
        })
      }
    }

    messageHistory.push({
      role: 'user',
      content: currentUserContent.length === 1 ? currentUserContent[0].text : currentUserContent
    })

    console.log(`[Agent][Remote] Message history: ${messageHistory.length} messages`)

    // Send chat request via WebSocket with streaming
    console.log(`[Agent][Remote] Sending chat request to remote Claude (sessionId=${sessionId || 'new'}, workDir=${remotePath})...`)

    const response = await client.sendChatWithStream(
      sessionId || conversationId,  // Use existing sessionId or conversationId as new session
      messageHistory,
      {
        apiKey,
        baseUrl: currentSource?.apiUrl || undefined,
        model,
        maxTokens: config.agent?.maxTokens || 8192,
        system: undefined,  // Can add custom system prompt here
        maxThinkingTokens: thinkingEnabled ? 10240 : undefined,
        workDir: remotePath  // CRITICAL: Pass workDir from Space config
      }
    )

    console.log(`[Agent][Remote] Received response from remote Claude: ${response.substring(0, 100)}...`)

    // Send final message content (the streaming already sent deltas)
    sendToRenderer('agent:message', spaceId, conversationId, {
      content: streamingContent || response,
      isComplete: true,
      isStreaming: false
    })

    // Send completion event
    sendToRenderer('agent:complete', spaceId, conversationId, {})

    // Update the assistant message with the response
    updateLastMessage(spaceId, conversationId, {
      content: streamingContent || response,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      terminalOutputs: terminalOutputs.length > 0 ? terminalOutputs : undefined,
      thoughts: thoughts.length > 0 ? thoughts : undefined
    })

    // Save session ID for future resumption
    if (sessionId) {
      saveSessionId(spaceId, conversationId, sessionId)
      console.log(`[Agent][Remote] Session ID saved: ${sessionId}`)
    }

    console.log(`[Agent][Remote] Remote Claude execution completed`)

  } catch (error) {
    console.error('[Agent][Remote] Execute error:', error)
    const err = error as Error

    sendToRenderer('agent:error', spaceId, conversationId, {
      type: 'error',
      error: err.message || 'Remote execution failed'
    })

    // Update assistant message with error
    updateLastMessage(spaceId, conversationId, {
      content: '',
      error: err.message
    })

    throw err
  }
}

/**
 * Check if remote agent is deployed on the server
 */
async function checkRemoteAgentDeployed(serverId: string): Promise<boolean> {
  const deployService = getRemoteDeployService()
  const server = deployService.getServer(serverId)

  if (!server) {
    return false
  }

  const manager = deployService.getSSHManagerForServer(serverId)
  if (!manager) {
    return false
  }

  try {
    // Check if deployment directory exists
    const result = await manager.executeCommandFull(`test -d /opt/claude-deployment && test -f /opt/claude-deployment/package.json`)

    return result.exitCode === 0 && result.stdout.trim() !== ''
  } catch {
    return false
  }
}

/**
 * Deploy remote agent to the server
 */
async function deployRemoteAgent(serverId: string): Promise<void> {
  const deployService = getRemoteDeployService()
  const server = deployService.getServer(serverId)

  if (!server) {
    throw new Error(`Remote server not found: ${serverId}`)
  }

  const manager = deployService.getSSHManagerForServer(serverId)
  if (!manager) {
    throw new Error(`SSH manager not available for server: ${serverId}`)
  }

  console.log('[Agent][Remote] Deploying remote agent to:', server.name)

  // Execute the deploy command (this calls the existing deployAgentCode function)
  await deployService.deployAgentCode(serverId)

  console.log('[Agent][Remote] Remote agent deployment completed')
}

/**
 * Check if remote agent is running
 */
async function checkRemoteAgentRunning(serverId: string): Promise<boolean> {
  const deployService = getRemoteDeployService()
  const server = deployService.getServer(serverId)

  if (!server) {
    return false
  }

  const manager = deployService.getSSHManagerForServer(serverId)
  if (!manager) {
    return false
  }

  try {
    // Check if the process is running by checking the port
    const result = await manager.executeCommandFull(`lsof -i :${server.wsPort || 8080} || echo "NOT_RUNNING"`)

    return !result.stdout.includes('NOT_RUNNING')
  } catch {
    return false
  }
}

/**
 * Start remote agent on the server
 */
async function startRemoteAgent(serverId: string): Promise<void> {
  const deployService = getRemoteDeployService()
  const server = deployService.getServer(serverId)

  if (!server) {
    throw new Error(`Remote server not found: ${serverId}`)
  }

  const manager = deployService.getSSHManagerForServer(serverId)
  if (!manager) {
    throw new Error(`SSH manager not available for server: ${serverId}`)
  }

  console.log('[Agent][Remote] Starting remote agent on:', server.name)

  // Start the agent server
  await deployService.startAgent(serverId)

  console.log('[Agent][Remote] Remote agent started')
}
