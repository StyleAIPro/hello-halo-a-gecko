/**
 * Skill Controller
 * 处理 Skill 相关的业务逻辑
 */

import { SkillManager } from '../services/skill/skill-manager';
import { SkillMarketService } from '../services/skill/skill-market-service';
import { SkillGeneratorService } from '../services/skill/skill-generator';
import { ConversationService } from '../services/conversation.service';
import { SkillGenerateOptions } from '../../shared/skill/skill-types';

let skillManager: SkillManager;
let skillMarket: SkillMarketService;
let skillGenerator: SkillGeneratorService;
let initPromise: Promise<void> | null = null;

export function initialize(conversationService: ConversationService): void {
  skillManager = SkillManager.getInstance();
  skillMarket = SkillMarketService.getInstance();
  skillGenerator = SkillGeneratorService.getInstance(conversationService);

  initPromise = Promise.all([
    skillManager.initialize(),
    skillMarket.initialize()
  ]).then(() => {
    // explicitly return void
  }).catch(err => {
    console.error('[SkillController] Failed to initialize:', err);
  });
}

async function ensureInitialized(): Promise<void> {
  if (initPromise) {
    await initPromise;
  }
}

export async function listInstalledSkills() {
  try {
    await ensureInitialized();
    const skills = skillManager.getInstalledSkills();
    return { success: true, data: skills };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to list skills' };
  }
}

export async function getSkillDetail(skillId: string) {
  try {
    await ensureInitialized();
    const skill = skillManager.getSkill(skillId);
    if (!skill) {
      return { success: false, error: 'Skill not found' };
    }
    return { success: true, data: skill };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get skill detail' };
  }
}

export async function installSkillFromMarket(
  skillId: string,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void
): Promise<{ success: boolean; error?: string }> {
  try {
    await ensureInitialized();

    console.log('[SkillController] Installing skill from market:', skillId);

    // 1. 获取技能安装信息
    const downloadResult = await skillMarket.downloadSkill(skillId);

    if (!downloadResult.success || !downloadResult.githubRepo || !downloadResult.skillName) {
      const error = downloadResult.error || 'Failed to download skill';
      onOutput?.({ type: 'error', content: error });
      return { success: false, error };
    }

    console.log('[SkillController] Skill info:', {
      githubRepo: downloadResult.githubRepo,
      skillName: downloadResult.skillName
    });

    // 2. 使用 npx 命令安装技能
    // 命令格式：npx skills add <github-repo> --skill <skill-name> -y --global
    // 默认安装到 ~/.agents/skills/
    const { spawn } = await import('child_process');

    const command = 'npx';
    const args = [
      '--yes',
      'skills',
      'add',
      `https://github.com/${downloadResult.githubRepo}`,
      '--skill',
      downloadResult.skillName,
      '-y',
      '--global'
    ];

    const fullCommand = `${command} ${args.join(' ')}`;
    console.log('[SkillController] Executing command:', fullCommand);
    onOutput?.({ type: 'stdout', content: `$ ${fullCommand}\n` });

    return new Promise((resolve) => {
      const childProcess = spawn(command, args, {
        env: { ...process.env },
        timeout: 120000 // 2 分钟超时
      });

      let hasError = false;

      childProcess.stdout?.on('data', (data: Buffer) => {
        const content = data.toString();
        console.log('[SkillController] stdout:', content);
        onOutput?.({ type: 'stdout', content });
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        const content = data.toString();
        // 忽略 npm 警告
        if (!content.toLowerCase().includes('npm warn')) {
          console.warn('[SkillController] stderr:', content);
          onOutput?.({ type: 'stderr', content });
        }
      });

      childProcess.on('error', (error: Error) => {
        console.error('[SkillController] Process error:', error);
        hasError = true;
        onOutput?.({ type: 'error', content: error.message });
        resolve({ success: false, error: error.message });
      });

      childProcess.on('close', async (code: number) => {
        console.log('[SkillController] Process exited with code:', code);

        if (code === 0 && !hasError) {
          onOutput?.({ type: 'complete', content: '\n✓ Skill installed successfully!\n' });

          // 3. 刷新技能列表
          try {
            await skillManager.refresh();
            console.log('[SkillController] Skill installed successfully:', skillId);
          } catch (refreshError) {
            console.warn('[SkillController] Failed to refresh skills:', refreshError);
          }

          resolve({ success: true });
        } else {
          const error = `Installation failed with exit code ${code}`;
          onOutput?.({ type: 'error', content: `\n✗ ${error}\n` });
          resolve({ success: false, error });
        }
      });
    });
  } catch (error) {
    console.error('[SkillController] Failed to install skill:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to install skill';
    onOutput?.({ type: 'error', content: errorMessage });
    return { success: false, error: errorMessage };
  }
}

export async function installSkillFromYaml(yamlContent: string): Promise<{ success: boolean; skillId?: string; error?: string }> {
  try {
    const skillId = await skillManager.importSkill(yamlContent);
    return { success: true, skillId };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to install skill' };
  }
}

export async function uninstallSkill(skillId: string) {
  try {
    const result = await skillManager.uninstallSkill(skillId);
    return { success: result, error: result ? undefined : 'Failed to uninstall skill' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to uninstall skill' };
  }
}

export async function toggleSkill(skillId: string, enabled: boolean) {
  try {
    const result = await skillManager.toggleSkill(skillId, enabled);
    return { success: result, error: result ? undefined : 'Failed to toggle skill' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to toggle skill' };
  }
}

export async function exportSkill(skillId: string) {
  try {
    const yamlContent = await skillManager.exportSkill(skillId);
    if (!yamlContent) {
      return { success: false, error: 'Skill not found' };
    }
    return { success: true, data: yamlContent };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to export skill' };
  }
}

export async function generateSkillFromConversation(spaceId: string, conversationId?: string) {
  try {
    const result = await skillGenerator.generateFromConversation(spaceId, conversationId);
    return result;
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to generate skill' };
  }
}

export async function generateSkillFromPrompt(options: SkillGenerateOptions) {
  try {
    const result = await skillGenerator.generateFromPrompt(options);
    return result;
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to generate skill' };
  }
}

// Market functions
export async function listMarketSkills(page?: number, pageSize?: number) {
  try {
    console.log('[SkillController] listMarketSkills called:', { page, pageSize });
    const result = await skillMarket.getSkills(page, pageSize);
    console.log('[SkillController] listMarketSkills result:', {
      skillsCount: result.skills.length,
      total: result.total,
      hasMore: result.hasMore
    });
    return { success: true, data: result };
  } catch (error) {
    console.error('[SkillController] listMarketSkills error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch market skills' };
  }
}

export async function searchMarketSkills(query: string, page?: number, pageSize?: number) {
  try {
    const result = await skillMarket.searchSkills(query, page, pageSize);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to search skills' };
  }
}

export async function resetMarketCache(): Promise<{ success: boolean }> {
  skillMarket.resetCache();
  return { success: true };
}

// Market source management functions
export async function getMarketSources() {
  try {
    await ensureInitialized();
    const sources = skillMarket.getSources();
    return { success: true, data: sources };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get market sources' };
  }
}

export async function addMarketSource(source: { name: string; url: string; repos?: string[]; description?: string }) {
  try {
    await ensureInitialized();
    const newSource = await skillMarket.addSource(source);
    return { success: true, data: newSource };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to add market source' };
  }
}

export async function removeMarketSource(sourceId: string) {
  try {
    await ensureInitialized();
    const result = await skillMarket.removeSource(sourceId);
    return { success: result, error: result ? undefined : 'Failed to remove market source (only custom sources can be removed)' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to remove market source' };
  }
}

export async function toggleMarketSource(sourceId: string, enabled: boolean) {
  try {
    await ensureInitialized();
    await skillMarket.toggleSource(sourceId, enabled);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to toggle market source' };
  }
}

export async function setActiveMarketSource(sourceId: string) {
  try {
    await ensureInitialized();
    await skillMarket.setActiveSource(sourceId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to set active market source' };
  }
}

export async function getMarketSkillDetail(skillId: string) {
  try {
    const skill = await skillMarket.getSkillDetail(skillId);
    if (!skill) {
      return { success: false, error: 'Skill not found' };
    }
    return { success: true, data: skill };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get skill detail' };
  }
}

// Config functions
export async function getSkillConfig() {
  try {
    const config = skillManager.getConfig();
    return { success: true, data: config };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get skill config' };
  }
}

export async function updateSkillConfig(config: Partial<Record<string, unknown>>) {
  try {
    await skillManager.updateConfig(config);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to update skill config' };
  }
}

export async function refreshSkills() {
  try {
    await ensureInitialized();
    await skillManager.refresh();
    const skills = skillManager.getInstalledSkills();
    return { success: true, data: skills };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to refresh skills' };
  }
}

export async function getSkillFiles(skillId: string) {
  try {
    await ensureInitialized();
    const files = await skillManager.getSkillFiles(skillId);
    return { success: true, data: files };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get skill files' };
  }
}

export async function getSkillFileContent(skillId: string, filePath: string) {
  try {
    await ensureInitialized();
    const content = await skillManager.getSkillFileContent(skillId, filePath);
    if (content === null) {
      return { success: false, error: 'File not found or cannot be read' };
    }
    return { success: true, data: content };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get file content' };
  }
}

// ============================================
// Skill Generator & Temp Agent Session
// ============================================

import { conversationAnalyzer } from '../services/skill/conversation-analyzer';
import {
  createTempAgentSession as createSdkTempSession,
  sendTempAgentMessage,
  closeTempAgentSession as closeSdkTempSession,
  getTempSessionStatus
} from '../services/skill/temp-agent-session';
import { findSimilarSkills } from '../services/skill/similarity-calculator';

// ============================================
// Skill Conversation Service (持久化会话)
// ============================================

import * as skillConversationService from '../services/skill/skill-conversation.service';

/**
 * 列出技能生成器的所有会话
 */
export async function listSkillConversations() {
  try {
    const conversations = skillConversationService.listSkillConversations();
    return { success: true, data: conversations };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list skill conversations'
    };
  }
}

/**
 * 获取技能生成器会话详情
 */
export async function getSkillConversation(conversationId: string) {
  try {
    const conversation = skillConversationService.getSkillConversation(conversationId);
    if (!conversation) {
      return { success: false, error: 'Conversation not found' };
    }
    return { success: true, data: conversation };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get skill conversation'
    };
  }
}

/**
 * 创建新的技能生成器会话
 */
export async function createSkillConversation(title?: string) {
  try {
    const conversation = skillConversationService.createSkillConversation(title);
    return { success: true, data: conversation };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create skill conversation'
    };
  }
}

/**
 * 删除技能生成器会话
 */
export async function deleteSkillConversation(conversationId: string) {
  try {
    const result = skillConversationService.deleteSkillConversation(conversationId);
    return { success: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete skill conversation'
    };
  }
}

/**
 * 发送消息到技能生成器会话
 *
 * 注意：流式事件通过标准的 agent:message, agent:thought 等 IPC 通道发送，
 * 与主对话框使用相同的事件系统。前端通过 chat.store 处理这些事件。
 */
export async function sendSkillConversationMessage(
  conversationId: string,
  message: string
) {
  try {
    // 服务现在直接使用 sendToRenderer 发送标准的 IPC 事件
    const result = await skillConversationService.sendSkillMessage(conversationId, message);
    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send message'
    };
  }
}

/**
 * 停止技能生成器消息生成
 */
export async function stopSkillGeneration(conversationId: string) {
  try {
    skillConversationService.stopSkillGeneration(conversationId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to stop generation'
    };
  }
}

/**
 * 关闭技能生成器会话
 */
export async function closeSkillConversation(conversationId: string) {
  try {
    skillConversationService.closeSkillSession(conversationId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to close skill conversation'
    };
  }
}

/**
 * 分析对话，提取技能模式
 */
export async function analyzeConversations(
  spaceId: string,
  conversationIds: string[]
) {
  try {
    // 分析对话
    const analysisResult = await conversationAnalyzer.analyzeConversations(spaceId, conversationIds);

    // 获取已安装的技能
    await ensureInitialized();
    const installedSkills = skillManager.getInstalledSkills();

    // 查找相似技能
    const similarSkills = findSimilarSkills(analysisResult, installedSkills, 0.5);

    // 生成建议
    const suggestedName = generateSkillName(analysisResult);
    const suggestedCommand = generateTriggerCommand(analysisResult);

    return {
      success: true,
      data: {
        analysisResult: {
          userIntent: {
            taskType: analysisResult.userIntent.taskType,
            primaryGoal: analysisResult.userIntent.primaryGoal,
            keywords: analysisResult.userIntent.keywords
          },
          toolPattern: {
            toolSequence: analysisResult.toolPattern.toolSequence,
            successPattern: analysisResult.toolPattern.successPattern
          },
          reusability: {
            score: analysisResult.reusability.score,
            patterns: analysisResult.reusability.patterns
          }
        },
        similarSkills: similarSkills.map(s => ({
          skill: s.skill,
          similarity: s.similarity,
          matchReasons: s.matchReasons,
          suggestedImprovements: s.suggestedImprovements
        })),
        suggestedName,
        suggestedCommand
      }
    };
  } catch (error) {
    console.error('[SkillController] Failed to analyze conversations:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze conversations'
    };
  }
}

/**
 * 创建临时 Agent 会话
 * 支持直接传入 context 或通过对话分析生成 context
 * @param onChunk 可选的流式回调,用于创建会话后自动发送初始消息
 */
export async function createTempAgentSession(
  options: {
    skillName: string;
    conversationIds?: string[];
    spaceIds?: string[];
    context?: {
      conversationAnalysis?: any;
      similarSkills?: any[];
      mode?: 'create' | 'optimize';
      initialPrompt?: string;
    };
    onChunk?: (chunk: StreamChunk) => void
  }
) {
  try {
    // 如果直接提供了 context，直接使用
    if (options.context) {
      console.log('[SkillController] Using provided context:', {
        hasInitialPrompt: !!options.context.initialPrompt,
        mode: options.context.mode
      });

      const result = await createSdkTempSession({
        skillName: options.skillName,
        context: {
          conversationAnalysis: options.context.conversationAnalysis || null,
          similarSkills: options.context.similarSkills || [],
          mode: options.context.mode || 'create',
          initialPrompt: options.context.initialPrompt
        },
        onChunk: options.onChunk
      });
      return result;
    }

    // 如果提供了对话ID，分析这些对话（可选）
    let context: any = { mode: 'create' };

    if (options.conversationIds && options.conversationIds.length > 0 && options.spaceIds) {
      try {
        // 合并所有对话的分析结果
        const analysisResults = [];
        for (let i = 0; i < options.conversationIds.length; i++) {
          const convId = options.conversationIds[i];
          const spaceId = options.spaceIds[i];
          if (spaceId) {
            const result = await conversationAnalyzer.analyzeConversation(spaceId, convId);
            analysisResults.push(result);
          }
        }

        // 合并分析结果
        if (analysisResults.length > 0) {
          const mergedAnalysis = mergeAnalysisResults(analysisResults);

          // 查找相似技能
          const installedSkills = skillManager.getInstalledSkills();
          const similarSkills = findSimilarSkills(mergedAnalysis, installedSkills, 0.5);

          context = {
            mode: similarSkills.length > 0 ? 'optimize' : 'create',
            conversationAnalysis: mergedAnalysis,
            similarSkills
          };
        }
      } catch (error) {
        console.warn('[SkillController] Failed to analyze conversations, creating without analysis:', error);
      }
    }

    const result = await createSdkTempSession({
      skillName: options.skillName,
      context,
      onChunk: options.onChunk
    });
    return result;
  } catch (error) {
    console.error('[SkillController] Failed to create temp session:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create temp session'
    };
  }
}

/**
 * 合并多个分析结果
 */
function mergeAnalysisResults(results: any[]): any {
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];

  // 合并用户意图
  const mergedIntent = {
    taskType: results[0].userIntent.taskType,
    primaryGoal: results.map(r => r.userIntent.primaryGoal).filter(Boolean).join('; '),
    contextInfo: [...new Set(results.flatMap(r => r.userIntent.contextInfo || []))],
    keywords: [...new Set(results.flatMap(r => r.userIntent.keywords || []))]
  };

  // 合并工具模式
  const mergedToolPattern = {
    toolSequence: [...new Set(results.flatMap(r => r.toolPattern.toolSequence || []))],
    successPattern: results.map(r => r.toolPattern.successPattern).join('\n'),
    toolStats: results.reduce((acc, r) => ({ ...acc, ...r.toolPattern.toolStats }), {})
  };

  // 合并可复用性
  const mergedReusability = {
    score: Math.max(...results.map(r => r.reusability.score)),
    patterns: [...new Set(results.flatMap(r => r.reusability.patterns || []))],
    suggestions: [...new Set(results.flatMap(r => r.reusability.suggestions || []))]
  };

  return {
    userIntent: mergedIntent,
    toolPattern: mergedToolPattern,
    reusability: mergedReusability,
    sourceConversationIds: results.flatMap(r => r.sourceConversationIds)
  };
}

/**
 * 发送消息到临时会话
 */
export async function sendTempAgentMessageWithCallback(
  sessionId: string,
  message: string,
  onChunk: (chunk: any) => void
) {
  try {
    const result = await sendTempAgentMessage(sessionId, message, onChunk);
    return result;
  } catch (error) {
    console.error('[SkillController] Failed to send temp message:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send message'
    };
  }
}

/**
 * 发送消息到临时会话（IPC 调用）
 * 使用 sendTempAgentMessageWithCallback 并提供 chunk 回调
 */
export async function sendTempAgentMessage(
  sessionId: string,
  message: string,
  onChunk?: (chunk: any) => void
) {
  return sendTempAgentMessageWithCallback(sessionId, message, onChunk || (() => {}));
}

/**
 * 关闭临时会话
 */
export async function closeTempAgentSession(sessionId: string) {
  try {
    const result = await closeSdkTempSession(sessionId);
    return result;
  } catch (error) {
    console.error('[SkillController] Failed to close temp session:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to close temp session'
    };
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * 生成技能名称
 */
function generateSkillName(analysis: any): string {
  const taskType = analysis.userIntent.taskType;
  const keywords = analysis.userIntent.keywords;

  // 基于任务类型生成名称
  const typeToName: Record<string, string> = {
    'Git 操作': 'git-helper',
    '构建编译': 'build-optimizer',
    '运行测试': 'test-runner',
    '部署发布': 'deploy-helper',
    '代码审查': 'code-reviewer',
    '代码重构': 'refactor-assistant',
    '调试修复': 'debug-helper',
    '创建生成': 'code-generator',
    '搜索查询': 'search-assistant',
    '分析解释': 'analyzer',
    'UI/样式': 'ui-styler',
    'API 开发': 'api-builder',
    '数据库操作': 'db-assistant'
  };

  let baseName = typeToName[taskType] || 'custom-skill';

  // 如果有特定的关键词，可以添加后缀
  if (keywords.length > 0) {
    const firstKeyword = keywords[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (firstKeyword && firstKeyword !== baseName.split('-')[0]) {
      baseName = `${firstKeyword}-helper`;
    }
  }

  return baseName;
}

/**
 * 生成触发命令
 */
function generateTriggerCommand(analysis: any): string {
  const name = generateSkillName(analysis);
  return `/${name.replace(/-/g, '')}`;
}
