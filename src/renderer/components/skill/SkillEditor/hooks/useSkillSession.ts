/**
 * useSkillSession - Skill 编辑器会话管理 Hook
 *
 * 功能：
 * 1. 按 skillId 隔离会话
 * 2. 管理会话的创建、加载、切换
 * 3. 同步会话状态与 chat store
 */

import { useState, useCallback, useEffect } from 'react';
import { useChatStore } from '../../../../stores/chat.store';
import { api } from '../../../../api';
import type { Message } from '../../../../types';

export interface SkillConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

interface UseSkillSessionOptions {
  /** 当前关联的技能 ID（用于按技能隔离会话） */
  skillId?: string | null;
  /** 会话加载完成回调 */
  onSessionLoaded?: (conversationId: string, messages: Message[]) => void;
  /** 会话创建完成回调 */
  onSessionCreated?: (conversationId: string) => void;
  /** 错误回调 */
  onError?: (error: string) => void;
}

interface UseSkillSessionReturn {
  /** 当前会话 ID */
  currentConversationId: string | null;
  /** 当前会话的消息列表 */
  messages: Message[];
  /** 所有会话历史 */
  conversationHistory: SkillConversationMeta[];
  /** 是否正在加载 */
  isLoading: boolean;
  /** 是否正在加载历史 */
  isLoadingHistory: boolean;
  /** 错误信息 */
  error: string | null;
  /** 是否正在生成 */
  isGenerating: boolean;
  /** 是否正在流式输出 */
  isStreaming: boolean;
  /** 流式内容 */
  streamingContent: string;
  /** 思考过程 */
  thoughts: any[];

  /** 创建新会话 */
  createSession: (title?: string) => Promise<string | null>;
  /** 加载会话 */
  loadSession: (conversationId: string) => Promise<void>;
  /** 发送消息 */
  sendMessage: (content: string) => Promise<void>;
  /** 删除会话 */
  deleteSession: (conversationId: string) => Promise<void>;
  /** 关闭当前会话 */
  closeSession: () => Promise<void>;
  /** 刷新会话历史 */
  refreshHistory: () => Promise<void>;
  /** 清除当前会话 */
  clearCurrentSession: () => void;
  /** 清除错误 */
  clearError: () => void;
}

export function useSkillSession(options: UseSkillSessionOptions = {}): UseSkillSessionReturn {
  const { skillId, onSessionLoaded, onSessionCreated, onError } = options;

  // 从 chat store 读取状态
  const sessions = useChatStore((state) => state.sessions);
  const conversationCache = useChatStore((state) => state.conversationCache);

  // 本地状态
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [loadedMessages, setLoadedMessages] = useState<Message[]>([]);
  const [conversationHistory, setConversationHistory] = useState<SkillConversationMeta[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 获取当前会话的 session state
  const sessionState = currentConversationId ? sessions.get(currentConversationId) : null;

  // 获取当前会话的消息
  const conversation = currentConversationId ? conversationCache.get(currentConversationId) : null;
  const messages = conversation?.messages || loadedMessages;

  // 派生状态
  const isGenerating = sessionState?.isGenerating || false;
  const isStreaming = sessionState?.isStreaming || false;
  const streamingContent = sessionState?.streamingContent || '';
  const thoughts = sessionState?.thoughts || [];

  // 初始化会话状态
  const initSessionState = useCallback((conversationId: string) => {
    useChatStore.setState((state) => {
      const newSessions = new Map(state.sessions);
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
        pendingQuestion: null,
      });
      return { sessions: newSessions };
    });
  }, []);

  // 加载会话历史
  const refreshHistory = useCallback(async () => {
    setIsLoadingHistory(true);
    try {
      const result = await api.skillConversationList();
      if (result.success && result.data) {
        setConversationHistory(result.data as SkillConversationMeta[]);
      }
    } catch (e) {
      console.error('Failed to load conversation history:', e);
    } finally {
      setIsLoadingHistory(false);
    }
  }, []);

  // 加载会话
  const loadSession = useCallback(
    async (conversationId: string) => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await api.skillConversationGet(conversationId);
        if (result.success && result.data) {
          const conversation = result.data as any;
          setLoadedMessages(conversation.messages || []);
          setCurrentConversationId(conversationId);
          onSessionLoaded?.(conversationId, conversation.messages || []);
        } else {
          setError(result.error || 'Failed to load conversation');
          onError?.(result.error || 'Failed to load conversation');
        }
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : 'Failed to load conversation';
        setError(errorMsg);
        onError?.(errorMsg);
      } finally {
        setIsLoading(false);
      }
    },
    [onSessionLoaded, onError],
  );

  // 创建新会话
  const createSession = useCallback(
    async (title?: string): Promise<string | null> => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await api.skillConversationCreate(title);
        if (result.success && result.data) {
          const newConversationId = (result.data as any).id;
          setCurrentConversationId(newConversationId);
          setLoadedMessages([]);
          refreshHistory();
          onSessionCreated?.(newConversationId);
          return newConversationId;
        } else {
          setError(result.error || 'Failed to create conversation');
          onError?.(result.error || 'Failed to create conversation');
          return null;
        }
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : 'Failed to create conversation';
        setError(errorMsg);
        onError?.(errorMsg);
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [refreshHistory, onSessionCreated, onError],
  );

  // 发送消息
  const sendMessage = useCallback(
    async (content: string): Promise<void> => {
      if (!currentConversationId) return;

      const userMsg: Message = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      };

      setLoadedMessages((prev) => [...prev, userMsg]);
      initSessionState(currentConversationId);

      try {
        const result = await api.skillConversationSend(currentConversationId, content);
        if (!result.success) {
          setError(result.error || 'Failed to send message');
          onError?.(result.error || 'Failed to send message');
        } else {
          // 重新加载会话以获取最新消息
          loadSession(currentConversationId);
        }
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : 'Failed to send message';
        setError(errorMsg);
        onError?.(errorMsg);
      }
    },
    [currentConversationId, initSessionState, loadSession, onError],
  );

  // 删除会话
  const deleteSession = useCallback(
    async (conversationId: string): Promise<void> => {
      try {
        await api.skillConversationDelete(conversationId);
        setConversationHistory((prev) => prev.filter((c) => c.id !== conversationId));
        if (currentConversationId === conversationId) {
          setCurrentConversationId(null);
          setLoadedMessages([]);
        }
      } catch (e) {
        console.error('Failed to delete conversation:', e);
      }
    },
    [currentConversationId],
  );

  // 关闭当前会话
  const closeSession = useCallback(async (): Promise<void> => {
    if (currentConversationId) {
      try {
        await api.skillConversationClose(currentConversationId);
      } catch (e) {
        console.error('Failed to close conversation:', e);
      }
    }
    setCurrentConversationId(null);
    setLoadedMessages([]);
    setError(null);
  }, [currentConversationId]);

  // 清除当前会话
  const clearCurrentSession = useCallback(() => {
    setCurrentConversationId(null);
    setLoadedMessages([]);
    setError(null);
  }, []);

  // 清除错误
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // 初始加载历史
  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  return {
    currentConversationId,
    messages,
    conversationHistory,
    isLoading,
    isLoadingHistory,
    error,
    isGenerating,
    isStreaming,
    streamingContent,
    thoughts,
    createSession,
    loadSession,
    sendMessage,
    deleteSession,
    closeSession,
    refreshHistory,
    clearCurrentSession,
    clearError,
  };
}
