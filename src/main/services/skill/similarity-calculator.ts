/**
 * 相似度计算器
 * 计算对话分析与现有技能的相似度，用于决定是创建新技能还是优化现有技能
 */

import type { InstalledSkill } from '../../shared/skill/skill-types'
import type { ConversationAnalysisResult } from './conversation-analyzer'

/**
 * 相似技能匹配结果
 */
export interface SimilarSkill {
  /** 匹配的技能 */
  skill: InstalledSkill
  /** 相似度分数 (0-1) */
  similarity: number
  /** 匹配原因 */
  matchReasons: string[]
  /** 建议改进 */
  suggestedImprovements: string[]
}

/**
 * 任务类型关键词映射
 */
const TASK_TYPE_KEYWORDS: Record<string, string[]> = {
  'Git 操作': ['git', 'commit', 'push', 'branch', 'merge', 'rebase', 'pull', 'checkout'],
  '构建编译': ['build', 'compile', 'webpack', 'vite', 'rollup', 'esbuild', '打包', '构建'],
  '运行测试': ['test', 'jest', 'vitest', 'mocha', 'cypress', 'playwright', '测试', 'spec'],
  '部署发布': ['deploy', 'release', 'publish', 'docker', 'kubernetes', 'k8s', 'ci', 'cd'],
  '代码审查': ['review', 'reviewer', 'pr', 'pull request', '审查', '代码检查'],
  '代码重构': ['refactor', 'restructure', '优化', '重构', 'improve'],
  '调试修复': ['debug', 'fix', 'bug', 'error', 'exception', '调试', '修复'],
  '创建生成': ['create', 'generate', 'scaffold', 'init', '新建', '生成'],
  '搜索查询': ['search', 'find', 'grep', 'query', '查找', '搜索'],
  '分析解释': ['analyze', 'explain', 'document', '分析', '解释', '文档'],
  'UI/样式': ['css', 'style', 'design', 'ui', 'component', '样式', '组件'],
  'API 开发': ['api', 'endpoint', 'rest', 'graphql', 'route', 'controller'],
  '数据库操作': ['sql', 'query', 'database', 'db', 'migration', '数据库']
}

/**
 * 工具关键词映射
 */
const TOOL_KEYWORDS: Record<string, string[]> = {
  'Read': ['read', 'file', '读取', '文件', '查看', 'cat'],
  'Edit': ['edit', 'modify', '修改', '编辑', 'update', '更改'],
  'Write': ['write', 'create', '写入', '创建', '新建', 'save'],
  'Bash': ['bash', 'shell', 'command', '执行', '命令', 'run', 'script'],
  'Grep': ['grep', 'search', '搜索', '查找', 'find', 'pattern'],
  'Glob': ['glob', 'pattern', 'match', '文件匹配', 'find files'],
  'Task': ['task', 'agent', '子任务', 'delegate', 'parallel']
}

/**
 * 计算相似度
 */
export function calculateSimilarity(
  analysis: ConversationAnalysisResult,
  skill: InstalledSkill
): SimilarSkill {
  const scores: number[] = []
  const reasons: string[] = []
  const improvements: string[] = []

  // 1. 任务类型相似度 (权重: 0.3)
  const taskScore = compareTaskType(analysis.userIntent.taskType, skill)
  if (taskScore > 0.5) {
    scores.push(taskScore * 0.3)
    reasons.push(`任务类型匹配: ${analysis.userIntent.taskType}`)
  }

  // 2. 工具使用模式相似度 (权重: 0.3)
  const toolScore = compareToolPattern(analysis.toolPattern, skill.spec.system_prompt)
  if (toolScore > 0.5) {
    scores.push(toolScore * 0.3)
    reasons.push(`工具模式匹配`)
  }

  // 3. 语义相似度 (权重: 0.2)
  const semanticScore = compareSemantics(
    analysis.userIntent.primaryGoal,
    skill.spec.description
  )
  if (semanticScore > 0.5) {
    scores.push(semanticScore * 0.2)
    reasons.push(`目标语义匹配`)
  }

  // 4. 关键词匹配 (权重: 0.2)
  const keywordScore = compareKeywords(
    analysis.userIntent.keywords,
    skill.spec.tags || []
  )
  if (keywordScore > 0.3) {
    scores.push(keywordScore * 0.2)
    reasons.push(`关键词匹配`)
  }

  // 计算综合分数
  const totalScore = scores.reduce((a, b) => a + b, 0)

  // 生成改进建议
  if (totalScore > 0.5 && totalScore < 0.9) {
    improvements.push(...generateImprovements(analysis, skill))
  }

  return {
    skill,
    similarity: totalScore,
    matchReasons: reasons,
    suggestedImprovements: improvements
  }
}

/**
 * 对比任务类型
 */
function compareTaskType(taskType: string, skill: InstalledSkill): number {
  const keywords = TASK_TYPE_KEYWORDS[taskType] || []
  if (keywords.length === 0) return 0

  const specLower = `${skill.spec.name} ${skill.spec.description} ${skill.spec.system_prompt}`.toLowerCase()

  let matchCount = 0
  for (const keyword of keywords) {
    if (specLower.includes(keyword.toLowerCase())) {
      matchCount++
    }
  }

  return matchCount / keywords.length
}

/**
 * 对比工具使用模式
 */
function compareToolPattern(toolPattern: any, systemPrompt: string): number {
  if (!toolPattern?.toolSequence || toolPattern.toolSequence.length === 0) {
    return 0
  }

  const promptLower = systemPrompt.toLowerCase()
  const tools = toolPattern.toolSequence

  let matchCount = 0
  for (const tool of tools) {
    const keywords = TOOL_KEYWORDS[tool] || [tool.toLowerCase()]
    if (keywords.some(k => promptLower.includes(k.toLowerCase()))) {
      matchCount++
    }
  }

  return matchCount / tools.length
}

/**
 * 对比语义相似度 (简单版本，基于词重叠)
 */
function compareSemantics(goal: string, description: string): number {
  const goalWords = tokenize(goal)
  const descWords = tokenize(description)

  if (goalWords.length === 0 || descWords.length === 0) return 0

  const intersection = goalWords.filter(w => descWords.includes(w))
  const union = [...new Set([...goalWords, ...descWords])]

  // Jaccard 相似度
  return intersection.length / union.length
}

/**
 * 对比关键词
 */
function compareKeywords(analysisKeywords: string[], skillTags: string[]): number {
  if (analysisKeywords.length === 0 || skillTags.length === 0) return 0

  const normalizedAnalysis = analysisKeywords.map(k => k.toLowerCase())
  const normalizedTags = skillTags.map(t => t.toLowerCase())

  const intersection = normalizedAnalysis.filter(k => normalizedTags.includes(k))

  return intersection.length / Math.max(normalizedAnalysis.length, normalizedTags.length)
}

/**
 * 分词
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-\_.,;:!?'"()\[\]{}]+/)
    .filter(word => word.length > 2)  // 过滤太短的词
}

/**
 * 生成改进建议
 */
function generateImprovements(
  analysis: ConversationAnalysisResult,
  skill: InstalledSkill
): string[] {
  const improvements: string[] = []

  // 检查是否有新的工具使用模式
  const existingTools = extractToolsFromPrompt(skill.spec.system_prompt)
  const newTools = analysis.toolPattern.toolSequence.filter(
    (t: string) => !existingTools.includes(t)
  )

  if (newTools.length > 0) {
    improvements.push(`添加对新工具的支持: ${newTools.join(', ')}`)
  }

  // 检查是否有新的关键词
  const existingKeywords = skill.spec.tags || []
  const newKeywords = analysis.userIntent.keywords.filter(
    k => !existingKeywords.includes(k)
  )

  if (newKeywords.length > 0) {
    improvements.push(`添加新标签: ${newKeywords.slice(0, 5).join(', ')}`)
  }

  // 检查可复用性建议
  if (analysis.reusability.suggestions.length > 0) {
    improvements.push(...analysis.reusability.suggestions.slice(0, 2))
  }

  return improvements
}

/**
 * 从 system_prompt 中提取提到的工具
 */
function extractToolsFromPrompt(prompt: string): string[] {
  const tools: string[] = []
  const toolNames = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'Task']

  const promptLower = prompt.toLowerCase()
  for (const tool of toolNames) {
    if (promptLower.includes(tool.toLowerCase())) {
      tools.push(tool)
    }
  }

  return tools
}

/**
 * 查找相似技能
 */
export function findSimilarSkills(
  analysis: ConversationAnalysisResult,
  installedSkills: InstalledSkill[],
  threshold: number = 0.5
): SimilarSkill[] {
  const results: SimilarSkill[] = []

  for (const skill of installedSkills) {
    const result = calculateSimilarity(analysis, skill)
    if (result.similarity >= threshold) {
      results.push(result)
    }
  }

  // 按相似度降序排序
  return results.sort((a, b) => b.similarity - a.similarity)
}
