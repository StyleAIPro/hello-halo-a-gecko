/**
 * SkillGenerator - 技能生成器
 *
 * 从对话历史中学习，AI 辅助生成可复用的技能
 *
 * 布局：
 * - 左侧：对话选择（支持多空间）+ 技能配置
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
  RefreshCw
} from 'lucide-react'
import { api } from '../../api'

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

export function SkillGenerator() {
  const { t } = useTranslation()
  const spaces = useSpaceStore(state => state.spaces)
  const getConversationsBySpace = useChatStore(state => state.getConversations)

  const {
    installedSkills,
    loadInstalledSkills,
    agentSessionId,
    agentStatus,
    agentMessages,
    agentPanelOpen,
    agentError,
    createAgentSession,
    sendAgentMessage,
    closeAgentSession,
    addAgentMessage,
    updateLastAgentMessage,
    setAgentStatus,
    setAgentPanelOpen
  } = useSkillStore()

  // 本地状态
  const [selectedConversations, setSelectedConversations] = useState<ConversationOption[]>([])
  const [skillName, setSkillName] = useState('')
  const [userInput, setUserInput] = useState('')
  const [skillFiles, setSkillFiles] = useState<SkillFileNode[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState('')
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [loadingFiles, setLoadingFiles] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

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

    // 按更新时间排序
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

  // 启动 Agent 会话
  const handleStartGeneration = async () => {
    if (!skillName.trim()) {
      alert(t('Please enter skill name'))
      return
    }

    if (selectedConversations.length === 0) {
      alert(t('Please select at least one conversation'))
      return
    }

    // 打开面板
    setAgentPanelOpen(true)

    // 创建会话
    const success = await createAgentSession(skillName, selectedConversations)
    if (success) {
      // 自动发送初始消息
      const initialMessage = buildInitialMessage(skillName, selectedConversations)
      await sendAgentMessage(initialMessage)
    }
  }

  // 构建初始消息
  const buildInitialMessage = (name: string, convs: ConversationOption[]): string => {
    return `请根据我选择的 ${convs.length} 个对话，创建一个名为 "${name}" 的技能。

对话来源：
${convs.map(c => `- ${c.spaceName}: ${c.title}`).join('\n')}

请分析这些对话的模式，生成 SKILL.yaml 文件到 ~/.agents/skills/${name}/ 目录。`
  }

  // 发送消息
  const handleSendMessage = async () => {
    if (!userInput.trim() || agentStatus === 'running') return

    const message = userInput.trim()
    setUserInput('')
    await sendAgentMessage(message)

    // 刷新文件列表
    refreshSkillFiles()
  }

  // 刷新技能文件
  const refreshSkillFiles = async () => {
    if (!skillName) return

    setLoadingFiles(true)
    try {
      // 检查技能目录是否存在
      const result = await api.skillFiles(skillName)
      if (result.success && result.data) {
        setSkillFiles(result.data as SkillFileNode[])

        // 自动选择 SKILL.yaml
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
    try {
      const result = await api.skillFileContent(skillName, filePath)
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

  // 关闭 Agent 面板
  const handleClosePanel = async () => {
    await closeAgentSession()
    setAgentPanelOpen(false)
  }

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [agentMessages])

  // 注册流式消息监听器
  useEffect(() => {
    // 注册流式消息监听器
    const cleanup = window.halo.onSkillTempMessageChunk((data: { sessionId: string; chunk: any }) => {
      const { agentSessionId, agentMessages, agentStatus } = get()

      // 忽略不属于当前会话的消息
      if (data.sessionId !== agentSessionId) return

      const chunk = data.chunk

      // 处理不同类型的 chunk
      if (chunk.type === 'text' && chunk.content) {
        // 追加文本内容
        set((state) => {
          const messages = [...state.agentMessages]
          if (messages.length > 0) {
            const lastMsg = messages[messages.length - 1]
            if (lastMsg.role === 'assistant') {
              messages[messages.length - 1] = {
                ...lastMsg,
                content: lastMsg.content + chunk.content,
                isStreaming: true
              }
            }
          }
          return { agentMessages: messages, agentStatus: 'running' }
        })
      } else if (chunk.type === 'complete') {
        // 标记流式结束
        set((state) => {
          const messages = [...state.agentMessages]
          if (messages.length > 0) {
            const lastMsg = messages[messages.length - 1]
            if (lastMsg.role === 'assistant') {
              messages[messages.length - 1] = {
                ...lastMsg,
                isStreaming: false
              }
            }
          }
          return { agentStatus: 'complete' }
        })
      } else if (chunk.type === 'error') {
        set({
          agentError: chunk.content || 'Unknown error',
          agentStatus: 'error'
        })
      }
    })

    return () => {
      // 清理监听器
      cleanup()
    }
  }, [agentPanelOpen, skillName])

  return (
    <div className="flex h-full">
      {/* 左侧：配置面板 */}
      <div className="w-80 border-r border-border overflow-y-auto p-4 space-y-4 flex-shrink-0">
        {/* 对话选择 */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
            <MessageSquare className="w-4 h-4" />
            {t('Select Conversations')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t('Select conversations from any space to learn from')}
          </p>

          <div className="max-h-60 overflow-y-auto border border-border rounded-lg">
            {spaces.map(space => {
              const convs = conversationsBySpace.get(space.id) || []
              if (convs.length === 0) return null

              return (
                <div key={space.id} className="border-b border-border last:border-b-0">
                  <div className="px-2 py-1 bg-secondary/50 text-xs font-medium text-muted-foreground">
                    {space.name}
                  </div>
                  {convs.map(conv => (
                    <label
                      key={conv.id}
                      className="flex items-center gap-2 px-2 py-1.5 hover:bg-secondary/30 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedConversations.some(c => c.id === conv.id)}
                        onChange={() => toggleConversation(conv)}
                        className="rounded border-border w-3.5 h-3.5"
                      />
                      <span className="text-sm text-foreground truncate flex-1">
                        {conv.title}
                      </span>
                    </label>
                  ))}
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

        {/* 分隔线 */}
        <div className="border-t border-border" />

        {/* 技能配置 */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">
            {t('Skill Configuration')}
          </h3>

          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {t('Skill Name')} <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={skillName}
              onChange={(e) => setSkillName(e.target.value)}
              placeholder={t('e.g., git-helper')}
              className="mt-1 w-full px-3 py-1.5 bg-secondary border border-border rounded text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        {/* 生成按钮 */}
        <button
          onClick={handleStartGeneration}
          disabled={!skillName.trim() || selectedConversations.length === 0}
          className={`
            w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium
            transition-colors
            ${!skillName.trim() || selectedConversations.length === 0
              ? 'bg-primary/50 cursor-not-allowed text-primary-foreground/70'
              : 'bg-primary text-primary-foreground hover:bg-primary/90'}
          `}
        >
          <Sparkles className="w-4 h-4" />
          {t('Generate Skill')}
        </button>

        {/* 提示 */}
        {agentPanelOpen && (
          <div className="text-xs text-muted-foreground bg-secondary/50 p-2 rounded">
            {t('AI is generating skill. You can continue the conversation to refine it.')}
          </div>
        )}
      </div>

      {/* 中间：Skill 文件预览 */}
      <div className={`flex-1 overflow-hidden flex flex-col transition-all ${agentPanelOpen ? '' : 'mr-0'}`}>
        {!agentPanelOpen ? (
          // 欢迎界面
          <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground p-8">
            <FileCode className="w-16 h-16 mb-4 opacity-30" />
            <h3 className="text-lg font-semibold text-foreground mb-2">
              {t('Skill Generator')}
            </h3>
            <p className="text-sm max-w-md mb-4">
              {t('Select conversations from any space, enter a skill name, and let AI create a reusable skill for you.')}
            </p>
          </div>
        ) : (
          // 文件预览
          <div className="flex-1 flex overflow-hidden">
            {/* 文件树 */}
            <div className="w-56 border-r border-border overflow-y-auto flex-shrink-0">
              <div className="p-2 border-b border-border flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  <FolderTree className="w-3 h-3" />
                  {skillName}/
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

            {/* 文件内容 */}
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

      {/* 右侧：Agent 对话面板（1/4 宽度） */}
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
                ${agentStatus === 'running' ? 'bg-green-500 animate-pulse' :
                  agentStatus === 'error' ? 'bg-red-500' : 'bg-gray-400'}
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
            {agentMessages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <Bot className="w-10 h-10 mb-2 opacity-30" />
                <p className="text-sm">{t('Starting...')}</p>
              </div>
            ) : (
              agentMessages.map(msg => (
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
                    <div className="whitespace-pre-wrap break-words">
                      {msg.content || '...'}
                    </div>
                    {msg.isStreaming && msg.role === 'assistant' && (
                      <span className="inline-block w-1.5 h-3 bg-foreground/50 animate-pulse ml-0.5" />
                    )}
                  </div>
                </div>
              ))
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
                disabled={agentStatus === 'running'}
              />
              <button
                onClick={handleSendMessage}
                disabled={agentStatus === 'running' || !userInput.trim()}
                className={`
                  px-3 py-2 rounded-lg
                  ${agentStatus === 'running' || !userInput.trim()
                    ? 'bg-primary/50 cursor-not-allowed'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'}
                `}
              >
                {agentStatus === 'running' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </button>
            </div>
            {agentError && (
              <p className="text-xs text-red-400 mt-2">{agentError}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
