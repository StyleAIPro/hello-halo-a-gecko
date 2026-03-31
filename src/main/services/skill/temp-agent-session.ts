/**
 * 临时 Agent 会话服务
 * 用于技能生成器，创建临时的 Claude Agent 会话，不持久化到磁盘
 */

import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { homedir } from 'os'
import { getConfig } from '../config.service'
import { getAgentsSkillsDir } from '../config.service'
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk'
import {
  getHeadlessElectronPath,
} from '../agent/helpers'
import { resolveCredentialsForSdk, buildBaseSdkOptions } from '../agent/sdk-config'
import type { ConversationAnalysisResult } from './conversation-analyzer'
import type { SimilarSkill } from './similarity-calculator'

// ============================================
// Types
// ============================================

export interface TempSessionOptions {
  skillName: string
  context: {
    conversationAnalysis?: ConversationAnalysisResult | null
    similarSkills?: SimilarSkill[]
    mode: 'create' | 'optimize'
    initialPrompt?: string  // 添加可选的初始 prompt
  }
  // 可选的流式回调,用于创建会话后自动发送初始消息
  // 回调函数接收 sessionId 和 chunk，方便前端过滤消息
  onChunk?: (sessionId: string, chunk: StreamChunk) => void
}

export interface TempSession {
  id: string
  skillName: string
  status: 'idle' | 'running' | 'complete' | 'error'
  createdAt: number
  session: any  // V2SDKSession
  messages: TempSessionMessage[]
  error?: string
}

export interface TempSessionMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  isStreaming?: boolean
}

export interface StreamChunk {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'complete' | 'error'
  content?: string
  toolName?: string
  toolInput?: any
  toolOutput?: string
  isError?: boolean
}

// ============================================
// Session Storage
// ============================================

const tempSessions = new Map<string, TempSession>()
const activeStreams = new Map<string, AbortController>()

// ============================================
// Session Management
// ============================================

/**
 * 创建临时 Agent 会话
 */
export async function createTempAgentSession(
  options: TempSessionOptions
): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  try {
    const sessionId = `temp-skill-${uuidv4()}`
    const skillsDir = getAgentsSkillsDir()
    const config = getConfig()
    const electronPath = getHeadlessElectronPath()

    // 获取 API 凭证
    const credentials = await getApiCredentials(config)
    const resolvedCredentials = await resolveCredentialsForSdk(credentials)

    // 构建 SDK 选项
    const abortController = new AbortController()
    const sdkOptions = buildBaseSdkOptions({
      credentials: resolvedCredentials,
      workDir: skillsDir,  // 使用技能目录作为工作目录
      electronPath,
      spaceId: 'temp-skill-space',
      conversationId: sessionId,
      abortController,
      stderrHandler: (data: string) => {
        console.error(`[TempAgent][${sessionId}] stderr:`, data)
      },
      mcpServers: null,
      maxTurns: config.agent?.maxTurns,
      contextWindow: resolvedCredentials.contextWindow
    })

    // 配置 skill-creator 技能
    sdkOptions.skill = 'skill-creator'
    sdkOptions.permissionMode = 'bypassPermissions'
    sdkOptions.includePartialMessages = true

    console.log(`[TempAgent] Creating session ${sessionId} for skill: ${options.skillName}`)

    // 创建 V2 Session
    const sdkSession = await unstable_v2_createSession(sdkOptions as any) as any

    console.log(`[TempAgent] Session ${sessionId} created`)

    // 初始化消息，包含上下文
    const initialMessage = buildInitialMessage(options)

    // 添加 assistant 消息占位符
    const assistantMsgId = `${sessionId}-assistant-init`
    const assistantMsg: TempSessionMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      isStreaming: true
    }

    const tempSession: TempSession = {
      id: sessionId,
      skillName: options.skillName,
      status: 'running',  // 设置为 running 状态
      createdAt: Date.now(),
      session: sdkSession,
      messages: [{
        id: `${sessionId}-init`,
        role: 'user',
        content: initialMessage,
        timestamp: new Date().toISOString()
      }, assistantMsg]  // 添加 assistant 消息
    }

    tempSessions.set(sessionId, tempSession)
    activeStreams.set(sessionId, abortController)

    console.log(`[TempAgent] Session ${sessionId} created, sending initial message...`)

    // 异步发送初始消息（在后台执行），不阻塞返回
    ; (async () => {
      try {
        // 使用 send() + stream() 模式（V2 Session 接口）
        console.log(`[TempAgent][${sessionId}] Calling send()...`)
        sdkSession.send({
          role: 'user',
          content: initialMessage
        })
        console.log(`[TempAgent][${sessionId}] send() completed, starting stream()...`)
        let fullContent = ''

        for await (const event of sdkSession.stream()) {
          console.log(`[TempAgent][${sessionId}] Received event:`, event?.type)
          const chunk = processStreamEvent(event)
          if (chunk) {
            // 如果提供了 onChunk 回调，使用它通知前端
            if (options.onChunk) {
              options.onChunk(sessionId, chunk)
            }
            if (chunk.type === 'text' && chunk.content) {
              fullContent += chunk.content
            }
          }
        }

        // 更新 assistant 消息
        const session = tempSessions.get(sessionId)
        if (session) {
          const lastMsg = session.messages[session.messages.length - 1]
          if (lastMsg && lastMsg.role === 'assistant') {
            lastMsg.content = fullContent
            lastMsg.isStreaming = false
          }
          session.status = 'complete'
        }

        // 通知流式完成
        if (options.onChunk) {
          options.onChunk(sessionId, { type: 'complete' })
        }

        console.log(`[TempAgent] Initial message sent and completed for session ${sessionId}`)
      } catch (sendError) {
        console.error(`[TempAgent] Failed to send initial message:`, sendError)
        const session = tempSessions.get(sessionId)
        if (session) {
          session.status = 'error'
          session.error = sendError instanceof Error ? sendError.message : 'Failed to send initial message'
        }
        if (options.onChunk) {
          options.onChunk(sessionId, {
            type: 'error',
            content: sendError instanceof Error ? sendError.message : 'Failed to send initial message'
          })
        }
      }
    })()

    return { success: true, data: { sessionId } }
  } catch (error) {
    console.error('[TempAgent] Failed to create session:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create session'
    }
  }
}

/**
 * 发送消息到临时会话
 */
export async function sendTempAgentMessage(
  sessionId: string,
  message: string,
  onChunk: (chunk: StreamChunk) => void
): Promise<{ success: boolean; error?: string }> {
  const session = tempSessions.get(sessionId)

  if (!session) {
    return { success: false, error: 'Session not found' }
  }

  if (session.status === 'running') {
    return { success: false, error: 'Session is busy' }
  }

  try {
    session.status = 'running'

    // 添加用户消息
    const userMsg: TempSessionMessage = {
      id: `${sessionId}-${Date.now()}`,
      role: 'user',
      content: message,
      timestamp: new Date().toISOString()
    }
    session.messages.push(userMsg)

    // 添加占位的 assistant 消息
    const assistantMsgId = `${sessionId}-${Date.now() + 1}`
    const assistantMsg: TempSessionMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      isStreaming: true
    }
    session.messages.push(assistantMsg)

    // 发送消息并处理流式响应
    let fullContent = ''

    // 使用 send() + stream() 模式（V2 Session 接口）
    session.session.send({
      role: 'user',
      content: message
    })

    for await (const event of session.session.stream()) {
      const chunk = processStreamEvent(event)
      if (chunk) {
        onChunk(chunk)
        if (chunk.type === 'text' && chunk.content) {
          fullContent += chunk.content
        }
      }
    }

    // 更新 assistant 消息
    assistantMsg.content = fullContent
    assistantMsg.isStreaming = false
    session.status = 'complete'

    onChunk({ type: 'complete' })

    return { success: true }
  } catch (error) {
    session.status = 'error'
    session.error = error instanceof Error ? error.message : 'Unknown error'

    onChunk({
      type: 'error',
      content: session.error
    })

    return {
      success: false,
      error: session.error
    }
  }
}

/**
 * 关闭临时会话
 */
export async function closeTempAgentSession(sessionId: string): Promise<{ success: boolean }> {
  const session = tempSessions.get(sessionId)

  if (session) {
    try {
      session.session.close()
    } catch (e) {
      // Ignore close errors
    }

    tempSessions.delete(sessionId)
    activeStreams.delete(sessionId)
    console.log(`[TempAgent] Session ${sessionId} closed`)
  }

  return { success: true }
}

/**
 * 获取临时会话状态
 */
export function getTempSessionStatus(sessionId: string): TempSession | null {
  return tempSessions.get(sessionId) || null
}

/**
 * 获取所有临时会话
 */
export function getAllTempSessions(): TempSession[] {
  return Array.from(tempSessions.values())
}

/**
 * 清理所有临时会话
 */
export function cleanupAllTempSessions(): void {
  for (const [id, session] of tempSessions) {
    try {
      session.session.close()
    } catch (e) {
      // Ignore
    }
  }
  tempSessions.clear()
  activeStreams.clear()
  console.log('[TempAgent] All temp sessions cleaned up')
}

// ============================================
// Helper Functions
// ============================================

/**
 * 获取 API 凭证 (复用自 agent/helpers)
 */
async function getApiCredentials(config: any) {
  const { getCurrentSource } = await import('../../../shared/types/ai-sources')

  const currentSource = getCurrentSource(config.aiSources)
  if (!currentSource) {
    throw new Error('No AI source configured')
  }
  return currentSource
}

/**
 * 构建初始消息
 */
function buildInitialMessage(options: TempSessionOptions): string {
  const { skillName, context } = options
  const { conversationAnalysis, similarSkills, mode, initialPrompt } = context

  // 如果提供了初始 prompt,直接使用
  if (initialPrompt) {
    return initialPrompt
  }

  // 如果没有对话分析,使用简化模式
  if (!conversationAnalysis) {
    return `## 任务
请创建新技能: ${skillName}

## 指令
请使用 Write 工具创建 SKILL.yaml 文件到 ${homedir()}/.agents/skills/${skillName}/ 目录。确保包含:
1. name: 技能名称
2. description: 技能描述
3. trigger_command: 触发命令（如 /${skillName.replace(/[^a-z0-9]/g, '')}）
4. system_prompt: 系统提示词
`
  }

  const modeText = mode === 'optimize'
    ? '请基于以下分析优化现有技能'
    : '请基于以下分析创建新技能'

  let message = `## 任务
${modeText}: ${skillName}

## 对话分析

### 用户意图
- 任务类型: ${conversationAnalysis.userIntent.taskType}
- 主要目标: ${conversationAnalysis.userIntent.primaryGoal}
- 关键词: ${conversationAnalysis.userIntent.keywords.join(', ')}

### 工具使用模式
${conversationAnalysis.toolPattern.successPattern}

### 可复用性评估
- 得分: ${(conversationAnalysis.reusability.score * 100).toFixed(0)}%
- 可复用模式: ${conversationAnalysis.reusability.patterns.join(', ')}
- 建议: ${conversationAnalysis.reusability.suggestions.join('; ')}

`

  if (similarSkills && similarSkills.length > 0) {
    message += `
## 相似技能

发现 ${similarSkills.length} 个相似技能,建议优化现有技能而不是创建新的:

`
    for (const skill of similarSkills.slice(0, 3)) {
      message += `### ${skill.skill.spec.name}
- 相似度: ${(skill.similarity * 100).toFixed(0)}%
- 原因: ${skill.matchReasons.join(', ')}
- 改进建议: ${skill.suggestedImprovements.join('; ')}

`
    }
  }

  message += `
## 指令

请${mode === 'optimize' ? '优化现有技能或创建新版本' : '创建新的技能'}:
1. 分析上述对话模式
2. 设计合适的 system_prompt
3. 使用 Write 工具创建或更新 SKILL.yaml 文件到 ${homedir()}/.agents/skills/${skillName}/ 目录
4. 确保包含 name、description、trigger_command 等必要字段
`

  return message
}

/**
 * 处理流式事件
 */
function processStreamEvent(event: any): StreamChunk | null {
  if (!event) return null

  // 处理不同类型的事件
  if (event.type === 'content_block_start') {
    if (event.content_block?.type === 'thinking') {
      return { type: 'thinking' }
    }
    if (event.content_block?.type === 'tool_use') {
      return {
        type: 'tool_use',
        toolName: event.content_block.name
      }
    }
  }

  if (event.type === 'content_block_delta') {
    if (event.delta?.type === 'text_delta') {
      return {
        type: 'text',
        content: event.delta.text
      }
    }
    if (event.delta?.type === 'thinking_delta') {
      return {
        type: 'thinking',
        content: event.delta.thinking
      }
    }
    if (event.delta?.type === 'input_json_delta') {
      return {
        type: 'tool_use',
        toolInput: event.delta.partial_json
      }
    }
  }

  if (event.type === 'content_block_stop') {
    return null
  }

  if (event.type === 'message_stop') {
    return { type: 'complete' }
  }

  if (event.type === 'error') {
    return {
      type: 'error',
      content: event.error?.message || 'Unknown error',
      isError: true
    }
  }

  return null
}
