/**
 * 对话分析服务
 * 从对话历史中提取工具模式、思考过程、用户意图等信息，用于技能生成
 */

import { getConversation, getConversationService, getMessageThoughts } from '../conversation.service'
import type { Message, Thought, ToolCall, Conversation } from '../conversation.service'

/**
 * 用户意图分析结果
 */
export interface UserIntentAnalysis {
  /** 识别到的任务类型 */
  taskType: string
  /** 主要目标描述 */
  primaryGoal: string
  /** 上下文信息列表 */
  contextInfo: string[]
  /** 关键词 */
  keywords: string[]
}

/**
 * 工具使用模式分析结果
 */
export interface ToolPatternAnalysis {
  /** 使用的工具序列 */
  toolSequence: string[]
  /** 常见输入参数模式 */
  commonInputs: Record<string, any[]>
  /** 成功模式描述 */
  successPattern: string
  /** 错误处理策略 */
  errorHandling: string[]
  /** 工具组合策略 */
  toolCombinations: string[][]
  /** 工具调用统计 */
  toolStats: Record<string, {
    count: number
    successCount: number
    errorCount: number
    avgInputSize: number
  }>
}

/**
 * 思考过程分析结果
 */
export interface ReasoningPatternAnalysis {
  /** 关键决策点 */
  decisionPoints: string[]
  /** 分析步骤 */
  analysisSteps: string[]
  /** 最终输出 */
  output: string
  /** 推理模式摘要 */
  reasoningSummary: string
}

/**
 * 可复用性评估
 */
export interface ReusabilityAssessment {
  /** 可复用性得分 (0-1) */
  score: number
  /** 可复用模式列表 */
  patterns: string[]
  /** 依赖条件 */
  dependencies: string[]
  /** 建议 */
  suggestions: string[]
}

/**
 * 完整的对话分析结果
 */
export interface ConversationAnalysisResult {
  /** 用户意图 */
  userIntent: UserIntentAnalysis
  /** 工具使用模式 */
  toolPattern: ToolPatternAnalysis
  /** 思考过程 */
  reasoningPattern: ReasoningPatternAnalysis
  /** 可复用性评估 */
  reusability: ReusabilityAssessment
  /** 原始对话 ID 列表 */
  sourceConversationIds: string[]
  /** 分析时间戳 */
  analyzedAt: string
}

/**
 * 任务类型映射
 */
const TASK_TYPE_PATTERNS: Array<{ patterns: RegExp[]; type: string; keywords: string[] }> = [
  {
    patterns: [/git\s+(commit|add|push|pull|branch|merge|rebase)/i],
    type: 'Git 操作',
    keywords: ['git', 'commit', 'push', 'branch', 'merge']
  },
  {
    patterns: [/(build|compile|打包|构建)/i, /npm\s+run\s+build/i, /yarn\s+build/i],
    type: '构建编译',
    keywords: ['build', 'compile', '打包', 'webpack', 'vite']
  },
  {
    patterns: [/(test|测试|spec|jest|vitest)/i, /npm\s+test/i],
    type: '运行测试',
    keywords: ['test', 'jest', 'vitest', '测试']
  },
  {
    patterns: [/(deploy|发布|上线|部署)/i, /ci\/cd/i],
    type: '部署发布',
    keywords: ['deploy', '发布', '部署', 'docker', 'k8s']
  },
  {
    patterns: [/(review|code\s*review|代码审查)/i],
    type: '代码审查',
    keywords: ['review', '审查', 'pr', 'pull request']
  },
  {
    patterns: [/(refactor|重构|优化|improve)/i],
    type: '代码重构',
    keywords: ['refactor', '重构', '优化']
  },
  {
    patterns: [/(debug|调试|fix|修复|bug)/i, /error/i, /exception/i],
    type: '调试修复',
    keywords: ['debug', 'fix', 'bug', 'error', '修复']
  },
  {
    patterns: [/(create|新建|generate|生成|scaffold)/i],
    type: '创建生成',
    keywords: ['create', 'generate', '新建', '生成']
  },
  {
    patterns: [/(search|查找|搜索|find|grep)/i],
    type: '搜索查询',
    keywords: ['search', 'find', 'grep', '查找']
  },
  {
    patterns: [/(analyze|分析|explain|解释|document)/i],
    type: '分析解释',
    keywords: ['analyze', 'explain', '分析', '解释']
  },
  {
    patterns: [/(style|样式|css|design|ui)/i],
    type: 'UI/样式',
    keywords: ['css', 'style', 'design', 'ui']
  },
  {
    patterns: [/(api|endpoint|rest|graphql)/i],
    type: 'API 开发',
    keywords: ['api', 'endpoint', 'rest', 'graphql']
  },
  {
    patterns: [/(database|数据库|sql|query)/i],
    type: '数据库操作',
    keywords: ['database', 'sql', 'query', '数据库']
  }
]

/**
 * 对话分析器
 */
export class ConversationAnalyzer {
  /**
   * 分析多个对话
   */
  async analyzeConversations(
    spaceId: string,
    conversationIds: string[]
  ): Promise<ConversationAnalysisResult> {
    const conversations: Conversation[] = []
    const conversationService = getConversationService()

    for (const convId of conversationIds) {
      const conv = await conversationService.getConversation(convId, spaceId)
      if (conv) {
        conversations.push(conv)
      }
    }

    if (conversations.length === 0) {
      throw new Error('没有找到有效的对话')
    }

    return this.performAnalysis(conversations, spaceId)
  }

  /**
   * 分析单个对话
   */
  async analyzeConversation(
    spaceId: string,
    conversationId: string
  ): Promise<ConversationAnalysisResult> {
    const conversationService = getConversationService()
    const conv = await conversationService.getConversation(conversationId, spaceId)

    if (!conv) {
      throw new Error('对话不存在')
    }

    return this.performAnalysis([conv], spaceId)
  }

  /**
   * 执行分析
   */
  private async performAnalysis(
    conversations: Conversation[],
    spaceId: string
  ): Promise<ConversationAnalysisResult> {
    // 收集所有消息
    const allMessages: Array<{ msg: Message; convId: string }> = []
    for (const conv of conversations) {
      for (const msg of conv.messages) {
        allMessages.push({ msg, convId: conv.id })
      }
    }

    // 分析用户意图
    const userIntent = this.analyzeUserIntent(allMessages)

    // 分析工具模式
    const toolPattern = await this.analyzeToolPattern(allMessages, spaceId)

    // 分析思考过程
    const reasoningPattern = await this.analyzeReasoningPattern(allMessages, spaceId)

    // 评估可复用性
    const reusability = this.assessReusability(userIntent, toolPattern, reasoningPattern)

    return {
      userIntent,
      toolPattern,
      reasoningPattern,
      reusability,
      sourceConversationIds: conversations.map(c => c.id),
      analyzedAt: new Date().toISOString()
    }
  }

  /**
   * 分析用户意图
   */
  private analyzeUserIntent(messages: Array<{ msg: Message; convId: string }>): UserIntentAnalysis {
    const userMessages = messages.filter(m => m.msg.role === 'user')
    const contents = userMessages.map(m => m.msg.content)

    // 识别任务类型
    let taskType = '通用任务'
    let matchedKeywords: string[] = []

    for (const { patterns, type, keywords } of TASK_TYPE_PATTERNS) {
      const matched = patterns.some(p => contents.some(c => p.test(c)))
      if (matched) {
        taskType = type
        matchedKeywords = keywords
        break
      }
    }

    // 提取主要目标（第一条用户消息的核心内容）
    const primaryGoal = this.extractPrimaryGoal(contents)

    // 提取上下文信息
    const contextInfo = this.extractContextInfo(contents)

    // 提取关键词
    const keywords = this.extractKeywords(contents, matchedKeywords)

    return {
      taskType,
      primaryGoal,
      contextInfo,
      keywords
    }
  }

  /**
   * 提取主要目标
   */
  private extractPrimaryGoal(contents: string[]): string {
    if (contents.length === 0) return ''

    const firstMsg = contents[0]
    // 取第一句话或前100字符
    const sentences = firstMsg.split(/[.!?。！？\n]/).filter(s => s.trim())
    const goal = sentences[0]?.trim() || firstMsg.slice(0, 100)

    return goal.length > 200 ? goal.slice(0, 200) + '...' : goal
  }

  /**
   * 提取上下文信息
   */
  private extractContextInfo(contents: string[]): string[] {
    const contextInfo: string[] = []
    const contextPatterns = [
      /在\s+(.+?)(?:中|里|下)/g,      // "在xxx中"
      /使用\s+(.+?)(?:来|进行|完成)/g, // "使用xxx来"
      /基于\s+(.+?)(?:实现|开发)/g,    // "基于xxx实现"
      /项目\s*[:：]\s*(.+)/g,          // "项目: xxx"
      /目录\s*[:：]\s*(.+)/g,          // "目录: xxx"
    ]

    for (const content of contents) {
      for (const pattern of contextPatterns) {
        const matches = content.matchAll(pattern)
        for (const match of matches) {
          if (match[1] && match[1].length < 100) {
            contextInfo.push(match[1].trim())
          }
        }
      }
    }

    return [...new Set(contextInfo)].slice(0, 5)
  }

  /**
   * 提取关键词
   */
  private extractKeywords(contents: string[], initialKeywords: string[]): string[] {
    const keywords = new Set<string>(initialKeywords)

    // 技术关键词模式
    const techPatterns = [
      /\b(react|vue|angular|typescript|javascript|python|node|rust|go)\b/gi,
      /\b(api|rest|graphql|websocket|http)\b/gi,
      /\b(test|jest|vitest|cypress|playwright)\b/gi,
      /\b(docker|kubernetes|aws|gcp|azure)\b/gi,
      /\b(git|github|gitlab|bitbucket)\b/gi,
      /\b(sql|mongodb|redis|postgres|mysql)\b/gi,
    ]

    for (const content of contents) {
      for (const pattern of techPatterns) {
        const matches = content.matchAll(pattern)
        for (const match of matches) {
          if (match[1]) {
            keywords.add(match[1].toLowerCase())
          }
        }
      }
    }

    return Array.from(keywords).slice(0, 10)
  }

  /**
   * 分析工具使用模式
   */
  private async analyzeToolPattern(
    messages: Array<{ msg: Message; convId: string }>,
    spaceId: string
  ): Promise<ToolPatternAnalysis> {
    const assistantMessages = messages.filter(m => m.msg.role === 'assistant')

    const toolSequence: string[] = []
    const toolCalls: Array<{ name: string; input: any; status: string; output?: string }> = []
    const toolStats: Record<string, { count: number; successCount: number; errorCount: number; totalInputSize: number }> = {}

    for (const { msg, convId } of assistantMessages) {
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          toolSequence.push(tc.name)
          toolCalls.push({
            name: tc.name,
            input: tc.input,
            status: tc.status,
            output: tc.output
          })

          // 统计
          if (!toolStats[tc.name]) {
            toolStats[tc.name] = { count: 0, successCount: 0, errorCount: 0, totalInputSize: 0 }
          }
          toolStats[tc.name].count++
          if (tc.status === 'success') toolStats[tc.name].successCount++
          if (tc.status === 'error') toolStats[tc.name].errorCount++
          toolStats[tc.name].totalInputSize += JSON.stringify(tc.input).length
        }
      }
    }

    // 计算平均输入大小
    const finalToolStats: ToolPatternAnalysis['toolStats'] = {}
    for (const [name, stats] of Object.entries(toolStats)) {
      finalToolStats[name] = {
        count: stats.count,
        successCount: stats.successCount,
        errorCount: stats.errorCount,
        avgInputSize: Math.round(stats.totalInputSize / stats.count)
      }
    }

    // 提取常见输入参数模式
    const commonInputs = this.extractCommonInputs(toolCalls)

    // 生成成功模式描述
    const successPattern = this.generateSuccessPattern(toolSequence, toolStats)

    // 提取错误处理策略
    const errorHandling = this.extractErrorHandling(toolCalls)

    // 提取工具组合策略
    const toolCombinations = this.extractToolCombinations(assistantMessages.map(m => m.msg))

    return {
      toolSequence: [...new Set(toolSequence)],
      commonInputs,
      successPattern,
      errorHandling,
      toolCombinations,
      toolStats: finalToolStats
    }
  }

  /**
   * 提取常见输入参数模式
   */
  private extractCommonInputs(
    toolCalls: Array<{ name: string; input: any }>
  ): Record<string, any[]> {
    const inputsByName: Record<string, any[]> = {}

    for (const tc of toolCalls) {
      if (!inputsByName[tc.name]) {
        inputsByName[tc.name] = []
      }
      inputsByName[tc.name].push(tc.input)
    }

    // 对每个工具，提取共性参数
    const commonInputs: Record<string, any[]> = {}

    for (const [name, inputs] of Object.entries(inputsByName)) {
      if (inputs.length >= 2) {
        // 找出所有输入共有的键
        const keys = Object.keys(inputs[0])
        const commonKeys = keys.filter(key =>
          inputs.every(input => key in input)
        )

        if (commonKeys.length > 0) {
          commonInputs[name] = commonKeys.map(key => ({
            key,
            sample: inputs[0][key]
          }))
        }
      }
    }

    return commonInputs
  }

  /**
   * 生成成功模式描述
   */
  private generateSuccessPattern(
    toolSequence: string[],
    toolStats: Record<string, { count: number; successCount: number; errorCount: number; totalInputSize: number }>
  ): string {
    const uniqueTools = [...new Set(toolSequence)]
    const successRate = uniqueTools.map(tool => {
      const stats = toolStats[tool]
      const rate = stats ? (stats.successCount / stats.count * 100).toFixed(0) : '100'
      return `${tool}(${rate}%)`
    })

    if (toolSequence.length === 0) {
      return '无工具调用'
    }

    // 分析典型的执行顺序
    const sequences: string[][] = []
    let currentSeq: string[] = []

    for (const tool of toolSequence) {
      currentSeq.push(tool)
      if (currentSeq.length >= 3) {
        sequences.push([...currentSeq])
        currentSeq = []
      }
    }
    if (currentSeq.length > 0) {
      sequences.push(currentSeq)
    }

    const typicalFlow = sequences.length > 0
      ? sequences[Math.floor(sequences.length / 2)].join(' → ')
      : uniqueTools.slice(0, 3).join(' → ')

    return `典型流程: ${typicalFlow}\n成功率: ${successRate.join(', ')}`
  }

  /**
   * 提取错误处理策略
   */
  private extractErrorHandling(
    toolCalls: Array<{ name: string; input: any; status: string; output?: string }>
  ): string[] {
    const strategies: string[] = []
    const errorCalls = toolCalls.filter(tc => tc.status === 'error')

    // 分析错误模式
    const errorTypes = new Map<string, number>()
    for (const ec of errorCalls) {
      const errorKey = ec.name
      errorTypes.set(errorKey, (errorTypes.get(errorKey) || 0) + 1)
    }

    for (const [tool, count] of errorTypes) {
      strategies.push(`${tool} 可能出错 (${count}次)，需要错误处理`)
    }

    return strategies
  }

  /**
   * 提取工具组合策略
   */
  private extractToolCombinations(messages: Message[]): string[][] {
    const combinations: string[][] = []

    for (const msg of messages) {
      if (msg.toolCalls && msg.toolCalls.length > 1) {
        const combo = [...new Set(msg.toolCalls.map(tc => tc.name))]
        if (combo.length > 1) {
          combinations.push(combo)
        }
      }
    }

    return combinations.slice(0, 5)
  }

  /**
   * 分析思考过程
   */
  private async analyzeReasoningPattern(
    messages: Array<{ msg: Message; convId: string }>,
    spaceId: string
  ): Promise<ReasoningPatternAnalysis> {
    const decisionPoints: string[] = []
    const analysisSteps: string[] = []
    let output = ''

    for (const { msg, convId } of messages) {
      if (msg.role === 'assistant') {
        // 尝试获取思考过程
        let thoughts: Thought[] = []
        if (msg.thoughts === null) {
          // 思考存储在单独文件中
          thoughts = getMessageThoughts(spaceId, convId, msg.id)
        } else if (Array.isArray(msg.thoughts)) {
          thoughts = msg.thoughts
        }

        for (const thought of thoughts) {
          if (thought.type === 'thinking' && thought.content) {
            // 提取决策点
            const decisions = this.extractDecisions(thought.content)
            decisionPoints.push(...decisions)

            // 提取分析步骤
            const steps = this.extractAnalysisSteps(thought.content)
            analysisSteps.push(...steps)
          }

          if (thought.type === 'text' && thought.content) {
            output = thought.content
          }
        }

        // 如果没有思考，从消息内容提取
        if (thoughts.length === 0 && msg.content) {
          output = msg.content
        }
      }
    }

    // 生成推理摘要
    const reasoningSummary = this.generateReasoningSummary(decisionPoints, analysisSteps)

    return {
      decisionPoints: [...new Set(decisionPoints)].slice(0, 5),
      analysisSteps: [...new Set(analysisSteps)].slice(0, 5),
      output: output.slice(0, 500),
      reasoningSummary
    }
  }

  /**
   * 提取决策点
   */
  private extractDecisions(content: string): string[] {
    const decisions: string[] = []
    const patterns = [
      /(?:决定|选择|采用|使用)\s*[：:]?\s*(.+)/g,
      /(?:因为|由于)\s*(.+?)\s*(?:所以|因此)/g,
      /(?:最佳|推荐|建议)\s*(?:方案|做法)?\s*[：:]?\s*(.+)/g,
    ]

    for (const pattern of patterns) {
      const matches = content.matchAll(pattern)
      for (const match of matches) {
        if (match[1] && match[1].length < 100) {
          decisions.push(match[1].trim())
        }
      }
    }

    return decisions
  }

  /**
   * 提取分析步骤
   */
  private extractAnalysisSteps(content: string): string[] {
    const steps: string[] = []
    const patterns = [
      /(?:首先|第一)\s*[，,]?\s*(.+)/g,
      /(?:然后|接着|其次)\s*[，,]?\s*(.+)/g,
      /(?:最后|最终)\s*[，,]?\s*(.+)/g,
      /(?:步骤|step)\s*\d+\s*[：:]?\s*(.+)/gi,
    ]

    for (const pattern of patterns) {
      const matches = content.matchAll(pattern)
      for (const match of matches) {
        if (match[1] && match[1].length < 100) {
          steps.push(match[1].trim())
        }
      }
    }

    return steps
  }

  /**
   * 生成推理摘要
   */
  private generateReasoningSummary(decisions: string[], steps: string[]): string {
    if (decisions.length === 0 && steps.length === 0) {
      return '未检测到明确的推理模式'
    }

    const parts: string[] = []

    if (steps.length > 0) {
      parts.push(`分析步骤: ${steps.slice(0, 3).join(' → ')}`)
    }

    if (decisions.length > 0) {
      parts.push(`关键决策: ${decisions.slice(0, 2).join('; ')}`)
    }

    return parts.join('\n')
  }

  /**
   * 评估可复用性
   */
  private assessReusability(
    userIntent: UserIntentAnalysis,
    toolPattern: ToolPatternAnalysis,
    reasoningPattern: ReasoningPatternAnalysis
  ): ReusabilityAssessment {
    let score = 0
    const patterns: string[] = []
    const dependencies: string[] = []
    const suggestions: string[] = []

    // 1. 任务类型通用性 (0-0.3)
    const commonTaskTypes = ['Git 操作', '构建编译', '运行测试', '代码审查', '调试修复']
    if (commonTaskTypes.includes(userIntent.taskType)) {
      score += 0.3
      patterns.push(`通用任务类型: ${userIntent.taskType}`)
    } else {
      score += 0.1
    }

    // 2. 工具使用复杂度 (0-0.3)
    const uniqueTools = Object.keys(toolPattern.toolStats)
    if (uniqueTools.length >= 2 && uniqueTools.length <= 5) {
      score += 0.3
      patterns.push(`适中工具复杂度: ${uniqueTools.length} 个工具`)
    } else if (uniqueTools.length > 5) {
      score += 0.15
      suggestions.push('考虑简化工具流程')
    } else if (uniqueTools.length === 1) {
      score += 0.2
      patterns.push('单一工具操作')
    }

    // 3. 成功率 (0-0.2)
    const totalSuccess = Object.values(toolPattern.toolStats)
      .reduce((sum, s) => sum + s.successCount, 0)
    const totalCount = Object.values(toolPattern.toolStats)
      .reduce((sum, s) => sum + s.count, 0)
    const successRate = totalCount > 0 ? totalSuccess / totalCount : 1

    if (successRate >= 0.9) {
      score += 0.2
      patterns.push('高成功率')
    } else if (successRate >= 0.7) {
      score += 0.1
      suggestions.push('可以添加更多错误处理')
    }

    // 4. 推理清晰度 (0-0.2)
    if (reasoningPattern.decisionPoints.length > 0 || reasoningPattern.analysisSteps.length > 0) {
      score += 0.2
      patterns.push('有清晰的推理过程')
    } else {
      score += 0.05
      suggestions.push('建议添加更多上下文说明')
    }

    // 提取依赖
    for (const kw of userIntent.keywords) {
      if (['react', 'vue', 'typescript', 'node', 'python'].includes(kw)) {
        dependencies.push(`需要 ${kw} 环境`)
      }
    }

    // 确保分数在 0-1 范围内
    score = Math.min(1, Math.max(0, score))

    return {
      score,
      patterns,
      dependencies,
      suggestions
    }
  }
}

// 导出单例
export const conversationAnalyzer = new ConversationAnalyzer()
