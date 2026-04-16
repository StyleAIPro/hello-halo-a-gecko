  📊 OpenClaw 多 Agent 协同架构分析                                                                  
                                                                                                     
  核心架构设计                                                                                       
                                                                                                     
  OpenClaw 采用了 分层子代理系统，核心概念：                      

  ┌─────────────────────────────────────────────────────────────┐
  │                    Gateway (中央控制面)                      │
  │   管理会话、通道、工具和事件的统一入口                          │
  └─────────────────────────────────────────────────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
      ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
      │   Main Agent  │ │   Main Agent  │ │   Main Agent  │
      │   (深度 0)     │ │   (深度 0)     │ │   (深度 0)     │
      └───────┬───────┘ └───────────────┘ └───────────────┘
              │
      ┌───────┴───────┬───────────────┐
      ▼               ▼               ▼
  ┌─────────┐   ┌─────────┐   ┌─────────┐
  │Subagent │   │Subagent │   │Subagent │
  │(深度 1) │   │(深度 1) │   │(深度 1) │
  └────┬────┘   └─────────┘   └─────────┘
       │
  ┌────┴────┐
  │Subagent │  (最大深度 5 层)
  │(深度 2) │
  └─────────┘

  关键实现机制

  1. Subagent 派生系统 (subagent-spawn.ts)

  // 核心参数
  type SpawnSubagentParams = {
    task: string;           // 任务描述
    label?: string;         // 子代理标签
    agentId?: string;       // 目标 agent ID
    model?: string;         // 模型覆盖
    mode?: "run" | "session";  // 运行模式
    thread?: boolean;       // 是否绑定到线程
    sandbox?: "inherit" | "require";  // 沙箱模式
  }

  2. 自动公告系统 (subagent-announce.ts)

  - 推送式完成通知：子代理完成后自动向父代理发送消息
  - 无需轮询：父代理不需要 sessions_list 或 sleep 检查状态
  - 消息格式：作为用户消息注入到父会话中

  3. 父进程流转发 (acp-spawn-parent-stream.ts)

  - 实时将子代理输出流转发给父代理
  - 支持 stall 检测：长时间无输出时通知父代理
  - 生命周期追踪：记录开始、进度、完成、错误事件

  4. ACP 控制面 (acp/control-plane/)

  - 管理远程/外部代理会话
  - 支持 thread binding：将 ACP 会话绑定到外部通道（WhatsApp、Discord 等）
  - 会话持久化和恢复

  5. 深度限制与并发控制

  const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 5  // 最大嵌套深度
  const maxChildren = 5  // 每个 session 最大并发子代理数

  ---
  🎯 AICO-Bot 多 Agent 协同方案

  基于 OpenClaw 的架构，我为你设计了一个 本地-远程 Agent 协同 方案：

  架构设计

  ┌────────────────────────────────────────────────────────────────┐
  │                     AICO-Bot Desktop                          │
  │  ┌──────────────────────────────────────────────────────────┐  │
  │  │                    Agent Orchestrator                     │  │
  │  │   (新增: 管理 agent 协同、任务分发、结果聚合)               │  │
  │  └──────────────────────────────────────────────────────────┘  │
  │                              │                                  │
  │         ┌────────────────────┼────────────────────┐            │
  │         ▼                    ▼                    ▼            │
  │  ┌─────────────┐    ┌─────────────────┐   ┌─────────────────┐ │
  │  │ Local Agent │    │ Remote Agent 1  │   │ Remote Agent N  │ │
  │  │  (本地 SDK)  │    │  (WebSocket)    │   │  (WebSocket)    │ │
  │  │  深度: 0     │    │   深度: 1       │   │   深度: 1       │ │
  │  └─────────────┘    └─────────────────┘   └─────────────────┘ │
  │                              │                                  │
  │                    ┌─────────┴─────────┐                       │
  │                    │  Shared Terminal  │                       │
  │                    │  (共享终端状态)    │                       │
  │                    └───────────────────┘                       │
  └────────────────────────────────────────────────────────────────┘

  核心实现路径

  1. 创建 Agent 协同服务

  新建 src/main/services/agent/orchestrator.ts:

  // Agent 协同编排器
  export interface AgentTeam {
    id: string
    leader: AgentRole         // 主控 agent
    workers: AgentRole[]      // 工作 agents
    taskQueue: Task[]
    resultAggregator: ResultAggregator
  }

  export interface AgentRole {
    id: string
    type: 'local' | 'remote'
    serverId?: string         // 远程服务器 ID (仅远程)
    capabilities: string[]    // 能力标签
    workspace?: string        // 工作目录
    depth: number             // 嵌套深度
  }

  export interface SubagentTask {
    id: string
    parentAgentId: string
    childAgentId: string
    task: string
    mode: 'run' | 'session'
    status: 'pending' | 'running' | 'completed' | 'failed'
    result?: string
    announcedAt?: number      // 完成公告时间
  }

  2. 扩展远程消息协议

  修改 packages/remote-agent-proxy/src/types.ts:

  export interface ServerMessage {
    type: 'auth:success' | 'auth:failed' |
          'claude:stream' | 'claude:complete' | 'claude:error' | 'claude:session' |
          // 新增: agent 协同消息类型
          'agent:spawn' |        // 派生子代理
          'agent:announce' |     // 子代理完成公告
          'agent:steer' |        // 引导子代理
          'agent:kill' |         // 终止子代理
          'agent:list' |         // 列出子代理
          'agent:stream' |       // 子代理流转发
          // 原有类型...
  }

  3. 实现子代理派生工具

  创建 src/main/services/agent/tools/spawn-subagent.ts:

  export async function spawnSubagent(params: {
    task: string
    targetAgent?: 'local' | 'remote'
    remoteServerId?: string
    mode?: 'run' | 'session'
  }): Promise<SpawnResult> {

    // 1. 路由决策: 本地 vs 远程
    const isRemote = params.targetAgent === 'remote' || params.remoteServerId

    if (isRemote) {
      // 2. 通过 WebSocket 派生远程子代理
      return await spawnRemoteSubagent({
        task: params.task,
        serverId: params.remoteServerId!,
        mode: params.mode
      })
    } else {
      // 3. 本地派生 (复用现有 session-manager)
      return await spawnLocalSubagent(params)
    }
  }

  4. 自动公告系统

  修改 packages/remote-agent-proxy/src/claude-manager.ts:

  // 在 stream 处理中添加完成检测
  private async handleStreamComplete(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (session?.parentSessionId) {
      // 这是子代理会话，发送完成公告
      await this.announceToParent({
        childSessionId: sessionId,
        parentSessionId: session.parentSessionId,
        status: 'completed',
        result: session.accumulatedContent,
        summary: this.summarizeWork(session)
      })
    }
  }

  // 公告消息发送
  private async announceToParent(params: AnnounceParams) {
    this.ws.send(JSON.stringify({
      type: 'agent:announce',
      sessionId: params.parentSessionId,
      data: {
        childSessionId: params.childSessionId,
        status: params.status,
        result: params.result,
        summary: params.summary,
        timestamp: Date.now()
      }
    }))
  }

  5. 本地 Agent 处理远程公告

  修改 src/main/services/agent/send-message.ts:

  // 处理远程 agent 公告
  function handleRemoteAnnouncement(message: ServerMessage) {
    if (message.type !== 'agent:announce') return

    const { childSessionId, status, result, summary } = message.data

    // 注入到父会话作为用户消息
    const announceContent = formatAnnouncement({
      agentId: childSessionId,
      status,
      summary,
      resultPreview: truncate(result, 500)
    })

    // 继续父会话，让 agent 知道子任务完成
    continueConversation({
      conversationId: message.sessionId,
      userMessage: announceContent
    })
  }

  function formatAnnouncement(params: FormatParams): string {
    return `[Subagent Complete] Agent ${params.agentId} finished with status: ${params.status}.
  Summary: ${params.summary}
  ${params.resultPreview ? `Preview: ${params.resultPreview}` : ''}`
  }

  6. 流转发机制

  扩展 RemoteWsClient:

  // 启动子代理流转发
  startSubagentStreamRelay(params: {
    parentSessionId: string
    childSessionId: string
  }): void {

    this.on('agent:stream', (data) => {
      if (data.sessionId === params.childSessionId) {
        // 转发到父会话 UI
        this.emit('subagent:progress', {
          parentId: params.parentSessionId,
          childId: params.childSessionId,
          delta: data.delta,
          timestamp: Date.now()
        })
      }
    })
  }

  使用示例

  本地 Agent 派发任务到远程

  // 用户在本地 AICO-Bot 中输入
  "请分析远程服务器上的代码结构，并让远程 agent 生成测试用例"

  // 本地 Agent 执行流程
  1. 识别需要远程执行
  2. 调用 spawn_subagent 工具
  3. 远程 agent 开始工作
  4. 实时流转发进度
  5. 远程 agent 完成后自动公告
  6. 本地 agent 收到结果并整合

  与现有架构的集成点

  ┌────────────────────────┬────────────────────┬──────────┐
  │          组件          │      修改内容      │ 影响范围 │
  ├────────────────────────┼────────────────────┼──────────┤
  │ remote-ws-client.ts    │ 添加协同消息类型   │ 小       │
  ├────────────────────────┼────────────────────┼──────────┤
  │ claude-manager.ts      │ 添加公告系统       │ 中       │
  ├────────────────────────┼────────────────────┼──────────┤
  │ send-message.ts        │ 处理公告、路由决策 │ 中       │
  ├────────────────────────┼────────────────────┼──────────┤
  │ 新增 orchestrator.ts   │ 协同编排逻辑       │ 新文件   │
  ├────────────────────────┼────────────────────┼──────────┤
  │ 新增 spawn-subagent.ts │ 子代理派生工具     │ 新文件   │
  └────────────────────────┴────────────────────┴──────────┘

  关键设计决策

  1. 推送 vs 轮询：采用 OpenClaw 的推送式公告，避免本地 agent 轮询检查远程状态
  2. 会话标识：使用 sessionId 作为唯一标识，支持会话恢复
  3. 深度限制：限制嵌套深度（建议 3 层），防止无限递归
  4. 错误传播：子代理错误自动传播到父代理，支持重试机制
  5. 共享终端：通过现有 SharedTerminalPanel 可视化所有 agent 输出

  ---
  🚀 实施路线图

  Phase 1: 基础协同（2-3 天）

  - 创建 orchestrator.ts 基础框架
  - 扩展 WebSocket 协议支持协同消息
  - 实现基础的 spawnSubagent 工具

  Phase 2: 自动公告（2-3 天）

  - 修改 claude-manager.ts 添加完成检测
  - 实现公告消息格式化和发送
  - 本地 agent 处理公告并继续会话

  Phase 3: 流转发（1-2 天）

  - 扩展 RemoteWsClient 支持流转发
  - UI 显示子代理实时进度
  - Stall 检测和通知

  Phase 4: 高级功能（可选）

  - agent:steer 引导功能
  - agent:kill 终止功能
  - agent:list 状态查询
  - 结果聚合和摘要

  这个方案充分利用了 OpenClaw 的成熟设计，同时适配 AICO-Bot 的现有架构。核心是建立一个轻量级的
  本地-远程协同协议，让本地 Claude agent 可以无缝地调度和协调远程 agents 完成复杂任务。





  ===============================================================================================================================
    ===============================================================================================================================
      ===============================================================================================================================






这是一个非常好的想法！Hyper Space 作为协调层来管理多个 agent 的协同工作。让我设计一个完整的方案。  
                                                        
  🌌 Hyper Space 架构设计         
                                                                                                     
  概念层级
                                                                                                     
  ┌─────────────────────────────────────────────────────────────────┐
  │                         Hyper Space                              │                               
  │   (协调层: 任务分发、结果聚合、agent 生命周期管理)                  │
  │                                                                  │
  │  ┌──────────────────────────────────────────────────────────┐   │
  │  │                    Orchestrator Agent                     │   │
  │  │   (本地 Claude: 负责任务分析、分发、结果整合)                │   │
  │  └──────────────────────────────────────────────────────────┘   │
  │                              │                                   │
  │         ┌────────────────────┼────────────────────┐             │
  │         ▼                    ▼                    ▼             │
  │  ┌─────────────┐    ┌─────────────────┐   ┌─────────────────┐  │
  │  │ Local Agent │    │ Remote Agent 1  │   │ Remote Agent N  │  │
  │  │  (本地执行)  │    │  (服务器 A)      │   │  (服务器 B)      │  │
  │  └─────────────┘    └─────────────────┘   └─────────────────┘  │
  │                                                                  │
  │  ┌──────────────────────────────────────────────────────────┐   │
  │  │              Shared Terminal (共享终端)                    │   │
  │  │   统一显示所有 agent 的输出、命令执行结果                     │   │
  │  └──────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘

  与现有 Space 系统的对比

  ┌────────────┬─────────────┬────────────────┬──────────────┐
  │    特性    │ Local Space │  Remote Space  │ Hyper Space  │
  ├────────────┼─────────────┼────────────────┼──────────────┤
  │ Agent 数量 │ 1 (本地)    │ 1 (远程)       │ N (混合)     │
  ├────────────┼─────────────┼────────────────┼──────────────┤
  │ 执行位置   │ 本地        │ 远程服务器     │ 分布式       │
  ├────────────┼─────────────┼────────────────┼──────────────┤
  │ 协调机制   │ 无          │ 无             │ Orchestrator │
  ├────────────┼─────────────┼────────────────┼──────────────┤
  │ 任务分发   │ 直接执行    │ WebSocket 转发 │ 智能路由     │
  ├────────────┼─────────────┼────────────────┼──────────────┤
  │ 结果来源   │ 单一        │ 单一           │ 聚合多个     │
  └────────────┴─────────────┴────────────────┴──────────────┘

  数据模型设计

⏺ Searched for 1 pattern, read 2 files (ctrl+o to expand)     
                                       
⏺ 现在我完全理解了现有的 Space 架构。让我为你设计一个完整的 Hyper Space 方案。
                                                   
  ---                                                   
  🌌 Hyper Space 完整设计方案
                                                                                                     
  1. 数据模型扩展
                                                                                                     
  扩展 Space 类型                                                 

  // src/main/services/space.service.ts - 扩展类型定义

  interface Space {
    id: string
    name: string
    icon: string
    path: string
    isTemp: boolean
    createdAt: string
    updatedAt: string
    preferences?: SpacePreferences
    workingDir?: string

    // === 现有远程支持 ===
    claudeSource?: 'local' | 'remote'  // 保留向后兼容

    // === 新增: Hyper Space 支持 ===
    spaceType?: 'local' | 'remote' | 'hyper'  // 空间类型

    // Hyper Space 专属字段
    agents?: AgentConfig[]  // 包含的 agent 列表
    orchestration?: OrchestrationConfig  // 协调配置
  }

  // Agent 配置
  interface AgentConfig {
    id: string              // agent 唯一标识
    name: string            // 显示名称
    type: 'local' | 'remote'

    // 远程 agent 专属
    remoteServerId?: string
    remotePath?: string
    useSshTunnel?: boolean

    // 角色与能力
    role: 'leader' | 'worker'  // 领导者或工作者
    capabilities?: string[]    // 能力标签 ['frontend', 'backend', 'devops', 'testing']

    // 工作目录
    workingDir?: string

    // 模型配置
    model?: string
    thinkingEnabled?: boolean
  }

  // 协调配置
  interface OrchestrationConfig {
    mode: 'parallel' | 'sequential' | 'adaptive'  // 执行模式

    // 任务路由策略
    routing: {
      strategy: 'capability' | 'round-robin' | 'least-loaded' | 'manual'
      defaultAgent?: string  // 默认目标 agent
    }

    // 结果聚合
    aggregation: {
      strategy: 'concat' | 'summarize' | 'vote'  // 结果处理方式
      summarizer?: string  // 负责汇总的 agent id
    }

    // 公告配置 (借鉴 OpenClaw)
    announce: {
      enabled: boolean
      timeout?: number  // 等待子 agent 完成的超时时间
      retries?: number  // 失败重试次数
    }
  }

  2. 空间创建 UI 改造

  新建 CreateSpaceDialog.tsx

  // src/renderer/components/spaces/CreateSpaceDialog.tsx

  import React, { useState } from 'react'
  import { Dialog, Tabs, Select, Checkbox } from '@/components/ui'

  type SpaceMode = 'local' | 'remote' | 'hyper'

  export function CreateSpaceDialog({ onClose, onCreate }: Props) {
    const [mode, setMode] = useState<SpaceMode>('local')
    const [agents, setAgents] = useState<AgentConfig[]>([])

    // Step 1: 选择空间类型
    const renderSpaceTypeSelector = () => (
      <div className="space-type-selector">
        <div 
          className={cn("type-card", mode === 'local' && "active")}
          onClick={() => setMode('local')}
        >
          <Icon name="laptop" />
          <h3>{t('Local Space')}</h3>
          <p>{t('Run Claude locally on your machine')}</p>
        </div>

        <div 
          className={cn("type-card", mode === 'remote' && "active")}
          onClick={() => setMode('remote')}
        >
          <Icon name="cloud" />
          <h3>{t('Remote Space')}</h3>
          <p>{t('Run Claude on a remote server')}</p>
        </div>

        <div 
          className={cn("type-card", mode === 'hyper' && "active")}
          onClick={() => setMode('hyper')}
        >
          <Icon name="network" />
          <h3>{t('Hyper Space')}</h3>
          <p>{t('Coordinate multiple agents (local + remote)')}</p>
          <Badge variant="new">{t('New')}</Badge>
        </div>
      </div>
    )

    // Step 2: Hyper Space - Agent 选择器
    const renderAgentSelector = () => (
      <div className="agent-selector">
        <h4>{t('Select Agents')}</h4>

        {/* 本地 Agent */}
        <div className="agent-option">
          <Checkbox 
            checked={agents.some(a => a.type === 'local')}
            onChange={(checked) => toggleAgent({
              id: 'local',
              name: 'Local Agent',
              type: 'local',
              role: 'worker',
              workingDir: customPath
            })}
          />
          <div className="agent-info">
            <span className="name">{t('Local Agent')}</span>
            <span className="desc">{t('Your local machine')}</span>
          </div>
          <Select 
            value={localAgentRole}
            onChange={setLocalAgentRole}
            options={[
              { value: 'leader', label: t('Leader') },
              { value: 'worker', label: t('Worker') }
            ]}
          />
        </div>

        {/* 远程 Agents */}
        {remoteServers.map(server => (
          <div key={server.id} className="agent-option">
            <Checkbox 
              checked={agents.some(a => a.remoteServerId === server.id)}
              onChange={(checked) => toggleRemoteAgent(server)}
            />
            <div className="agent-info">
              <span className="name">{server.name}</span>
              <span className="desc">{server.host}:{server.port}</span>
            </div>
            <CapabilityTags 
              value={getAgentCapabilities(server.id)}
              onChange={(caps) => updateCapabilities(server.id, caps)}
              suggestions={['frontend', 'backend', 'devops', 'testing', 'database']}
            />
          </div>
        ))}

        {/* 添加更多远程服务器 */}
        <Button variant="ghost" onClick={openAddRemoteServer}>
          <Icon name="plus" /> {t('Add Remote Server')}
        </Button>
      </div>
    )

    // Step 3: 协调配置
    const renderOrchestrationConfig = () => (
      <div className="orchestration-config">
        <h4>{t('Orchestration Settings')}</h4>

        {/* 执行模式 */}
        <FormField label={t('Execution Mode')}>
          <Select
            value={orchestration.mode}
            options={[
              { value: 'parallel', label: t('Parallel - Run tasks simultaneously') },
              { value: 'sequential', label: t('Sequential - Run tasks one by one') },
              { value: 'adaptive', label: t('Adaptive - AI decides based on task') }
            ]}
          />
        </FormField>

        {/* 路由策略 */}
        <FormField label={t('Task Routing')}>
          <Select
            value={orchestration.routing.strategy}
            options={[
              { value: 'capability', label: t('By Capability - Match task to agent skills') },
              { value: 'round-robin', label: t('Round Robin - Distribute evenly') },
              { value: 'least-loaded', label: t('Least Loaded - Send to busiest agent') },
              { value: 'manual', label: t('Manual - You specify each time') }
            ]}
          />
        </FormField>

        {/* 结果聚合 */}
        <FormField label={t('Result Aggregation')}>
          <Select
            value={orchestration.aggregation.strategy}
            options={[
              { value: 'concat', label: t('Concatenate - Show all results') },
              { value: 'summarize', label: t('Summarize - AI creates summary') },
              { value: 'vote', label: t('Vote - Best result wins') }
            ]}
          />
        </FormField>

        {/* 公告超时 */}
        <FormField label={t('Agent Response Timeout')}>
          <Input 
            type="number"
            value={orchestration.announce.timeout || 300}
            suffix={t('seconds')}
          />
        </FormField>
      </div>
    )

    return (
      <Dialog>
        <Tabs defaultValue="type">
          <Tab value="type" label={t('Space Type')}>
            {renderSpaceTypeSelector()}
          </Tab>

          {mode === 'hyper' && (
            <Tab value="agents" label={t('Agents')}>
              {renderAgentSelector()}
            </Tab>
          )}

          {mode === 'hyper' && (
            <Tab value="orchestration" label={t('Orchestration')}>
              {renderOrchestrationConfig()}
            </Tab>
          )}

          <Tab value="details" label={t('Details')}>
            {/* 名称、图标、工作目录等 */}
          </Tab>
        </Tabs>

        <DialogFooter>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" onClick={handleCreate}>
            {t('Create Space')}
          </Button>
        </DialogFooter>
      </Dialog>
    )
  }

  3. Agent 协调器

  新建 src/main/services/agent/orchestrator.ts

  /**
   * Agent Orchestrator for Hyper Space
   *
   * 负责:
   * - 任务分解与分发
   * - Agent 生命周期管理
   * - 结果聚合
   * - 公告系统 (借鉴 OpenClaw)
   */

  import { EventEmitter } from 'events'
  import { v4 as uuidv4 } from 'uuid'

  // ============================================
  // Types
  // ============================================

  export interface AgentTeam {
    id: string
    spaceId: string
    leader: AgentInstance
    workers: AgentInstance[]
    config: OrchestrationConfig
    status: 'idle' | 'active' | 'waiting' | 'completed'
  }

  export interface AgentInstance {
    id: string
    config: AgentConfig
    status: 'idle' | 'running' | 'completed' | 'error'
    currentTask?: string
    lastHeartbeat?: number
  }

  export interface SubagentTask {
    id: string
    parentId: string  // 父任务 ID (如果是子任务)
    agentId: string   // 目标 agent
    task: string      // 任务描述
    status: 'pending' | 'running' | 'completed' | 'failed'
    result?: string
    error?: string
    startedAt?: number
    completedAt?: number
  }

  export interface AnnounceMessage {
    type: 'agent:announce'
    taskId: string
    agentId: string
    status: 'completed' | 'failed'
    result?: string
    summary?: string  // 简短摘要
    timestamp: number
  }

  // ============================================
  // Orchestrator Service
  // ============================================

  class AgentOrchestrator extends EventEmitter {
    private teams: Map<string, AgentTeam> = new Map()
    private tasks: Map<string, SubagentTask> = new Map()
    private pendingAnnouncements: Map<string, Set<string>> = new Map()

    /**
     * 创建 Agent 团队
     */
    createTeam(params: {
      spaceId: string
      agents: AgentConfig[]
      config: OrchestrationConfig
    }): AgentTeam {
      const teamId = uuidv4()

      // 识别 leader 和 workers
      const leader = params.agents.find(a => a.role === 'leader')
      const workers = params.agents.filter(a => a.role === 'worker')

      if (!leader) {
        throw new Error('Hyper Space requires at least one leader agent')
      }

      const team: AgentTeam = {
        id: teamId,
        spaceId: params.spaceId,
        leader: this.createAgentInstance(leader),
        workers: workers.map(w => this.createAgentInstance(w)),
        config: params.config,
        status: 'idle'
      }

      this.teams.set(teamId, team)
      console.log(`[Orchestrator] Created team ${teamId} with ${workers.length} workers`)

      return team
    }

    private createAgentInstance(config: AgentConfig): AgentInstance {
      return {
        id: config.id,
        config,
        status: 'idle'
      }
    }

    /**
     * 分发任务到合适的 agent
     */
    async dispatchTask(params: {
      teamId: string
      task: string
      conversationId: string
      parentMessageId?: string
    }): Promise<SubagentTask[]> {
      const team = this.teams.get(params.teamId)
      if (!team) throw new Error(`Team not found: ${params.teamId}`)

      // 根据路由策略选择 agent
      const routing = team.config.routing

      if (routing.strategy === 'capability') {
        return this.dispatchByCapability(team, params)
      } else if (routing.strategy === 'parallel') {
        return this.dispatchToAll(team, params)
      } else {
        return this.dispatchToDefault(team, params)
      }
    }

    /**
     * 按能力路由
     */
    private async dispatchByCapability(
      team: AgentTeam,
      params: { task: string; conversationId: string }
    ): Promise<SubagentTask[]> {
      // 让 leader 分析任务并决定分发
      const analysisPrompt = `Analyze this task and determine which agent(s) should handle it.

  Available agents:
  ${team.workers.map(w => `- ${w.config.name}: ${w.config.capabilities?.join(', ') ||
  'general'}`).join('\n')}

  Task: ${params.task}

  Respond with a JSON array of agent IDs that should handle this task.
  If the task should be handled by multiple agents in parallel, include all of them.
  If unsure, use the first agent.`

      const leaderResponse = await this.executeOnAgent({
        agent: team.leader,
        message: analysisPrompt,
        conversationId: params.conversationId
      })

      // 解析 leader 的响应
      const targetAgentIds = this.parseAgentSelection(leaderResponse)
      const targets = team.workers.filter(w => targetAgentIds.includes(w.id))

      // 创建子任务
      const tasks: SubagentTask[] = []
      for (const agent of targets) {
        const task = await this.createSubtask({
          team,
          agent,
          task: params.task,
          conversationId: params.conversationId
        })
        tasks.push(task)
      }

      return tasks
    }

    /**
     * 分发到所有 workers
     */
    private async dispatchToAll(
      team: AgentTeam,
      params: { task: string; conversationId: string }
    ): Promise<SubagentTask[]> {
      const tasks: SubagentTask[] = []

      for (const agent of team.workers) {
        const task = await this.createSubtask({
          team,
          agent,
          task: params.task,
          conversationId: params.conversationId
        })
        tasks.push(task)
      }

      return tasks
    }

    /**
     * 创建子任务并执行
     */
    private async createSubtask(params: {
      team: AgentTeam
      agent: AgentInstance
      task: string
      conversationId: string
    }): Promise<SubagentTask> {
      const taskId = uuidv4()

      const subtask: SubagentTask = {
        id: taskId,
        parentId: params.conversationId,
        agentId: params.agent.id,
        task: params.task,
        status: 'pending',
        startedAt: Date.now()
      }

      this.tasks.set(taskId, subtask)

      // 注册等待公告
      const pending = this.pendingAnnouncements.get(params.conversationId) || new Set()
      pending.add(taskId)
      this.pendingAnnouncements.set(params.conversationId, pending)

      // 异步执行
      this.executeSubtask(subtask, params.agent, params.conversationId)

      return subtask
    }

    /**
     * 执行子任务 (本地或远程)
     */
    private async executeSubtask(
      subtask: SubagentTask,
      agent: AgentInstance,
      parentConversationId: string
    ): Promise<void> {
      subtask.status = 'running'
      agent.status = 'running'
      agent.currentTask = subtask.id

      try {
        const result = await this.executeOnAgent({
          agent,
          message: this.buildSubagentPrompt(subtask),
          conversationId: `${parentConversationId}:${subtask.id}`
        })

        subtask.status = 'completed'
        subtask.result = result
        subtask.completedAt = Date.now()

        // 发送完成公告
        this.sendAnnouncement({
          taskId: subtask.id,
          agentId: agent.id,
          status: 'completed',
          result,
          summary: this.summarizeResult(result),
          timestamp: Date.now()
        })

      } catch (error) {
        subtask.status = 'failed'
        subtask.error = error instanceof Error ? error.message : String(error)

        this.sendAnnouncement({
          taskId: subtask.id,
          agentId: agent.id,
          status: 'failed',
          result: subtask.error,
          timestamp: Date.now()
        })
      }

      agent.status = subtask.status === 'completed' ? 'idle' : 'error'
      agent.currentTask = undefined
    }

    /**
     * 在指定 agent 上执行消息
     */
    private async executeOnAgent(params: {
      agent: AgentInstance
      message: string
      conversationId: string
    }): Promise<string> {
      const agent = params.agent

      if (agent.config.type === 'local') {
        // 本地执行
        return this.executeLocally(params)
      } else {
        // 远程执行
        return this.executeRemotely(params)
      }
    }

    private async executeLocally(params: {
      agent: AgentInstance
      message: string
      conversationId: string
    }): Promise<string> {
      // 复用现有的本地 agent 执行逻辑
      const { sendMessage } = await import('./send-message')
      // ... 调用本地 agent
      return '' // placeholder
    }

    private async executeRemotely(params: {
      agent: AgentInstance
      message: string
      conversationId: string
    }): Promise<string> {
      // 复用现有的远程 agent 执行逻辑
      const { RemoteWsClient } = await import('../remote-ws/remote-ws-client')
      // ... 调用远程 agent
      return '' // placeholder
    }

    /**
     * 发送公告 (借鉴 OpenClaw 的 auto-announce)
     */
    private sendAnnouncement(announce: AnnounceMessage): void {
      this.emit('announce', announce)

      // 从待处理列表中移除
      const pending = this.pendingAnnouncements.get(announce.taskId)
      if (pending) {
        pending.delete(announce.taskId)
      }
    }

    /**
     * 等待所有子任务完成
     */
    async waitForCompletion(params: {
      conversationId: string
      timeout?: number
    }): Promise<SubagentTask[]> {
      const timeout = params.timeout || 300000  // 5 分钟默认超时
      const startTime = Date.now()

      return new Promise((resolve, reject) => {
        const check = () => {
          const pending = this.pendingAnnouncements.get(params.conversationId)

          if (!pending || pending.size === 0) {
            // 所有任务完成
            const tasks = Array.from(this.tasks.values())
              .filter(t => t.parentId === params.conversationId)
            resolve(tasks)
            return
          }

          if (Date.now() - startTime > timeout) {
            reject(new Error('Timeout waiting for subagent completion'))
            return
          }

          // 继续等待
          setTimeout(check, 1000)
        }

        check()
      })
    }

    /**
     * 聚合结果
     */
    async aggregateResults(
      tasks: SubagentTask[],
      config: OrchestrationConfig
    ): Promise<string> {
      if (config.aggregation.strategy === 'concat') {
        return tasks
          .filter(t => t.status === 'completed')
          .map(t => `### ${t.agentId}\n${t.result}`)
          .join('\n\n---\n\n')
      }

      if (config.aggregation.strategy === 'summarize') {
        // 使用 leader agent 汇总
        const summarizer = config.aggregation.summarizer
        // ... 调用 summarizer agent 生成摘要
        return 'Summary placeholder'
      }

      return tasks.map(t => t.result).join('\n')
    }

    /**
     * 构建子 agent 提示词
     */
    private buildSubagentPrompt(subtask: SubagentTask): string {
      return `[Subagent Context]
  You are running as a subagent. Your results will be automatically announced to the parent agent.

  Task ID: ${subtask.id}
  Task: ${subtask.task}

  Complete this task and provide a clear, concise summary of your findings.`
    }

    /**
     * 总结结果
     */
    private summarizeResult(result: string): string {
      const maxLen = 200
      if (result.length <= maxLen) return result
      return result.substring(0, maxLen) + '...'
    }

    private parseAgentSelection(response: string): string[] {
      try {
        const match = response.match(/\[.*?\]/s)
        if (match) {
          return JSON.parse(match[0])
        }
      } catch {}
      return []
    }
  }

  // 单例导出
  export const agentOrchestrator = new AgentOrchestrator()

  4. 扩展空间服务

  // src/main/services/space.service.ts - 新增 Hyper Space 创建

  /**
   * 创建 Hyper Space
   */
  export function createHyperSpace(params: {
    name: string
    icon: string
    agents: AgentConfig[]
    orchestration: OrchestrationConfig
    customPath?: string
  }): Space {
    // 验证至少有一个 leader
    const leaders = params.agents.filter(a => a.role === 'leader')
    if (leaders.length === 0) {
      throw new Error('Hyper Space requires at least one leader agent')
    }

    // 创建空间
    const space = createSpace({
      name: params.name,
      icon: params.icon,
      customPath: params.customPath,
      claudeSource: 'local', // 保持向后兼容
      // 新增 Hyper Space 字段
      spaceType: 'hyper',
      agents: params.agents,
      orchestration: params.orchestration
    })

    // 创建 Agent 团队
    agentOrchestrator.createTeam({
      spaceId: space.id,
      agents: params.agents,
      config: params.orchestration
    })

    return space
  }

  5. IPC 通信

  // src/main/ipc/space.ts - 新增 IPC handlers

  ipcMain.handle('space:create-hyper', async (_, params) => {
    return createHyperSpace(params)
  })

  // 获取 Hyper Space 状态
  ipcMain.handle('space:get-hyper-status', async (_, spaceId) => {
    const team = agentOrchestrator.getTeamBySpace(spaceId)
    return team ? {
      status: team.status,
      agents: team.workers.map(w => ({
        id: w.id,
        name: w.config.name,
        status: w.status,
        currentTask: w.currentTask
      }))
    } : null
  })

  // 手动分发任务
  ipcMain.handle('space:dispatch-task', async (_, params) => {
    return agentOrchestrator.dispatchTask(params)
  })

  6. UI 显示

  Space 卡片显示多 Agent

  // src/renderer/components/spaces/SpaceCard.tsx

  export function SpaceCard({ space }: Props) {
    const isHyper = space.spaceType === 'hyper'

    return (
      <div className="space-card">
        <div className="header">
          <Icon name={space.icon} />
          <h3>{space.name}</h3>
          {isHyper && <Badge variant="gradient">Hyper</Badge>}
        </div>

        {isHyper && (
          <div className="agent-avatars">
            {space.agents?.map(agent => (
              <Avatar 
                key={agent.id}
                name={agent.name}
                status={getAgentStatus(agent.id)}
                size="sm"
              />
            ))}
          </div>
        )}

        <div className="meta">
          {isHyper ? (
            <span>
              {space.agents?.length || 0} agents •
              {space.agents?.filter(a => a.type === 'remote').length || 0} remote
            </span>
          ) : (
            <span>{space.claudeSource === 'remote' ? 'Remote' : 'Local'}</span>
          )}
        </div>
      </div>
    )
  }

  7. 实施路线图

  Phase 1: 基础架构 (3-4 天)
  ├── 扩展 Space 类型定义
  ├── 创建 Orchestrator 服务框架
  ├── IPC handlers
  └── 基础 UI 改造

  Phase 2: 任务分发 (3-4 天)
  ├── 实现 dispatchTask 逻辑
  ├── 本地/远程 agent 执行
  ├── 子任务创建与追踪
  └── 状态管理

  Phase 3: 公告系统 (2-3 天)
  ├── 实现 sendAnnouncement
  ├── waitForCompletion
  ├── 结果聚合
  └── 错误处理

  Phase 4: UI 完善 (2-3 天)
  ├── 创建空间向导
  ├── Agent 状态显示
  ├── 实时进度可视化
  └── 结果展示组件

  ---
  这个设计充分利用了 OpenClaw 的成熟模式（子代理派生、自动公告、流转发），同时适配了 AICO-Bot
  的现有架构（Space 系统、远程 WebSocket 连接）。核心思想是让 Hyper Space
  成为协调层，让用户可以灵活组合本地和远程 agent 来处理复杂任务。