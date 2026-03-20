/**
 * Agent Orchestrator Service for Hyper Space
 *
 * Inspired by OpenClaw's subagent system, this service handles:
 * - Multi-agent team management
 * - Task distribution and routing
 * - Result aggregation
 * - Completion announcements
 *
 * @module orchestrator
 */

import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type {
  AgentConfig,
  OrchestrationConfig,
  SubagentTask,
  SubagentTaskStatus,
  SubagentAnnouncement,
  AgentRole,
  ExecutionMode,
  RoutingStrategy,
  AggregationStrategy
} from '../../../shared/types/hyper-space'
import { DEFAULT_ORCHESTRATION_CONFIG, createOrchestrationConfig } from '../../../shared/types/hyper-space'

// ============================================
// Types
// ============================================

/**
 * Runtime state of an agent instance
 */
export interface AgentInstance {
  id: string
  config: AgentConfig
  status: 'idle' | 'running' | 'completed' | 'error'
  currentTaskId?: string
  lastHeartbeat?: number
}

/**
 * Agent team for a Hyper Space
 */
export interface AgentTeam {
  id: string
  spaceId: string
  conversationId: string
  leader: AgentInstance
  workers: AgentInstance[]
  config: OrchestrationConfig
  status: 'idle' | 'active' | 'waiting' | 'completed' | 'error'
  createdAt: number
}

/**
 * Event types emitted by the orchestrator
 */
export type OrchestratorEvent =
  | 'team:created'
  | 'team:destroyed'
  | 'task:started'
  | 'task:completed'
  | 'task:failed'
  | 'announce'

// ============================================
// Orchestrator Service
// ============================================

/**
 * Agent Orchestrator - manages multi-agent teams and task distribution
 *
 * Usage:
 * ```typescript
 * const orchestrator = AgentOrchestrator.getInstance()
 *
 * // Create a team for a Hyper Space
 * const team = orchestrator.createTeam({
 *   spaceId: 'space-123',
 *   conversationId: 'conv-456',
 *   agents: [leaderConfig, worker1Config, worker2Config],
 *   config: orchestrationConfig
 * })
 *
 * // Dispatch a task
 * const tasks = await orchestrator.dispatchTask({
 *   teamId: team.id,
 *   task: 'Analyze the codebase structure',
 *   conversationId: 'conv-456'
 * })
 *
 * // Wait for completion
 * orchestrator.on('announce', (announcement) => {
 *   console.log(`Task ${announcement.taskId} completed by ${announcement.agentId}`)
 * })
 * ```
 */
class AgentOrchestrator extends EventEmitter {
  private static instance: AgentOrchestrator | null = null

  /** Active teams indexed by team ID */
  private teams: Map<string, AgentTeam> = new Map()

  /** Teams indexed by space ID for quick lookup */
  private teamsBySpace: Map<string, string> = new Map()

  /** Active tasks indexed by task ID */
  private tasks: Map<string, SubagentTask> = new Map()

  /** Pending announcements waiting to be processed */
  private pendingAnnouncements: Map<string, Set<string>> = new Map()

  /** Maximum depth for nested subagents */
  private readonly maxSpawnDepth = 5

  /** Maximum concurrent children per agent */
  private readonly maxChildrenPerAgent = 5

  private constructor() {
    super()
    console.log('[Orchestrator] Service initialized')
  }

  /**
   * Get singleton instance
   */
  static getInstance(): AgentOrchestrator {
    if (!AgentOrchestrator.instance) {
      AgentOrchestrator.instance = new AgentOrchestrator()
    }
    return AgentOrchestrator.instance
  }

  // ============================================
  // Team Management
  // ============================================

  /**
   * Create a new agent team for a Hyper Space
   */
  createTeam(params: {
    spaceId: string
    conversationId: string
    agents: AgentConfig[]
    config?: Partial<OrchestrationConfig>
  }): AgentTeam {
    const teamId = uuidv4()

    // Validate at least one leader
    const leaders = params.agents.filter(a => a.role === 'leader')
    if (leaders.length === 0) {
      throw new Error('[Orchestrator] Hyper Space requires at least one leader agent')
    }

    // Use first leader as primary
    const leader = this.createAgentInstance(leaders[0])
    const workers = params.agents
      .filter(a => a.role === 'worker')
      .map(a => this.createAgentInstance(a))

    const config = createOrchestrationConfig(params.config)

    const team: AgentTeam = {
      id: teamId,
      spaceId: params.spaceId,
      conversationId: params.conversationId,
      leader,
      workers,
      config,
      status: 'idle',
      createdAt: Date.now()
    }

    this.teams.set(teamId, team)
    this.teamsBySpace.set(params.spaceId, teamId)

    this.emit('team:created', { teamId, spaceId: params.spaceId })

    console.log(
      `[Orchestrator] Created team ${teamId} for space ${params.spaceId} ` +
      `with 1 leader and ${workers.length} workers`
    )

    return team
  }

  /**
   * Create an agent instance from configuration
   */
  private createAgentInstance(config: AgentConfig): AgentInstance {
    return {
      id: config.id,
      config,
      status: 'idle'
    }
  }

  /**
   * Get team by ID
   */
  getTeam(teamId: string): AgentTeam | undefined {
    return this.teams.get(teamId)
  }

  /**
   * Get team by space ID
   */
  getTeamBySpace(spaceId: string): AgentTeam | undefined {
    const teamId = this.teamsBySpace.get(spaceId)
    if (!teamId) return undefined
    return this.teams.get(teamId)
  }

  /**
   * Destroy a team and clean up resources
   */
  destroyTeam(teamId: string): boolean {
    const team = this.teams.get(teamId)
    if (!team) return false

    // Clean up pending announcements
    this.pendingAnnouncements.delete(team.conversationId)

    // Remove from maps
    this.teams.delete(teamId)
    this.teamsBySpace.delete(team.spaceId)

    this.emit('team:destroyed', { teamId, spaceId: team.spaceId })

    console.log(`[Orchestrator] Destroyed team ${teamId}`)
    return true
  }

  /**
   * Add a new agent to an existing team
   */
  addAgentToTeam(teamId: string, agentConfig: AgentConfig): boolean {
    const team = this.teams.get(teamId)
    if (!team) return false

    const instance = this.createAgentInstance(agentConfig)

    if (agentConfig.role === 'leader') {
      // Replace existing leader (only one leader supported for now)
      team.leader = instance
    } else {
      team.workers.push(instance)
    }

    console.log(`[Orchestrator] Added agent ${agentConfig.id} to team ${teamId}`)
    return true
  }

  /**
   * Remove an agent from a team
   */
  removeAgentFromTeam(teamId: string, agentId: string): boolean {
    const team = this.teams.get(teamId)
    if (!team) return false

    // Cannot remove leader
    if (team.leader.id === agentId) {
      console.warn(`[Orchestrator] Cannot remove leader ${agentId} from team ${teamId}`)
      return false
    }

    const index = team.workers.findIndex(w => w.id === agentId)
    if (index === -1) return false

    team.workers.splice(index, 1)
    console.log(`[Orchestrator] Removed agent ${agentId} from team ${teamId}`)
    return true
  }

  // ============================================
  // Task Dispatching
  // ============================================

  /**
   * Dispatch a task to appropriate agents based on routing strategy
   */
  async dispatchTask(params: {
    teamId: string
    task: string
    conversationId: string
  }): Promise<SubagentTask[]> {
    const team = this.teams.get(params.teamId)
    if (!team) {
      throw new Error(`[Orchestrator] Team not found: ${params.teamId}`)
    }

    team.status = 'active'

    const strategy = team.config.routing.strategy

    let tasks: SubagentTask[] = []

    switch (strategy) {
      case 'capability':
        tasks = await this.dispatchByCapability(team, params)
        break
      case 'round-robin':
        tasks = this.dispatchRoundRobin(team, params)
        break
      case 'manual':
        tasks = this.dispatchToManual(team, params)
        break
      default:
        tasks = this.dispatchToAll(team, params)
    }

    // Register pending announcements
    const pending = new Set(tasks.map(t => t.id))
    this.pendingAnnouncements.set(params.conversationId, pending)

    console.log(
      `[Orchestrator] Dispatched task to ${tasks.length} agent(s) ` +
      `with strategy: ${strategy}`
    )

    return tasks
  }

  /**
   * Dispatch task based on agent capabilities
   */
  private async dispatchByCapability(
    team: AgentTeam,
    params: { task: string; conversationId: string }
  ): Promise<SubagentTask[]> {
    // First, ask the leader to analyze and route
    const analysisPrompt = this.buildRoutingPrompt(team, params.task)

    // For now, use simple keyword matching on capabilities
    // TODO: Implement AI-based routing using leader agent
    const targetAgents = this.matchAgentsByCapabilities(team, params.task)

    if (targetAgents.length === 0) {
      // No capability match, dispatch to all workers
      return this.dispatchToAll(team, params)
    }

    return targetAgents.map(agent =>
      this.createSubtask({
        team,
        agent,
        task: params.task,
        conversationId: params.conversationId
      })
    )
  }

  /**
   * Build routing analysis prompt for the leader
   */
  private buildRoutingPrompt(team: AgentTeam, task: string): string {
    const agentInfo = team.workers.map(w =>
      `- ${w.config.name}: ${w.config.capabilities?.join(', ') || 'general'}`
    ).join('\n')

    return `Analyze this task and determine which agent(s) should handle it.

Available agents:
${agentInfo}

Task: ${task}

Respond with a JSON array of agent IDs that should handle this task.`
  }

  /**
   * Match agents to task based on capability keywords
   */
  private matchAgentsByCapabilities(team: AgentTeam, task: string): AgentInstance[] {
    const taskLower = task.toLowerCase()
    const matches: AgentInstance[] = []

    for (const worker of team.workers) {
      const capabilities = worker.config.capabilities || []
      if (capabilities.some(cap => taskLower.includes(cap.toLowerCase()))) {
        matches.push(worker)
      }
    }

    return matches
  }

  /**
   * Dispatch task using round-robin
   */
  private dispatchRoundRobin(
    team: AgentTeam,
    params: { task: string; conversationId: string }
  ): SubagentTask[] {
    // Find the least recently used agent
    const sortedWorkers = [...team.workers].sort((a, b) =>
      (a.lastHeartbeat || 0) - (b.lastHeartbeat || 0)
    )

    const target = sortedWorkers[0]
    if (!target) {
      return this.dispatchToAll(team, params)
    }

    return [this.createSubtask({
      team,
      agent: target,
      task: params.task,
      conversationId: params.conversationId
    })]
  }

  /**
   * Dispatch to manually specified agent
   */
  private dispatchToManual(
    team: AgentTeam,
    params: { task: string; conversationId: string }
  ): SubagentTask[] {
    const defaultAgentId = team.config.routing.defaultAgentId
    if (!defaultAgentId) {
      console.warn('[Orchestrator] No default agent specified for manual routing')
      return this.dispatchToAll(team, params)
    }

    const target = team.workers.find(w => w.id === defaultAgentId)
    if (!target) {
      console.warn(`[Orchestrator] Default agent ${defaultAgentId} not found`)
      return this.dispatchToAll(team, params)
    }

    return [this.createSubtask({
      team,
      agent: target,
      task: params.task,
      conversationId: params.conversationId
    })]
  }

  /**
   * Dispatch task to all workers in parallel
   */
  private dispatchToAll(
    team: AgentTeam,
    params: { task: string; conversationId: string }
  ): SubagentTask[] {
    return team.workers.map(worker =>
      this.createSubtask({
        team,
        agent: worker,
        task: params.task,
        conversationId: params.conversationId
      })
    )
  }

  /**
   * Create a subtask for an agent
   */
  private createSubtask(params: {
    team: AgentTeam
    agent: AgentInstance
    task: string
    conversationId: string
  }): SubagentTask {
    const taskId = uuidv4()
    const now = Date.now()

    const subtask: SubagentTask = {
      id: taskId,
      parentConversationId: params.conversationId,
      agentId: params.agent.id,
      task: params.task,
      status: 'pending',
      startedAt: now
    }

    this.tasks.set(taskId, subtask)

    // Update agent state
    params.agent.status = 'running'
    params.agent.currentTaskId = taskId
    params.agent.lastHeartbeat = now

    // Emit task started event
    this.emit('task:started', {
      taskId,
      agentId: params.agent.id,
      teamId: params.team.id
    })

    return subtask
  }

  // ============================================
  // Task Status Management
  // ============================================

  /**
   * Update task status
   */
  updateTaskStatus(
    taskId: string,
    status: SubagentTaskStatus,
    result?: string,
    error?: string
  ): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false

    task.status = status
    if (result !== undefined) task.result = result
    if (error !== undefined) task.error = error

    if (status === 'completed' || status === 'failed') {
      task.completedAt = Date.now()
    }

    // Emit appropriate event
    if (status === 'completed') {
      this.emit('task:completed', { taskId, result })
    } else if (status === 'failed') {
      this.emit('task:failed', { taskId, error })
    }

    return true
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): SubagentTask | undefined {
    return this.tasks.get(taskId)
  }

  /**
   * Get all tasks for a conversation
   */
  getTasksForConversation(conversationId: string): SubagentTask[] {
    return Array.from(this.tasks.values())
      .filter(t => t.parentConversationId === conversationId)
  }

  // ============================================
  // Announcement System (Inspired by OpenClaw)
  // ============================================

  /**
   * Send completion announcement
   */
  sendAnnouncement(announcement: SubagentAnnouncement): void {
    console.log(
      `[Orchestrator] Announcement received: task=${announcement.taskId} ` +
      `agent=${announcement.agentId} status=${announcement.status}`
    )

    // Emit for listeners
    this.emit('announce', announcement)

    // Remove from pending
    const pending = this.pendingAnnouncements.get(announcement.taskId)
    if (pending) {
      pending.delete(announcement.taskId)
    }

    // Update task status
    this.updateTaskStatus(
      announcement.taskId,
      announcement.status === 'completed' ? 'completed' : 'failed',
      announcement.result,
      announcement.status === 'failed' ? 'Agent reported failure' : undefined
    )

    // Update agent status
    this.updateAgentStatus(announcement.agentId, 'idle')
  }

  /**
   * Update agent status
   */
  private updateAgentStatus(agentId: string, status: AgentInstance['status']): void {
    for (const team of this.teams.values()) {
      if (team.leader.id === agentId) {
        team.leader.status = status
        return
      }
      const worker = team.workers.find(w => w.id === agentId)
      if (worker) {
        worker.status = status
        return
      }
    }
  }

  /**
   * Wait for all pending tasks to complete
   */
  async waitForCompletion(params: {
    conversationId: string
    timeout?: number
  }): Promise<SubagentTask[]> {
    const timeout = params.timeout || 300000 // 5 minutes default
    const startTime = Date.now()

    return new Promise((resolve, reject) => {
      const check = () => {
        const pending = this.pendingAnnouncements.get(params.conversationId)

        if (!pending || pending.size === 0) {
          // All tasks completed
          const tasks = this.getTasksForConversation(params.conversationId)
          resolve(tasks)
          return
        }

        if (Date.now() - startTime > timeout) {
          reject(new Error('[Orchestrator] Timeout waiting for subagent completion'))
          return
        }

        // Continue waiting
        setTimeout(check, 1000)
      }

      check()
    })
  }

  /**
   * Aggregate results from multiple tasks
   */
  aggregateResults(
    tasks: SubagentTask[],
    strategy: AggregationStrategy
  ): string {
    const completedTasks = tasks.filter(t => t.status === 'completed' && t.result)

    switch (strategy) {
      case 'concat':
        return completedTasks
          .map(t => `### Agent: ${t.agentId}\n${t.result}`)
          .join('\n\n---\n\n')

      case 'summarize':
        // TODO: Use leader agent to summarize
        return this.simpleSummary(completedTasks)

      case 'vote':
        // Return the longest result (simple voting)
        const longest = completedTasks.reduce((a, b) =>
          (a.result?.length || 0) > (b.result?.length || 0) ? a : b
        )
        return longest.result || ''

      default:
        return completedTasks.map(t => t.result).join('\n')
    }
  }

  /**
   * Simple summary of task results
   */
  private simpleSummary(tasks: SubagentTask[]): string {
    const lines: string[] = ['## Multi-Agent Task Results\n']

    for (const task of tasks) {
      const preview = task.result?.substring(0, 200) || ''
      lines.push(`### ${task.agentId}`)
      lines.push(preview + (preview.length >= 200 ? '...' : ''))
      lines.push('')
    }

    return lines.join('\n')
  }

  // ============================================
  // Utility Methods
  // ============================================

  /**
   * Build subagent system prompt
   */
  buildSubagentPrompt(subtask: SubagentTask, agentConfig: AgentConfig): string {
    return `[Subagent Context]
You are running as a subagent in a multi-agent collaboration.

Task ID: ${subtask.id}
Task: ${subtask.task}

${agentConfig.systemPromptAddition || ''}

Complete this task and provide a clear, concise summary of your findings.
When done, your results will be automatically announced to the parent agent.`
  }

  /**
   * Get team status summary
   */
  getTeamStatus(teamId: string): {
    status: AgentTeam['status']
    leader: { id: string; status: string }
    workers: Array<{ id: string; status: string; currentTaskId?: string }>
    pendingTasks: number
  } | null {
    const team = this.teams.get(teamId)
    if (!team) return null

    const pending = this.pendingAnnouncements.get(team.conversationId)?.size || 0

    return {
      status: team.status,
      leader: {
        id: team.leader.id,
        status: team.leader.status
      },
      workers: team.workers.map(w => ({
        id: w.id,
        status: w.status,
        currentTaskId: w.currentTaskId
      })),
      pendingTasks: pending
    }
  }

  // ============================================
  // Task Execution
  // ============================================

  /**
   * Execute a subtask on the assigned agent
   * This is called after createSubtask to actually run the task
   */
  async executeSubtask(
    subtask: SubagentTask,
    agent: AgentInstance,
    team: AgentTeam
  ): Promise<void> {
    console.log(`[Orchestrator] Executing subtask ${subtask.id} on agent ${agent.id}`)

    // Update status to running
    this.updateTaskStatus(subtask.id, 'running')

    try {
      if (agent.config.type === 'local') {
        await this.executeLocally(subtask, agent, team)
      } else {
        await this.executeRemotely(subtask, agent, team)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[Orchestrator] Subtask ${subtask.id} failed:`, errorMessage)

      // Update status and send announcement
      this.updateTaskStatus(subtask.id, 'failed', undefined, errorMessage)
      this.sendAnnouncement({
        type: 'agent:announce',
        taskId: subtask.id,
        agentId: agent.id,
        status: 'failed',
        result: undefined,
        summary: `Task failed: ${errorMessage}`,
        timestamp: Date.now()
      })

      // Update agent status
      agent.status = 'error'
    }
  }

  /**
   * Execute a subtask on the local agent
   */
  private async executeLocally(
    subtask: SubagentTask,
    agent: AgentInstance,
    team: AgentTeam
  ): Promise<void> {
    console.log(`[Orchestrator] Executing locally on agent ${agent.id}`)

    // Import the local execution module
    const { getOrCreateV2Session } = await import('./session-manager')
    const { getConfig } = await import('../config.service')
    const { getApiCredentials } = await import('./helpers')
    const { resolveCredentialsForSdk, buildBaseSdkOptions } = await import('./sdk-config')
    const { getWorkingDir, getHeadlessElectronPath } = await import('./helpers')

    try {
      // Build subagent-specific system prompt
      const systemPrompt = this.buildSubagentPrompt(subtask, agent.config)

      // Create a child conversation ID
      const childConversationId = `${subtask.parentConversationId}:${subtask.id}`

      // Get config and credentials for local execution
      const config = getConfig()
      const credentials = await getApiCredentials(config)
      const resolvedCredentials = await resolveCredentialsForSdk(credentials)

      // Get working directory and electron path
      const workDir = getWorkingDir(team.spaceId)
      const electronPath = getHeadlessElectronPath()

      // Create Hyper Space MCP server for subagent tools
      const { createHyperSpaceMcpServer } = await import('./hyper-space-mcp')
      const hyperSpaceMcp = createHyperSpaceMcpServer(team.spaceId, childConversationId)

      // Build SDK options for the subagent
      const sdkOptions = buildBaseSdkOptions({
        credentials: resolvedCredentials,
        workDir,
        electronPath,
        spaceId: team.spaceId,
        conversationId: childConversationId,
        abortController: new AbortController(),
        stderrHandler: (data: string) => {
          console.error(`[Subagent][${childConversationId}] stderr:`, data)
        },
        mcpServers: { 'hyper-space': hyperSpaceMcp },
        contextWindow: resolvedCredentials.contextWindow
      })

      // Apply subagent-specific system prompt
      sdkOptions.systemPrompt = systemPrompt

      // Get or create a V2 session for the subagent
      const session = await getOrCreateV2Session(
        team.spaceId,
        childConversationId,
        sdkOptions,
        undefined, // sessionId
        undefined, // config
        workDir
      )

      if (!session) {
        throw new Error('Failed to create session for local subagent')
      }

      // Send the task to the local agent using send() + stream() pattern
      session.send({
        role: 'user',
        content: subtask.task
      })

      // Extract the response content
      let result = ''
      for await (const event of session.stream()) {
        if (event.type === 'content_block_delta') {
          const delta = event.delta as any
          if (delta?.text) {
            result += delta.text
          }
        }
      }

      // Mark as completed
      this.updateTaskStatus(subtask.id, 'completed', result)
      this.sendAnnouncement({
        type: 'agent:announce',
        taskId: subtask.id,
        agentId: agent.id,
        status: 'completed',
        result,
        summary: this.summarizeResult(result),
        timestamp: Date.now()
      })

      agent.status = 'idle'
      console.log(`[Orchestrator] Local subtask ${subtask.id} completed`)

    } catch (error) {
      throw error
    }
  }

  /**
   * Execute a subtask on a remote agent
   */
  private async executeRemotely(
    subtask: SubagentTask,
    agent: AgentInstance,
    team: AgentTeam
  ): Promise<void> {
    console.log(`[Orchestrator] Executing remotely on agent ${agent.id}`)

    // Import the remote client
    const { RemoteWsClient } = await import('../remote-ws/remote-ws-client')
    const { getRemoteDeployService } = await import('../../ipc/remote-server')

    const remoteServerId = agent.config.remoteServerId
    if (!remoteServerId) {
      throw new Error(`Remote agent ${agent.id} has no remoteServerId configured`)
    }

    try {
      // Get remote server info
      const deployService = getRemoteDeployService()
      const serverInfo = await deployService.getServer(remoteServerId)

      if (!serverInfo) {
        throw new Error(`Remote server ${remoteServerId} not found`)
      }

      // Build subagent-specific system prompt
      const systemPrompt = this.buildSubagentPrompt(subtask, agent.config)

      // Create a child conversation ID
      const childConversationId = `${subtask.parentConversationId}:${subtask.id}`

      // Create WebSocket client
      const client = new RemoteWsClient({
        serverId: remoteServerId,
        host: serverInfo.host,
        port: serverInfo.wsPort,
        authToken: serverInfo.authToken,
        useSshTunnel: agent.config.useSshTunnel ?? true
      }, childConversationId)

      // Connect to remote server
      await client.connect()

      // Set up event handlers for streaming
      let result = ''

      client.on('claude:stream', (data: any) => {
        if (data.sessionId === childConversationId) {
          const text = data.data?.text || data.data?.content || ''
          result += text

          // Emit progress event
          this.emit('subagent:progress', {
            taskId: subtask.id,
            agentId: agent.id,
            delta: text,
            total: result
          })
        }
      })

      // Send the task
      const fullResult = await client.sendChatWithStream(
        childConversationId,
        [{ role: 'user', content: subtask.task }],
        {
          systemPrompt,
          workDir: agent.config.remotePath || '/home'
        }
      )

      // Use the accumulated result or the full result
      result = result || fullResult

      // Disconnect
      client.disconnect()

      // Mark as completed
      this.updateTaskStatus(subtask.id, 'completed', result)
      this.sendAnnouncement({
        type: 'agent:announce',
        taskId: subtask.id,
        agentId: agent.id,
        status: 'completed',
        result,
        summary: this.summarizeResult(result),
        timestamp: Date.now()
      })

      agent.status = 'idle'
      console.log(`[Orchestrator] Remote subtask ${subtask.id} completed`)

    } catch (error) {
      throw error
    }
  }

  /**
   * Summarize a result for the announcement
   */
  private summarizeResult(result: string): string {
    const maxLen = 200
    if (result.length <= maxLen) return result
    return result.substring(0, maxLen) + '...'
  }

  /**
   * Execute all pending tasks in a team
   * This is called after dispatchTask to actually run the tasks
   */
  async executeAllTasks(teamId: string): Promise<void> {
    const team = this.teams.get(teamId)
    if (!team) {
      console.warn(`[Orchestrator] Team ${teamId} not found for execution`)
      return
    }

    // Get all pending tasks for this team
    const pendingTasks = Array.from(this.tasks.values())
      .filter(t => t.status === 'pending')

    console.log(`[Orchestrator] Executing ${pendingTasks.length} pending tasks for team ${teamId}`)

    // Execute tasks in parallel based on execution mode
    if (team.config.mode === 'sequential') {
      for (const task of pendingTasks) {
        const agent = this.findAgentForTask(team, task)
        if (agent) {
          await this.executeSubtask(task, agent, team)
        }
      }
    } else {
      // Parallel execution (default)
      await Promise.all(
        pendingTasks.map(async task => {
          const agent = this.findAgentForTask(team, task)
          if (agent) {
            await this.executeSubtask(task, agent, team)
          }
        })
      )
    }
  }

  /**
   * Find the agent instance for a given task
   */
  private findAgentForTask(team: AgentTeam, task: SubagentTask): AgentInstance | null {
    // Check workers first
    const worker = team.workers.find(w => w.id === task.agentId)
    if (worker) return worker

    // Check leader
    if (team.leader.id === task.agentId) return team.leader

    return null
  }

  /**
   * Dispatch and execute a task in one call
   * This is the main entry point for Hyper Space task execution
   */
  async dispatchAndExecute(params: {
    spaceId: string
    task: string
    conversationId: string
  }): Promise<SubagentTask[]> {
    const team = this.getTeamBySpace(params.spaceId)
    if (!team) {
      throw new Error(`[Orchestrator] No team found for space ${params.spaceId}`)
    }

    // Update team's conversation ID if not set
    if (!team.conversationId) {
      team.conversationId = params.conversationId
    }

    // Dispatch tasks
    const tasks = await this.dispatchTask({
      teamId: team.id,
      task: params.task,
      conversationId: params.conversationId
    })

    // Execute all tasks
    await this.executeAllTasks(team.id)

    return tasks
  }

  /**
   * Clean up all resources
   */
  destroy(): void {
    this.teams.clear()
    this.teamsBySpace.clear()
    this.tasks.clear()
    this.pendingAnnouncements.clear()
    this.removeAllListeners()
    console.log('[Orchestrator] Service destroyed')
  }
}

// Export singleton
export const agentOrchestrator = AgentOrchestrator.getInstance()
export { AgentOrchestrator }
