/**
 * Skill 生成器服务
 * 从对话历史中学习和总结，生成可复用的技能
 */

import { ConversationService } from '../conversation.service';
import { SkillSpec, SkillGenerateOptions, SkillGenerateResult } from '../../shared/skill/skill-types';

/**
 * 对话模式分析结果
 */
interface ConversationPattern {
  /** 常见的任务类型 */
  taskTypes: string[];
  /** 重复使用的命令/工具 */
  commonCommands: string[];
  /** 典型的参数模式 */
  parameterPatterns: string[];
  /** 成功的交互序列 */
  successfulSequences: Array<{
    userInput: string;
    assistantResponse: string;
    toolsUsed: string[];
  }>;
}

/**
 * 生成的技能草稿
 */
interface SkillDraft {
  name: string;
  description: string;
  triggerCommand: string;
  systemPrompt: string;
  examples: string[];
  confidence: number;
}

export class SkillGeneratorService {
  private static instance: SkillGeneratorService;

  private constructor(
    private conversationService: ConversationService
  ) {}

  static getInstance(conversationService?: ConversationService): SkillGeneratorService {
    if (!SkillGeneratorService.instance) {
      if (!conversationService) {
        throw new Error('SkillGeneratorService must be initialized with ConversationService');
      }
      SkillGeneratorService.instance = new SkillGeneratorService(conversationService);
    }
    return SkillGeneratorService.instance;
  }

  /**
   * 从对话历史生成技能
   */
  async generateFromConversation(
    spaceId: string,
    conversationId?: string
  ): Promise<SkillGenerateResult> {
    try {
      // 获取对话历史
      const messages = await this.getConversationMessages(spaceId, conversationId);

      if (messages.length === 0) {
        return {
          success: false,
          error: '没有足够的对话历史来生成技能'
        };
      }

      // 分析对话模式
      const pattern = this.analyzeConversationPattern(messages);

      // 识别可复用的任务模式
      const skillDrafts = this.identifySkillPatterns(pattern);

      if (skillDrafts.length === 0) {
        return {
          success: false,
          error: '未能从对话中识别出可复用的技能模式'
        };
      }

      // 选择最佳匹配
      const bestDraft = skillDrafts.reduce((best, current) =>
        current.confidence > best.confidence ? current : best
      );

      // 构建技能规范
      const skillSpec = this.buildSkillSpec(bestDraft);

      return {
        success: true,
        skill: skillSpec
      };
    } catch (error) {
      console.error('[SkillGenerator] Failed to generate skill:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '生成技能失败'
      };
    }
  }

  /**
   * 根据用户指定的主题生成技能
   */
  async generateFromPrompt(
    options: SkillGenerateOptions
  ): Promise<SkillGenerateResult> {
    try {
      let messages: Array<{
        role: string;
        content: string;
        toolCalls?: any[];
      }> = [];

      // 如果有会话 ID，获取完整对话历史
      if (options.conversationId) {
        messages = await this.getConversationMessages(
          options.spaceId,
          options.conversationId
        );
      }

      // 使用 AI 分析对话并生成技能
      const skillDraft = await this.analyzeAndGenerateSkill(
        options.name,
        options.description,
        messages
      );

      const skillSpec: SkillSpec = {
        name: skillDraft.name,
        description: skillDraft.description,
        type: 'skill',
        system_prompt: skillDraft.systemPrompt,
        trigger_command: skillDraft.triggerCommand,
        version: '1.0',
        author: 'User',
        tags: this.extractTags(skillDraft)
      };

      return {
        success: true,
        skill: skillSpec
      };
    } catch (error) {
      console.error('[SkillGenerator] Failed to generate skill from prompt:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '生成技能失败'
      };
    }
  }

  /**
   * 获取对话消息
   */
  private async getConversationMessages(
    spaceId: string,
    conversationId?: string
  ): Promise<Array<any>> {
    if (conversationId) {
      // 获取特定会话的消息
      const conversation = await this.conversationService.getConversation(conversationId, spaceId);
      return conversation?.messages || [];
    } else {
      // 获取空间下最近的所有会话消息
      const conversations = await this.conversationService.getSpaceConversations(spaceId);
      const allMessages: any[] = [];

      for (const conv of conversations.slice(0, 5)) { // 最近 5 个会话
        allMessages.push(...(conv.messages || []));
      }

      return allMessages;
    }
  }

  /**
   * 分析对话模式
   */
  private analyzeConversationPattern(
    messages: Array<any>
  ): ConversationPattern {
    const pattern: ConversationPattern = {
      taskTypes: [],
      commonCommands: [],
      parameterPatterns: [],
      successfulSequences: []
    };

    // 分析用户请求类型
    const taskTypeCount = new Map<string, number>();

    for (let i = 0; i < messages.length - 1; i += 2) {
      const userMsg = messages[i];
      const assistantMsg = messages[i + 1];

      if (!userMsg || !assistantMsg) continue;

      // 识别任务类型
      const taskType = this.identifyTaskType(userMsg.content);
      if (taskType) {
        taskTypeCount.set(taskType, (taskTypeCount.get(taskType) || 0) + 1);
      }

      // 记录成功的交互序列
      if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
        pattern.successfulSequences.push({
          userInput: userMsg.content,
          assistantResponse: assistantMsg.content,
          toolsUsed: assistantMsg.toolCalls.map((tc: any) => tc.name || tc.type)
        });
      }
    }

    // 提取常见的任务类型
    pattern.taskTypes = Array.from(taskTypeCount.entries())
      .filter(([_, count]) => count >= 2)
      .map(([type]) => type);

    return pattern;
  }

  /**
   * 识别任务类型
   */
  private identifyTaskType(content: string): string | null {
    const patterns: Array<{ regex: RegExp; type: string }> = [
      { regex: /git\s+(commit|add|push|pull)/i, type: 'Git 操作' },
      { regex: /(build|compile|打包)/i, type: '构建编译' },
      { regex: /(test|测试|run tests)/i, type: '运行测试' },
      { regex: /(deploy|发布|上线)/i, type: '部署发布' },
      { regex: /(review|code review|代码审查)/i, type: '代码审查' },
      { regex: /(refactor|重构|优化)/i, type: '代码重构' },
      { regex: /(debug|调试|fix|修复)/i, type: '调试修复' },
      { regex: /(create|新建|generate|生成)/i, type: '创建生成' },
      { regex: /(search|查找|搜索)/i, type: '搜索查询' },
      { regex: /(analyze|分析|explain|解释)/i, type: '分析解释' }
    ];

    for (const { regex, type } of patterns) {
      if (regex.test(content)) {
        return type;
      }
    }

    return null;
  }

  /**
   * 识别技能模式
   */
  private identifySkillPatterns(pattern: ConversationPattern): SkillDraft[] {
    const drafts: SkillDraft[] = [];

    // 基于任务类型生成技能草稿
    for (const taskType of pattern.taskTypes) {
      const relatedSequences = pattern.successfulSequences.filter(seq =>
        seq.userInput.toLowerCase().includes(taskType.toLowerCase())
      );

      if (relatedSequences.length > 0) {
        const draft = this.createSkillDraftFromSequences(taskType, relatedSequences);
        drafts.push(draft);
      }
    }

    // 基于工具使用模式生成技能
    const toolUsageCount = new Map<string, number>();
    for (const seq of pattern.successfulSequences) {
      for (const tool of seq.toolsUsed) {
        toolUsageCount.set(tool, (toolUsageCount.get(tool) || 0) + 1);
      }
    }

    // 为频繁使用的工具组合创建技能
    const frequentTools = Array.from(toolUsageCount.entries())
      .filter(([_, count]) => count >= 3);

    if (frequentTools.length > 0) {
      drafts.push(this.createToolBasedSkillDraft(frequentTools));
    }

    return drafts;
  }

  /**
   * 从交互序列创建技能草稿
   */
  private createSkillDraftFromSequences(
    taskType: string,
    sequences: Array<{ userInput: string; assistantResponse: string; toolsUsed: string[] }>
  ): SkillDraft {
    const examples = sequences.slice(0, 3).map(seq => seq.userInput);

    // 生成系统提示
    const systemPrompt = this.generateSystemPrompt(taskType, sequences[0]);

    // 生成触发命令
    const triggerCommand = `/${this.taskTypeToCommand(taskType)}`;

    return {
      name: taskType,
      description: `自动执行${taskType}相关任务`,
      triggerCommand: triggerCommand,
      systemPrompt: systemPrompt,
      examples,
      confidence: sequences.length * 0.3 // 基于出现频率的置信度
    };
  }

  /**
   * 从工具使用创建技能草稿
   */
  private createToolBasedSkillDraft(
    frequentTools: Array<[string, number]>
  ): SkillDraft {
    const toolNames = frequentTools.map(([tool]) => tool).join(', ');
    const mainTool = frequentTools[0][0];

    return {
      name: `${mainTool}助手`,
      description: `熟练使用 ${toolNames} 等工具`,
      triggerCommand: `/${mainTool.toLowerCase()}-assistant`,
      systemPrompt: `你是一个专门使用 ${toolNames} 的助手。根据用户的请求，选择合适的工具来完成任务。`,
      examples: [`请使用 ${mainTool} 来完成...`],
      confidence: frequentTools[0][1] * 0.2
    };
  }

  /**
   * 生成系统提示
   */
  private generateSystemPrompt(
    taskType: string,
    exampleSequence: { userInput: string; assistantResponse: string; toolsUsed: string[] }
  ): string {
    const toolsDescription = exampleSequence.toolsUsed.join('、');

    return `你是一个专门处理${taskType}的助手。

## 能力
- 熟练使用：${toolsDescription}
- 理解${taskType}相关的用户请求
- 提供准确、高效的解决方案

## 工作流程
1. 理解用户的具体需求
2. 选择合适的工具或方法
3. 执行操作并验证结果
4. 向用户报告完成情况

## 注意事项
- 在执行可能改变系统状态的操作前，先确认用户的意图
- 遇到错误时，提供清晰的错误信息和解决建议`;
  }

  /**
   * 将任务类型转换为命令
   */
  private taskTypeToCommand(taskType: string): string {
    const mapping: Record<string, string> = {
      'Git 操作': 'git-helper',
      '构建编译': 'build',
      '运行测试': 'test',
      '部署发布': 'deploy',
      '代码审查': 'review',
      '代码重构': 'refactor',
      '调试修复': 'debug',
      '创建生成': 'create',
      '搜索查询': 'search',
      '分析解释': 'analyze'
    };

    return mapping[taskType] || taskType.toLowerCase().replace(/\s+/g, '-');
  }

  /**
   * 分析并生成技能（使用 AI）
   */
  private async analyzeAndGenerateSkill(
    name: string,
    description: string,
    messages: Array<any>
  ): Promise<SkillDraft> {
    // 这里可以调用 Claude SDK 来分析对话并生成技能
    // 目前返回一个基础版本

    const triggerCommand = `/${name.toLowerCase().replace(/\s+/g, '-')}`;

    return {
      name,
      description,
      triggerCommand,
      systemPrompt: this.generateGenericSystemPrompt(name, description),
      examples: this.extractExampleRequests(messages),
      confidence: 0.8
    };
  }

  /**
   * 生成通用系统提示
   */
  private generateGenericSystemPrompt(name: string, description: string): string {
    return `你是一个${name}助手。

## 目标
${description}

## 能力
- 理解用户关于${name}的请求
- 提供专业、准确的帮助
- 遵循最佳实践

## 响应风格
- 清晰、简洁
- 提供可执行的步骤或代码
- 解释关键决策的原因`;
  }

  /**
   * 从消息中提取示例请求
   */
  private extractExampleRequests(messages: Array<any>): string[] {
    return messages
      .filter(msg => msg.role === 'user')
      .slice(0, 3)
      .map(msg => msg.content);
  }

  /**
   * 提取标签
   */
  private extractTags(draft: SkillDraft): string[] {
    const tags = new Set<string>();

    // 从名称提取
    draft.name.split(/\s+/).forEach(word => {
      if (word.length > 2) tags.add(word.toLowerCase());
    });

    // 从描述提取关键词
    const keywords = draft.description.match(/[\u4e00-\u9fa5]{2,}|[a-zA-Z]{3,}/g) || [];
    keywords.slice(0, 5).forEach(kw => tags.add(kw.toLowerCase()));

    return Array.from(tags);
  }
}
