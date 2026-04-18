/**
 * 技能生成器会话服务
 *
 * 使用真正的技能空间 (aico-bot-skill-creator) 进行会话管理，
 * 复用现有的 conversation.service 持久化能力，
 * 实现会话持久化和完整的对话能力。
 *
 * 关键：复用主对话框的 IPC 事件系统 (agent:message, agent:thought 等)，
 * 这样前端可以使用相同的 chat.store 来处理流式输出。
 */

import { v4 as uuidv4 } from 'uuid';
import { getConfig, getAgentsSkillsDir } from '../config.service';
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';
import {
  getHeadlessElectronPath,
  getApiCredentials,
  sendToRenderer,
  setMainWindow as setAgentMainWindow,
} from '../agent/helpers';
import { getMainWindow } from '../window.service';
import { resolveCredentialsForSdk, buildBaseSdkOptions } from '../agent/sdk-config';
import { getOrCreateSkillSpace, getSkillSpaceId } from '../space.service';
import {
  createConversation,
  getConversation,
  listConversations,
  addMessage as addMessageToStorage,
  updateConversation,
  deleteConversation,
  type Conversation,
  type ConversationMeta,
  type Message,
} from '../conversation.service';
import {
  closeV2Session,
  createSessionState,
  registerActiveSession,
  unregisterActiveSession,
} from '../agent/session-manager';
import { processStream, type StreamResult } from '../agent/stream-processor';
import type { Thought } from '../agent/types';

// ============================================
// Types
// ============================================

export interface SkillConversationOptions {
  title?: string;
  initialPrompt?: string;
  /** 关联的技能 ID */
  relatedSkillId?: string;
}

export interface SkillConversationSession {
  conversationId: string;
  spaceId: string;
  status: 'idle' | 'running' | 'complete' | 'error';
}

// ============================================
// Constants
// ============================================

const SKILL_SPACE_ID = getSkillSpaceId();

// 活跃的 SDK 会话和流
const activeSdkSessions = new Map<string, any>();
const activeStreams = new Map<string, AbortController>();

// ============================================
// Conversation Management
// ============================================

/**
 * 获取或创建技能空间
 */
export function ensureSkillSpace() {
  return getOrCreateSkillSpace();
}

/**
 * 列出技能生成器的所有会话
 * @param relatedSkillId 可选，按技能 ID 过滤会话
 */
export function listSkillConversations(relatedSkillId?: string): ConversationMeta[] {
  // Ensure the skill space exists before listing conversations.
  // If the space was deleted (e.g. manual cleanup), this will recreate it.
  ensureSkillSpace();

  if (relatedSkillId !== undefined) {
    return listConversations(SKILL_SPACE_ID, { relatedSkillId });
  }
  return listConversations(SKILL_SPACE_ID);
}

/**
 * 获取单个会话详情
 */
export function getSkillConversation(conversationId: string): Conversation | null {
  ensureSkillSpace();
  return getConversation(SKILL_SPACE_ID, conversationId);
}

/**
 * 创建新的技能生成器会话
 * @param title 会话标题
 * @param relatedSkillId 可选，关联的技能 ID
 */
export function createSkillConversation(title?: string, relatedSkillId?: string): Conversation {
  // 确保技能空间存在
  ensureSkillSpace();

  // 创建持久化会话，关联 skillId
  const conversation = createConversation(SKILL_SPACE_ID, title || 'Skill Generator', {
    relatedSkillId,
  });

  console.log(
    `[SkillConv] Created conversation: ${conversation.id}${relatedSkillId ? ` for skill: ${relatedSkillId}` : ''}`,
  );

  return conversation;
}

/**
 * 删除技能生成器会话
 */
export function deleteSkillConversation(conversationId: string): boolean {
  try {
    // 先关闭活跃的会话
    closeSkillSession(conversationId);

    // 删除会话数据
    deleteConversation(SKILL_SPACE_ID, conversationId);

    console.log(`[SkillConv] Deleted conversation: ${conversationId}`);
    return true;
  } catch (error) {
    console.error(`[SkillConv] Failed to delete conversation:`, error);
    return false;
  }
}

// ============================================
// Message Handling
// ============================================

/**
 * 发送消息到技能生成器会话
 *
 * 复用主对话框的流式处理逻辑，发送相同的 IPC 事件。
 */
export async function sendSkillMessage(
  conversationId: string,
  message: string,
  metadata?: {
    selectedConversations?: Array<{
      id: string;
      title: string;
      spaceName: string;
      messageCount: number;
      formattedContent?: string;
    }>;
    sourceWebpages?: Array<{
      url: string;
      title?: string;
      content?: string;
    }>;
  },
): Promise<{ success: boolean; error?: string }> {
  try {
    // 设置主窗口引用，以便 sendToRenderer 可以工作
    const mainWindow = getMainWindow();
    if (mainWindow) {
      setAgentMainWindow(mainWindow);
    }

    const config = getConfig();
    const skillsDir = getAgentsSkillsDir();
    const electronPath = getHeadlessElectronPath();

    // 获取或创建会话
    let conversation = getConversation(SKILL_SPACE_ID, conversationId);
    if (!conversation) {
      conversation = createSkillConversation();
      conversationId = conversation.id;
    }

    // 添加用户消息到持久化存储（包含 metadata 用于折叠卡片显示）
    addMessageToStorage(SKILL_SPACE_ID, conversationId, {
      role: 'user',
      content: message,
      metadata: metadata
        ? {
            selectedConversations: metadata.selectedConversations,
            sourceWebpages: metadata.sourceWebpages,
          }
        : undefined,
    });

    // 获取 API 凭证
    const credentials = await getApiCredentials(config);
    const resolvedCredentials = await resolveCredentialsForSdk(credentials);

    // 创建 AbortController
    const abortController = new AbortController();
    activeStreams.set(conversationId, abortController);

    // 创建 session state (用于存储 thoughts)
    const sessionState = createSessionState(SKILL_SPACE_ID, conversationId, abortController);
    registerActiveSession(conversationId, sessionState);

    // 构建 SDK 选项
    const sdkOptions = buildBaseSdkOptions({
      credentials: resolvedCredentials,
      workDir: skillsDir,
      electronPath,
      spaceId: SKILL_SPACE_ID,
      conversationId,
      abortController,
      stderrHandler: (data: string) => {
        console.error(`[SkillConv][${conversationId}] stderr:`, data);
      },
      mcpServers: null,
      maxTurns: config.agent?.maxTurns,
      contextWindow: resolvedCredentials.contextWindow,
    });

    // 配置 skill-creator 技能
    (sdkOptions as any).skill = 'skill-creator';
    (sdkOptions as any).permissionMode = 'bypassPermissions';
    (sdkOptions as any).includePartialMessages = true;

    // 如果会话有 sessionId，使用它来恢复
    if (conversation.sessionId) {
      (sdkOptions as any).resume = conversation.sessionId;
    }

    console.log(`[SkillConv] Creating V2 session for conversation: ${conversationId}`);

    // 创建 V2 SDK Session
    const sdkSession = (await unstable_v2_createSession(sdkOptions as any)) as any;
    activeSdkSessions.set(conversationId, sdkSession);

    console.log(`[SkillConv] Session created, using processStream...`);

    const t0 = Date.now();

    // 使用 processStream 处理流式响应
    // 这会发送标准的 IPC 事件 (agent:message, agent:thought 等)
    const result = await processStream({
      v2Session: sdkSession,
      sessionState,
      spaceId: SKILL_SPACE_ID,
      conversationId,
      messageContent: message,
      displayModel: credentials.model || 'claude-3-5-sonnet-20241022',
      abortController,
      t0,
      callbacks: {
        onComplete: async (streamResult: StreamResult) => {
          console.log(
            `[SkillConv] Stream completed, finalContent length: ${streamResult.finalContent.length}`,
          );

          // 更新会话的 sessionId（用于下次恢复）
          if (
            streamResult.capturedSessionId &&
            streamResult.capturedSessionId !== conversation.sessionId
          ) {
            updateConversation(SKILL_SPACE_ID, conversationId, {
              sessionId: streamResult.capturedSessionId,
            });
          }

          // 添加 assistant 消息到持久化存储
          if (streamResult.finalContent) {
            addMessageToStorage(SKILL_SPACE_ID, conversationId, {
              role: 'assistant',
              content: streamResult.finalContent,
              thoughts: streamResult.thoughts,
            });
          }
        },
      },
    });

    // 清理活跃流
    activeStreams.delete(conversationId);

    // 检查是否有错误
    if (
      result.isInterrupted &&
      !result.wasAborted &&
      !result.hasErrorThought &&
      !result.finalContent
    ) {
      return {
        success: false,
        error: 'Stream was interrupted',
      };
    }

    if (result.hasErrorThought && result.errorThought) {
      return {
        success: false,
        error: result.errorThought.content,
      };
    }

    return { success: true };
  } catch (error) {
    console.error(`[SkillConv] Failed to send message:`, error);
    activeStreams.delete(conversationId);

    // 发送错误事件
    sendToRenderer('agent:error', SKILL_SPACE_ID, conversationId, {
      type: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * 停止正在进行的消息生成
 */
export function stopSkillGeneration(conversationId: string): void {
  const controller = activeStreams.get(conversationId);
  if (controller) {
    controller.abort();
    activeStreams.delete(conversationId);
    console.log(`[SkillConv] Stopped generation for: ${conversationId}`);
  }
}

/**
 * 关闭技能会话（从 session-manager 中移除）
 */
export function closeSkillSession(conversationId: string): void {
  try {
    // 关闭 SDK session
    const sdkSession = activeSdkSessions.get(conversationId);
    if (sdkSession) {
      try {
        sdkSession.close();
      } catch (e) {
        // Ignore close errors
      }
      activeSdkSessions.delete(conversationId);
    }

    // 也尝试从 session-manager 关闭（如果存在）
    try {
      closeV2Session(conversationId);
    } catch (e) {
      // Ignore
    }

    activeStreams.delete(conversationId);
    console.log(`[SkillConv] Closed session: ${conversationId}`);
  } catch (error) {
    console.error(`[SkillConv] Failed to close session:`, error);
  }
}
