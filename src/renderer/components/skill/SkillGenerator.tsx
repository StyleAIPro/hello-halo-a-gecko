/**
 * SkillGenerator - 技能生成器
 *
 * 从对话历史中学习，AI 辅助生成可复用的技能
 *
 * 使用技能专用空间 (halo-skill-creator) 进行会话管理，
 * 复用主对话框的 IPC 事件系统和 chat store，
 * 实现会话持久化和完整的对话能力。
 *
 * 布局：
 * - 左侧：对话选择（支持多空间）+ 会话历史 + 技能配置
 * - 中间：Skill 文件预览（SKILL.yaml 内容 + 目录结构）
 * - 右侧：Agent 对话面板（1/4 宽度）
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useSkillStore } from '../../stores/skill/skill.store'
import { useSpaceStore } from '../../stores/space.store'
import { useChatStore } from '../../stores/chat.store'
import { useTranslation } from '../../i18n'
import {
  Sparkles,
  MessageSquare,
  FolderTree,
  FileCode,
  Loader2,
  X,
  Send,
  Bot,
  Folder,
  File,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  CheckSquare,
  Square,
  Brain,
  Wrench,
  Terminal,
  History,
  Plus,
  Trash2,
  Lightbulb,
  CheckCircle2,
  AlertTriangle,
  Circle
} from 'lucide-react'
import { api } from '../../api'
import type { Thought, Message } from '../../types'
import { getSkillSpaceId } from '../../services/skill-space'

// 对话选项（包含空间信息）
interface ConversationOption {
  id: string
  title: string
  spaceId: string
  spaceName: string
  updatedAt: string
}

// Skill 文件节点
interface SkillFileNode {
  name: string
  type: 'file' | 'directory'
  children?: SkillFileNode[]
  content?: string
}

// 技能会话元数据
interface SkillConversationMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

// 左侧面板视图类型
type LeftPanelView = 'select' | 'history'

// 技能空间的 ID
const SKILL_SPACE_ID = getSkillSpaceId()

export function SkillGenerator() {
  const { t } = useTranslation()
  const spaces = useSpaceStore(state => state.spaces)

  const {
    installedSkills,
    loadInstalledSkills,
    agentPanelOpen,
    setAgentPanelOpen
  } = useSkillStore()

  // 从 chat store 读取会话状态
  const sessions = useChatStore(state => state.sessions)
  const conversationCache = useChatStore(state => state.conversationCache)

  // 会话状态（使用持久化会话）
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 会话历史
  const [conversationHistory, setConversationHistory] = useState<SkillConversationMeta[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [leftPanelView, setLeftPanelView] = useState<LeftPanelView>('select')

  // 本地状态
  const [selectedConversations, setSelectedConversations] = useState<ConversationOption[]>([])
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set())
  const [skillRequirements, setSkillRequirements] = useState('')
  const [generatedSkillName, setGeneratedSkillName] = useState('')
  const [userInput, setUserInput] = useState('')
  const [skillFiles, setSkillFiles] = useState<SkillFileNode[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState('')
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [loadingFiles, setLoadingFiles] = useState(false)

  // 加载的会话消息（来自后端）
  const [loadedMessages, setLoadedMessages] = useState<Message[]>([])

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const prevConversationIdRef = useRef<string | null>(null)

  // 获取当前会话的 session state
  const sessionState = currentConversationId ? sessions.get(currentConversationId) : null

  // 获取当前会话的消息（优先使用 cache，其次使用 loadedMessages）
  const conversation = currentConversationId ? conversationCache.get(currentConversationId) : null
  const messages = conversation?.messages || loadedMessages

  // 是否正在生成
  const isGenerating = sessionState?.isGenerating || false

  // 检查是否有任何会话正在生成（用于 History 标签指示）
  const anySessionGenerating = useMemo(() => {
    for (const [, state] of sessions) {
      if (state.isGenerating) return true
    }
    return false
  }, [sessions])

  // 流式内容（来自 session state）
  const streamingContent = sessionState?.streamingContent || ''
  const isStreaming = sessionState?.isStreaming || false
  const thoughts = sessionState?.thoughts || []

  // 获取所有空间的对话
  const allConversations = useMemo(() => {
    const result: ConversationOption[] = []

    for (const space of spaces) {
      const convs = useChatStore.getState().spaceStates.get(space.id)?.conversations || []
      for (const conv of convs) {
        result.push({
          id: conv.id,
          title: conv.title || t('Untitled'),
          spaceId: space.id,
          spaceName: space.name,
          updatedAt: conv.updatedAt
        })
      }
    }

    return result.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
  }, [spaces, t])

  // 按空间分组
  const conversationsBySpace = useMemo(() => {
    const grouped = new Map<string, ConversationOption[]>()
    for (const conv of allConversations) {
      const existing = grouped.get(conv.spaceId) || []
      existing.push(conv)
      grouped.set(conv.spaceId, existing)
    }
    return grouped
  }, [allConversations])

  // 加载会话历史
  const loadConversationHistory = useCallback(async () => {
    setLoadingHistory(true)
    try {
      const result = await api.skillConversationList()
      if (result.success && result.data) {
        setConversationHistory(result.data as SkillConversationMeta[])
      }
    } catch (e) {
      console.error('Failed to load conversation history:', e)
    } finally {
      setLoadingHistory(false)
    }
  }, [])

  // 加载会话详情
  const loadConversation = useCallback(async (conversationId: string) => {
    try {
      const result = await api.skillConversationGet(conversationId)
      if (result.success && result.data) {
        const conversation = result.data as any
        setLoadedMessages(conversation.messages || [])
        setCurrentConversationId(conversationId)
        setAgentPanelOpen(true)
      }
    } catch (e) {
      console.error('Failed to load conversation:', e)
    }
  }, [setAgentPanelOpen])

  // 切换对话选择
  const toggleConversation = (conv: ConversationOption) => {
    setSelectedConversations(prev => {
      const exists = prev.find(c => c.id === conv.id)
      if (exists) {
        return prev.filter(c => c.id !== conv.id)
      } else {
        return [...prev, conv]
      }
    })
  }

  // 切换空间展开/收起
  const toggleSpaceExpand = (spaceId: string) => {
    setExpandedSpaces(prev => {
      const next = new Set(prev)
      if (next.has(spaceId)) {
        next.delete(spaceId)
      } else {
        next.add(spaceId)
      }
      return next
    })
  }

  // 全选/取消全选某个空间的所有会话
  const toggleSpaceConversations = (spaceId: string, selectAll: boolean) => {
    const spaceConvs = conversationsBySpace.get(spaceId) || []
    setSelectedConversations(prev => {
      if (selectAll) {
        const existingIds = new Set(prev.map(c => c.id))
        const newConvs = spaceConvs.filter(c => !existingIds.has(c.id))
        return [...prev, ...newConvs]
      } else {
        return prev.filter(c => c.spaceId !== spaceId)
      }
    })
  }

  // 检查空间的选中状态
  const getSpaceSelectionState = (spaceId: string): 'all' | 'partial' | 'none' => {
    const spaceConvs = conversationsBySpace.get(spaceId) || []
    if (spaceConvs.length === 0) return 'none'

    const selectedCount = selectedConversations.filter(c => c.spaceId === spaceId).length
    if (selectedCount === 0) return 'none'
    if (selectedCount === spaceConvs.length) return 'all'
    return 'partial'
  }

  // 初始化技能会话的 session state
  const initSkillSessionState = useCallback((conversationId: string) => {
    console.log(`[SkillGenerator] Initializing session state for: ${conversationId}`)
    useChatStore.setState((state) => {
      const newSessions = new Map(state.sessions)
      newSessions.set(conversationId, {
        isGenerating: true,
        isStopping: false,
        streamingContent: '',
        isStreaming: false,
        thoughts: [],
        isThinking: false,
        pendingToolApproval: null,
        error: null,
        errorType: null,
        compactInfo: null,
        textBlockVersion: 0,
        pendingQuestion: null
      })
      console.log(`[SkillGenerator] Session state set, sessions map size: ${newSessions.size}`)
      return { sessions: newSessions }
    })
  }, [])

  // 启动生成（支持同时生成多个技能）
  const handleStartGeneration = async () => {
    if (selectedConversations.length === 0) {
      alert(t('Please select at least one conversation'))
      return
    }

    // 检查 skill-creator 技能是否已安装
    const skillCreatorInstalled = installedSkills.some(
      skill => skill.appId === 'skill-creator' || skill.spec?.name === 'skill-creator'
    )
    if (!skillCreatorInstalled) {
      alert(t('skill-creator skill is not installed. Please install it from the Skill Market first.'))
      useSkillStore.getState().setCurrentView('market')
      return
    }

    // 构建初始 prompt
    const conversationContext = selectedConversations
      .map(c => `[${c.spaceName}] ${c.title}`)
      .join('\n')

    const requirementsText = skillRequirements.trim()
      ? `\n\n## 用户的额外要求\n${skillRequirements.trim()}`
      : ''

    const initialPrompt = `请根据以下对话历史帮我创建一个可复用的技能。

## 对话历史
${conversationContext}
${requirementsText}

## 任务要求
1. 分析上述对话的模式和特点，理解用户的核心需求
2. 自行为技能选择一个合适的英文名称（简洁、有意义、kebab-case 格式）
3. 自行生成合适的触发命令（如 /xxx 格式）
4. 编写清晰的技能描述和系统提示词
5. 使用 skill-creator 技能来创建新的技能到 ~/.agents/skills/<技能名称>/ 目录

请开始创建技能。`

    // 打开面板
    setAgentPanelOpen(true)
    setError(null)

    try {
      // 创建新的持久化会话
      const createResult = await api.skillConversationCreate(`Skill: ${new Date().toLocaleDateString()}`)

      if (!createResult.success || !createResult.data) {
        setError(createResult.error || 'Failed to create conversation')
        return
      }

      const newConversationId = (createResult.data as any).id
      setCurrentConversationId(newConversationId)

      // 立即刷新会话历史（创建后立即显示）
      loadConversationHistory()

      // 立即显示用户消息
      const userMsg: Message = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content: initialPrompt,
        timestamp: new Date().toISOString()
      }
      setLoadedMessages([userMsg])

      // 初始化 session state
      initSkillSessionState(newConversationId)

      // 异步发送消息，不阻塞 UI（后端会通过标准 IPC 事件发送流式数据）
      api.skillConversationSend(newConversationId, initialPrompt).then(sendResult => {
        if (!sendResult.success) {
          setError(sendResult.error || 'Failed to send message')
        }
        // 再次刷新会话历史（更新消息数等）
        loadConversationHistory()
        // 重新加载当前会话以获取保存的思考过程
        loadConversation(newConversationId)
      }).catch(e => {
        console.error('Failed to send message:', e)
        setError(e instanceof Error ? e.message : 'Failed to send message')
      })

    } catch (e) {
      console.error('Failed to start generation:', e)
      setError(e instanceof Error ? e.message : 'Failed to start generation')
    }
  }

  // 发送消息
  const handleSendMessage = () => {
    if (!userInput.trim() || isGenerating || !currentConversationId) return

    const message = userInput.trim()
    setUserInput('')

    // 立即添加用户消息到本地状态
    const userMsg: Message = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: message,
      timestamp: new Date().toISOString()
    }
    setLoadedMessages(prev => [...prev, userMsg])

    // 重置 session state 以接收新的流式内容
    initSkillSessionState(currentConversationId)

    // 异步发送消息，不阻塞 UI
    api.skillConversationSend(currentConversationId, message).then(sendResult => {
      if (sendResult.success) {
        // 重新加载当前会话以获取保存的思考过程
        loadConversation(currentConversationId)
      } else {
        setError(sendResult.error || 'Failed to send message')
      }
    }).catch(e => {
      console.error('Failed to send message:', e)
      setError(e instanceof Error ? e.message : 'Failed to send message')
    })
  }

  // 删除会话
  const handleDeleteConversation = async (conversationId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm(t('Delete this conversation?'))) return

    try {
      await api.skillConversationDelete(conversationId)
      setConversationHistory(prev => prev.filter(c => c.id !== conversationId))

      if (currentConversationId === conversationId) {
        setCurrentConversationId(null)
        setLoadedMessages([])
        setAgentPanelOpen(false)
      }
    } catch (err) {
      console.error('Failed to delete conversation:', err)
    }
  }

  // 刷新技能文件
  const refreshSkillFiles = async () => {
    if (!generatedSkillName) return

    setLoadingFiles(true)
    try {
      const result = await api.skillFiles(generatedSkillName)
      if (result.success && result.data) {
        setSkillFiles(result.data as SkillFileNode[])

        const skillYaml = findSkillYaml(result.data as SkillFileNode[])
        if (skillYaml) {
          setSelectedFile(skillYaml)
          loadFileContent(skillYaml)
        }
      }
    } catch (e) {
      console.error('Failed to refresh skill files:', e)
    } finally {
      setLoadingFiles(false)
    }
  }

  // 查找 SKILL.yaml
  const findSkillYaml = (nodes: SkillFileNode[]): string | null => {
    for (const node of nodes) {
      if (node.type === 'file' && (node.name === 'SKILL.yaml' || node.name === 'SKILL.md')) {
        return node.name
      }
      if (node.children) {
        const found = findSkillYaml(node.children)
        if (found) return found
      }
    }
    return null
  }

  // 加载文件内容
  const loadFileContent = async (filePath: string) => {
    if (!generatedSkillName) return
    try {
      const result = await api.skillFileContent(generatedSkillName, filePath)
      if (result.success && result.data) {
        setFileContent(result.data)
      }
    } catch (e) {
      console.error('Failed to load file content:', e)
    }
  }

  // 切换目录展开
  const toggleDir = (path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  // 渲染文件树
  const renderFileTree = (nodes: SkillFileNode[], path = ''): React.ReactNode => {
    return nodes.map(node => {
      const fullPath = path ? `${path}/${node.name}` : node.name

      if (node.type === 'directory') {
        const isExpanded = expandedDirs.has(fullPath)
        return (
          <div key={fullPath}>
            <div
              className="flex items-center gap-1 px-2 py-1 hover:bg-secondary/50 cursor-pointer text-sm"
              onClick={() => toggleDir(fullPath)}
            >
              {isExpanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              <Folder className="w-4 h-4 text-yellow-500" />
              <span>{node.name}</span>
            </div>
            {isExpanded && node.children && (
              <div className="ml-4">
                {renderFileTree(node.children, fullPath)}
              </div>
            )}
          </div>
        )
      } else {
        return (
          <div
            key={fullPath}
            className={`flex items-center gap-1 px-2 py-1 hover:bg-secondary/50 cursor-pointer text-sm ${
              selectedFile === fullPath ? 'bg-primary/20' : ''
            }`}
            onClick={() => {
              setSelectedFile(fullPath)
              loadFileContent(fullPath)
            }}
          >
            <File className="w-4 h-4 text-blue-400" />
            <span>{node.name}</span>
          </div>
        )
      }
    })
  }

  // 关闭面板
  const handleClosePanel = async () => {
    if (currentConversationId) {
      try {
        await api.skillConversationClose(currentConversationId)
      } catch (e) {
        console.error('Failed to close conversation:', e)
      }
    }
    setCurrentConversationId(null)
    setLoadedMessages([])
    setAgentPanelOpen(false)
    setError(null)
  }

  // 渲染思考过程（可折叠、背景色区分）
  const renderThoughts = (thoughts: Thought[], isThinking: boolean) => {
    if (!thoughts || thoughts.length === 0) return null

    // 获取当前正在进行的 action 描述
    const getCurrentAction = (): string => {
      for (let i = thoughts.length - 1; i >= 0; i--) {
        const th = thoughts[i]
        if (th.type === 'tool_use' && th.toolName) {
          if (th.isStreaming || !th.isReady) {
            return `${th.toolName}...`
          }
          return th.toolName
        }
        if (th.type === 'thinking') {
          return t('Thinking...')
        }
      }
      return t('Processing...')
    }

    return (
      <div className="mb-2">
        {/* 折叠的思考过程头部 */}
        <details className="group" open={false}>
          <summary className="flex items-center gap-2 px-2 py-1.5 bg-purple-500/10 hover:bg-purple-500/20 rounded cursor-pointer text-xs select-none">
            <Lightbulb className="w-3.5 h-3.5 text-purple-500" />
            <span className="text-purple-600 dark:text-purple-400 font-medium">
              {t('Thinking Process')}
            </span>
            <span className="text-muted-foreground">
              ({thoughts.length})
            </span>
            {isThinking && (
              <span className="flex items-center gap-1 text-muted-foreground ml-auto">
                <Loader2 className="w-3 h-3 animate-spin" />
                {getCurrentAction()}
              </span>
            )}
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground ml-1 group-open:rotate-180 transition-transform" />
          </summary>

          {/* 展开的思考过程内容 */}
          <div className="mt-1 space-y-1 max-h-60 overflow-y-auto">
            {thoughts.map((thought, idx) => {
              const isError = thought.type === 'error' || thought.isError
              const isSuccess = thought.type === 'tool_result' && !thought.isError
              const isToolUse = thought.type === 'tool_use'
              const isThinking = thought.type === 'thinking'

              // 背景色
              const bgClass = isError
                ? 'bg-red-500/10 border-red-500/30'
                : isSuccess
                  ? 'bg-green-500/10 border-green-500/30'
                  : isToolUse
                    ? 'bg-blue-500/10 border-blue-500/30'
                    : isThinking
                      ? 'bg-purple-500/10 border-purple-500/30'
                      : 'bg-secondary/50 border-border/50'

              // 图标和颜色
              const Icon = isError
                ? AlertTriangle
                : isSuccess
                  ? CheckCircle2
                  : isToolUse
                    ? Wrench
                    : isThinking
                      ? Brain
                      : MessageSquare

              const iconColor = isError
                ? 'text-red-500'
                : isSuccess
                  ? 'text-green-500'
                  : isToolUse
                    ? 'text-blue-500'
                    : isThinking
                      ? 'text-purple-500'
                      : 'text-muted-foreground'

              // 内容
              const content = thought.type === 'tool_use'
                ? thought.toolName
                  ? `${thought.toolName}${thought.toolInput ? `: ${JSON.stringify(thought.toolInput).substring(0, 100)}...` : ''}`
                  : ''
                : thought.content || ''

              return (
                <div
                  key={thought.id || idx}
                  className={`flex items-start gap-2 px-2 py-1.5 rounded border ${bgClass}`}
                >
                  <Icon className={`w-3.5 h-3.5 ${iconColor} shrink-0 mt-0.5`} />
                  <div className="flex-1 min-w-0 text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className={`font-medium ${iconColor} capitalize`}>
                        {thought.type.replace('_', ' ')}
                      </span>
                      {thought.toolName && !isToolUse && (
                        <span className="text-muted-foreground">
                          · {thought.toolName}
                        </span>
                      )}
                    </div>
                    {content && (
                      <pre className="mt-0.5 text-muted-foreground whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed">
                        {content.length > 200 ? content.substring(0, 200) + '...' : content}
                      </pre>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </details>
      </div>
    )
  }

  // 自动滚动到底部
  useEffect(() => {
    // 检查是否刚切换会话
    const justSwitched = prevConversationIdRef.current !== currentConversationId
    prevConversationIdRef.current = currentConversationId

    // 只有以下情况才滚动：
    // 1. 刚切换到新会话（需要滚动一次显示消息）
    // 2. 当前会话正在生成（持续滚动）
    if (justSwitched || isGenerating) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, streamingContent, thoughts, isGenerating, currentConversationId])

  // 加载已安装的技能
  useEffect(() => {
    loadInstalledSkills()
  }, [loadInstalledSkills])

  // 加载会话历史
  useEffect(() => {
    loadConversationHistory()
  }, [loadConversationHistory])

  // 当 generation 完成时刷新文件列表
  useEffect(() => {
    if (!isGenerating && currentConversationId && streamingContent) {
      // 延迟刷新，等待文件写入完成
      const timer = setTimeout(() => {
        refreshSkillFiles()
        loadConversationHistory()
      }, 500)
      return () => clearTimeout(timer)
    }
  }, [isGenerating, currentConversationId, streamingContent])

  return (
    <div className="flex h-full">
      {/* 左侧：配置面板 */}
      <div className="w-80 border-r border-border overflow-y-auto flex flex-col flex-shrink-0">
        {/* 视图切换 Tab */}
        <div className="flex border-b border-border">
          <button
            onClick={() => setLeftPanelView('select')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors ${
              leftPanelView === 'select'
                ? 'text-primary border-b-2 border-primary bg-primary/5'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
            }`}
          >
            <MessageSquare className="w-4 h-4" />
            {t('Select')}
          </button>
          <button
            onClick={() => setLeftPanelView('history')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors ${
              leftPanelView === 'history'
                ? 'text-primary border-b-2 border-primary bg-primary/5'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
            }`}
          >
            <History className="w-4 h-4" />
            {t('History')}
            {/* 生成中指示 */}
            {anySessionGenerating && (
              <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            )}
            {conversationHistory.length > 0 && (
              <span className="text-xs bg-secondary px-1.5 py-0.5 rounded-full">
                {conversationHistory.length}
              </span>
            )}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {leftPanelView === 'select' ? (
            <>
              {/* 对话选择 */}
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
                  <MessageSquare className="w-4 h-4" />
                  {t('Select Conversations')}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {t('Click space to expand, then select conversations')}
                </p>

                <div className="max-h-60 overflow-y-auto border border-border rounded-lg">
                  {spaces.map(space => {
                    const convs = conversationsBySpace.get(space.id) || []
                    if (convs.length === 0) return null

                    const isExpanded = expandedSpaces.has(space.id)
                    const selectionState = getSpaceSelectionState(space.id)

                    return (
                      <div key={space.id} className="border-b border-border last:border-b-0">
                        <div
                          className="flex items-center gap-2 px-2 py-2 bg-secondary/30 hover:bg-secondary/50 cursor-pointer select-none"
                          onClick={() => toggleSpaceExpand(space.id)}
                        >
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          )}
                          <Folder className="w-4 h-4 text-yellow-500 flex-shrink-0" />
                          <span className="text-sm font-medium text-foreground flex-1 truncate">
                            {space.name}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {convs.length}
                          </span>
                        </div>

                        {isExpanded && (
                          <div className="bg-secondary/10">
                            <div
                              className="flex items-center gap-2 px-3 py-1.5 hover:bg-secondary/30 cursor-pointer border-b border-border/50"
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleSpaceConversations(space.id, selectionState !== 'all')
                              }}
                            >
                              {selectionState === 'all' ? (
                                <CheckSquare className="w-3.5 h-3.5 text-primary" />
                              ) : selectionState === 'partial' ? (
                                <div className="w-3.5 h-3.5 border-2 border-primary rounded-sm flex items-center justify-center">
                                  <div className="w-2 h-0.5 bg-primary" />
                                </div>
                              ) : (
                                <Square className="w-3.5 h-3.5 text-muted-foreground" />
                              )}
                              <span className="text-xs text-muted-foreground">
                                {t('Select all')}
                              </span>
                            </div>

                            {convs.map(conv => {
                              const isSelected = selectedConversations.some(c => c.id === conv.id)
                              return (
                                <label
                                  key={conv.id}
                                  className="flex items-center gap-2 px-3 py-1.5 hover:bg-secondary/30 cursor-pointer"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleConversation(conv)}
                                    className="rounded border-border w-3.5 h-3.5"
                                  />
                                  <span className="text-sm text-foreground truncate flex-1">
                                    {conv.title}
                                  </span>
                                </label>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                {selectedConversations.length > 0 && (
                  <p className="text-xs text-primary">
                    {t('{count} conversations selected', { count: selectedConversations.length })}
                  </p>
                )}
              </div>

              <div className="border-t border-border" />

              {/* 技能配置 */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">
                  {t('Skill Configuration')}
                </h3>

                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    {t('Skill requirements (optional)')}
                  </label>
                  <textarea
                    value={skillRequirements}
                    onChange={(e) => setSkillRequirements(e.target.value)}
                    placeholder={t('Describe what kind of skill you want to create...')}
                    rows={3}
                    className="mt-1 w-full px-3 py-1.5 bg-secondary border border-border rounded text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                  />
                </div>
              </div>

              {/* 生成按钮 - 支持同时生成多个技能 */}
              <button
                onClick={handleStartGeneration}
                disabled={selectedConversations.length === 0}
                className={`
                  w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium
                  transition-colors
                  ${selectedConversations.length === 0
                    ? 'bg-primary/50 cursor-not-allowed text-primary-foreground/70'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'}
                `}
              >
                <Sparkles className="w-4 h-4" />
                {t('Generate Skill')}
              </button>

              {agentPanelOpen && (
                <div className="text-xs text-muted-foreground bg-secondary/50 p-2 rounded">
                  {t('AI is generating skill. You can continue the conversation to refine it.')}
                </div>
              )}
            </>
          ) : (
            <>
              {/* 会话历史 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
                    <History className="w-4 h-4" />
                    {t('Conversation History')}
                  </h3>
                  <button
                    onClick={loadConversationHistory}
                    className="p-1 hover:bg-secondary rounded"
                    disabled={loadingHistory}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loadingHistory ? 'animate-spin' : ''}`} />
                  </button>
                </div>

                <div className="space-y-1 max-h-[calc(100vh-280px)] overflow-y-auto">
                  {conversationHistory.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-4">
                      {t('No conversation history')}
                    </p>
                  ) : (
                    conversationHistory.map(conv => {
                      // 检查该会话是否正在生成
                      const convIsGenerating = sessions.get(conv.id)?.isGenerating || false
                      return (
                        <div
                          key={conv.id}
                          onClick={() => loadConversation(conv.id)}
                          className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                            currentConversationId === conv.id
                              ? 'bg-primary/10 border border-primary/30'
                              : 'hover:bg-secondary/50 border border-transparent'
                          }`}
                        >
                          {convIsGenerating ? (
                            <Loader2 className="w-4 h-4 text-green-500 animate-spin flex-shrink-0" />
                          ) : (
                            <MessageSquare className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm text-foreground truncate">{conv.title}</p>
                              {convIsGenerating && (
                                <span className="flex items-center gap-1 text-xs text-green-500">
                                  <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                                  {t('generating')}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {new Date(conv.updatedAt).toLocaleDateString()} · {conv.messageCount} {t('messages')}
                            </p>
                          </div>
                          <button
                            onClick={(e) => handleDeleteConversation(conv.id, e)}
                            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-destructive/20 rounded transition-opacity"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </button>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 中间：Skill 文件预览 */}
      <div className={`flex-1 overflow-hidden flex flex-col transition-all ${agentPanelOpen ? '' : 'mr-0'}`}>
        {!agentPanelOpen ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground p-8">
            <FileCode className="w-16 h-16 mb-4 opacity-30" />
            <h3 className="text-lg font-semibold text-foreground mb-2">
              {t('Skill Generator')}
            </h3>
            <p className="text-sm max-w-md mb-4">
              {t('Select conversations from any space and let AI create a reusable skill for you.')}
            </p>
          </div>
        ) : (
          <div className="flex-1 flex overflow-hidden">
            <div className="w-56 border-r border-border overflow-y-auto flex-shrink-0">
              <div className="p-2 border-b border-border flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  <FolderTree className="w-3 h-3" />
                  {generatedSkillName || 'skill'}/
                </span>
                <button
                  onClick={refreshSkillFiles}
                  className="p-1 hover:bg-secondary rounded"
                  disabled={loadingFiles}
                >
                  <RefreshCw className={`w-3 h-3 ${loadingFiles ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <div className="py-1">
                {skillFiles.length > 0 ? (
                  renderFileTree(skillFiles)
                ) : (
                  <p className="text-xs text-muted-foreground p-2">
                    {t('No files yet...')}
                  </p>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-hidden flex flex-col">
              {selectedFile ? (
                <>
                  <div className="px-4 py-2 border-b border-border text-xs font-medium text-muted-foreground">
                    {selectedFile}
                  </div>
                  <pre className="flex-1 overflow-auto p-4 text-sm font-mono bg-secondary/30">
                    {fileContent || t('Loading...')}
                  </pre>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <p className="text-sm">{t('Select a file to preview')}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 右侧：Agent 对话面板 */}
      {agentPanelOpen && (
        <div
          className="flex flex-col border-l border-border bg-background"
          style={{ width: '25vw', minWidth: '300px', maxWidth: '400px' }}
        >
          {/* 头部 */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <div className={`
                w-2 h-2 rounded-full
                ${isGenerating ? 'bg-green-500 animate-pulse' :
                  error ? 'bg-red-500' : 'bg-gray-400'}
              `} />
              <Bot className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium">skill-creator</span>
            </div>
            <button
              onClick={handleClosePanel}
              className="p-1.5 hover:bg-secondary rounded-lg"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 消息列表 */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 && !isGenerating ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <Bot className="w-10 h-10 mb-2 opacity-30" />
                <p className="text-sm">{t('Starting...')}</p>
              </div>
            ) : (
              <>
                {/* 渲染历史消息 */}
                {messages.map((msg, msgIdx) => {
                  // 判断是否是最后一条 assistant 消息（用于显示流式内容）
                  const isLastAssistantMsg = msg.role === 'assistant' &&
                    msgIdx === messages.length - 1 &&
                    !msg.content // 空内容说明是正在生成的消息

                  // 如果是最后一条 assistant 消息且正在生成，跳过（用下方的流式渲染）
                  if (isLastAssistantMsg && isGenerating) {
                    return null
                  }

                  return (
                    <div
                      key={msg.id}
                      className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`
                          max-w-[85%] px-3 py-2 rounded-lg text-sm
                          ${msg.role === 'user'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-secondary text-foreground'}
                        `}
                      >
                        {/* 历史消息的思考过程（从消息对象读取） */}
                        {msg.role === 'assistant' && msg.thoughts && msg.thoughts.length > 0 && (
                          renderThoughts(msg.thoughts, false)
                        )}
                        <div className="whitespace-pre-wrap break-words">
                          {msg.content}
                        </div>
                      </div>
                    </div>
                  )
                })}

                {/* 渲染当前流式响应 */}
                {(isGenerating || streamingContent || thoughts.length > 0) && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] px-3 py-2 rounded-lg text-sm bg-secondary text-foreground">
                      {/* 思考过程（从 session state 读取） */}
                      {renderThoughts(thoughts, isGenerating && isStreaming)}
                      {/* 流式内容 */}
                      <div className="whitespace-pre-wrap break-words">
                        {streamingContent}
                        {isStreaming && (
                          <span className="inline-block w-1.5 h-3 bg-foreground/50 animate-pulse ml-0.5" />
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* 输入区 */}
          <div className="p-3 border-t border-border">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSendMessage()
                  }
                }}
                placeholder={t('Continue conversation...')}
                className="flex-1 px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                disabled={isGenerating || !currentConversationId}
              />
              <button
                onClick={handleSendMessage}
                disabled={isGenerating || !userInput.trim() || !currentConversationId}
                className={`
                  px-3 py-2 rounded-lg
                  ${isGenerating || !userInput.trim() || !currentConversationId
                    ? 'bg-primary/50 cursor-not-allowed'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'}
                `}
              >
                {isGenerating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </button>
            </div>
            {error && (
              <p className="text-xs text-red-400 mt-2">{error}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
