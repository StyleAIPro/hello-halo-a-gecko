/**
 * SkillEditorPage - AI 辅助 Skill 文件编辑器
 *
 * 功能：
 * 1. 新建 Skill：从各空间选择对话历史，AI 生成新技能
 * 2. 编辑现有 Skill：打开已安装技能进行 AI 辅助编辑
 * 3. 会话按 skill 文件夹隔离
 * 4. 中间 CodeMirror 编辑器支持流式显示
 * 5. 选中文本后让 AI 做局部修改
 *
 * 布局：
 * - 左侧：模式切换（新建/编辑）+ 技能选择器/对话选择器
 * - 中间：CodeMirror 编辑器 + 工具栏
 * - 右侧：对话面板
 */

import { useState, useEffect, useCallback, useRef, useMemo, forwardRef } from 'react';
import { useSkillStore } from '../../../stores/skill/skill.store';
import { useSpaceStore } from '../../../stores/space.store';
import { useChatStore } from '../../../stores/chat.store';
import { useTranslation } from '../../../i18n';
import {
  Plus,
  Save,
  MessageSquare,
  Loader2,
  FileCode,
  GripVertical,
  Sparkles,
  X,
  Bot,
  Send,
  ChevronDown,
  ChevronRight,
  Folder,
  File,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Lightbulb,
  Brain,
  Wrench,
  History,
  Trash2,
  CheckSquare,
  Square,
  FolderTree,
  Globe,
  Link,
} from 'lucide-react';
import { api } from '../../../api';
import type { Thought, Message } from '../../../types';
import type { InstalledSkill, SkillFileNode } from '../../../../shared/skill/skill-types';
import type { CodeMirrorEditorRef } from '../../canvas/viewers/CodeMirrorEditor';
import { CodeMirrorEditor } from '../../canvas/viewers/CodeMirrorEditor';
import { getSkillSpaceId } from '../../../services/skill-space';
import { useConfirm } from '../../ui/ConfirmDialog';

// ============================================
// Types
// ============================================

interface SelectionState {
  text: string;
  from: number;
  to: number;
  lineFrom: number;
  lineTo: number;
  menuX?: number;
  menuY?: number;
}

interface ConversationOption {
  id: string;
  title: string;
  spaceId: string;
  spaceName: string;
  updatedAt: string;
  /** 完整的消息内容（加载后填充） */
  messages?: Message[];
  /** 是否正在加载消息 */
  isLoadingMessages?: boolean;
}

interface SkillConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** 关联的技能 ID */
  relatedSkillId?: string;
}

type LeftPanelView = 'select' | 'edit' | 'history';

// 网页条目状态
interface WebPageEntry {
  id: string;
  url: string;
  status: 'pending' | 'loading' | 'loaded' | 'error';
  title?: string;
  content?: string;
  error?: string;
}

// 技能空间的 ID
const SKILL_SPACE_ID = getSkillSpaceId();

// ============================================
// Main Component
// ============================================

export function SkillEditorPage() {
  const { t } = useTranslation();
  const { confirm: confirmDialog, alert: alertDialog, ConfirmDialogElement } = useConfirm();
  const spaces = useSpaceStore((state) => state.spaces);
  const defaultSpace = useSpaceStore((state) => state.defaultSpace);
  const { installedSkills, loadInstalledSkills, agentPanelOpen, setAgentPanelOpen } =
    useSkillStore();

  // 从 chat store 读取会话状态（spaceStates 订阅用于响应式更新对话列表）
  const sessions = useChatStore((state) => state.sessions);
  const conversationCache = useChatStore((state) => state.conversationCache);
  const spaceStates = useChatStore((state) => state.spaceStates);
  const loadConversations = useChatStore((state) => state.loadConversations);

  // 左侧面板视图
  const [leftPanelView, setLeftPanelView] = useState<LeftPanelView>('select');

  // === 新建 Skill 模式状态 ===
  const [selectedConversations, setSelectedConversations] = useState<ConversationOption[]>([]);
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set());
  const [skillRequirements, setSkillRequirements] = useState('');
  const [generatedSkillName, setGeneratedSkillName] = useState('');

  // === 编辑模式状态 ===
  const [currentSkillId, setCurrentSkillId] = useState<string | null>(null);
  const [currentSkill, setCurrentSkill] = useState<InstalledSkill | null>(null);
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // 文件树
  const [skillFiles, setSkillFiles] = useState<SkillFileNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loadingFiles, setLoadingFiles] = useState(false);

  // === 会话状态 ===
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [conversationHistory, setConversationHistory] = useState<SkillConversationMeta[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadedMessages, setLoadedMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

  // === 文本选择状态 ===
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [showSelectionMenu, setShowSelectionMenu] = useState(false);
  const [selectionMenuPosition, setSelectionMenuPosition] = useState({ x: 0, y: 0 });

  // === UI 状态 ===
  const [rightPanelWidth, setRightPanelWidth] = useState(350);
  const [isResizingPanel, setIsResizingPanel] = useState(false);
  const [userInput, setUserInput] = useState('');

  // === 网页 URL 输入（用于创建技能）===
  const [webPageEntries, setWebPageEntries] = useState<WebPageEntry[]>([]);
  const [newUrlInput, setNewUrlInput] = useState('');

  // Refs
  const editorRef = useRef<CodeMirrorEditorRef>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevConversationIdRef = useRef<string | null>(null);
  const panelResizeRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  // 记住待替换的选中范围（用于AI修改选中内容后自动应用）
  const pendingReplaceRangeRef = useRef<{ from: number; to: number } | null>(null);
  // 追踪上一次处理的 thoughts 长度，用于检测新的工具调用
  const lastProcessedThoughtsLengthRef = useRef(0);

  // ============================================
  // 计算属性
  // ============================================

  // 获取当前会话的 session state
  const sessionState = currentConversationId ? sessions.get(currentConversationId) : null;

  // 是否正在生成
  const isGenerating = sessionState?.isGenerating || false;

  // 流式内容
  const streamingContent = sessionState?.streamingContent || '';
  const isStreaming = sessionState?.isStreaming || false;
  const thoughts = sessionState?.thoughts || [];

  // 获取当前会话的消息
  // 优先使用 loadedMessages（本地状态），因为它包含用户刚发送但可能还没同步到缓存的消息
  // 只有在 loadedMessages 为空时才使用缓存的会话数据
  const conversation = currentConversationId ? conversationCache.get(currentConversationId) : null;
  const cachedMessages = conversation?.messages || [];
  // 如果 loadedMessages 有内容，优先使用它（避免用户消息被旧缓存覆盖）
  // 如果正在生成中，也优先使用 loadedMessages（因为新消息刚被添加）
  const messages = loadedMessages.length > 0 || isGenerating ? loadedMessages : cachedMessages;

  // 检查是否有任何会话正在生成
  const anySessionGenerating = useMemo(() => {
    for (const [, state] of sessions) {
      if (state.isGenerating) return true;
    }
    return false;
  }, [sessions]);

  // 合并默认空间和用户空间（defaultSpace 不在 spaces 数组中）
  const allSpaces = useMemo(() => {
    const result = defaultSpace ? [defaultSpace] : [];
    return result.concat(spaces);
  }, [defaultSpace, spaces]);

  // 获取所有空间的对话（响应式：依赖 spaceStates 变化自动更新）
  const allConversations = useMemo(() => {
    const result: ConversationOption[] = [];
    for (const space of allSpaces) {
      const convs = spaceStates.get(space.id)?.conversations || [];
      for (const conv of convs) {
        result.push({
          id: conv.id,
          title: conv.title || t('Untitled'),
          spaceId: space.id,
          spaceName: space.name,
          updatedAt: conv.updatedAt,
        });
      }
    }
    return result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [allSpaces, spaceStates, t]);

  // 按空间分组
  const conversationsBySpace = useMemo(() => {
    const grouped = new Map<string, ConversationOption[]>();
    for (const conv of allConversations) {
      const existing = grouped.get(conv.spaceId) || [];
      existing.push(conv);
      grouped.set(conv.spaceId, existing);
    }
    return grouped;
  }, [allConversations]);

  // 按名称排序的技能列表
  const sortedSkills = useMemo(() => {
    return [...installedSkills].sort((a, b) => a.spec.name.localeCompare(b.spec.name));
  }, [installedSkills]);

  // 是否可以生成技能（至少选择会话、网页或填写要求之一）
  const canGenerate = useMemo(() => {
    const hasConversations = selectedConversations.length > 0;
    const hasLoadedPages = webPageEntries.some((e) => e.status === 'loaded');
    const hasRequirements = skillRequirements.trim().length > 0;
    return hasConversations || hasLoadedPages || hasRequirements;
  }, [selectedConversations, webPageEntries, skillRequirements]);

  // ============================================
  // 初始化
  // ============================================

  // 技能列表初始化
  useEffect(() => {
    loadInstalledSkills();
    loadConversationHistoryFn();
  }, [loadInstalledSkills]);

  // 独立加载所有空间的对话列表（含默认空间）
  // 不依赖 spaceStates 快照，直接按空间 ID 强制加载
  useEffect(() => {
    if (allSpaces.length === 0) return;
    for (const space of allSpaces) {
      loadConversations(space.id);
    }
  }, [allSpaces, loadConversations]);

  // ============================================
  // 模式切换时清理状态
  // ============================================

  useEffect(() => {
    if (leftPanelView === 'select') {
      // 切换到新建模式，清理编辑模式的状态
      setCurrentSkillId(null);
      setCurrentSkill(null);
      setCurrentFilePath(null);
      setFileContent('');
      setOriginalContent('');
      setSkillFiles([]);
      setHasUnsavedChanges(false);
      setGeneratedSkillName('');
    } else if (leftPanelView === 'edit') {
      // 切换到编辑模式，清理新建模式的状态
      setSelectedConversations([]);
      setWebPageEntries([]);
      setSkillRequirements('');
    }
  }, [leftPanelView]);

  // ============================================
  // 会话历史加载
  // ============================================

  const loadConversationHistoryFn = useCallback(async () => {
    setLoadingHistory(true);
    try {
      // 始终加载所有会话，不按 skillId 过滤
      const result = await api.skillConversationList();
      if (result.success && result.data) {
        setConversationHistory(result.data as SkillConversationMeta[]);
        return result.data as SkillConversationMeta[];
      }
      return [];
    } catch (e) {
      console.error('Failed to load conversation history:', e);
      return [];
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  // ============================================
  // 技能选择和文件加载
  // ============================================

  // 辅助函数：查找技能主文件
  const findSkillFile = useCallback((nodes: SkillFileNode[]): string | null => {
    for (const node of nodes) {
      if (node.type === 'file' && (node.name === 'SKILL.yaml' || node.name === 'SKILL.md')) {
        return node.name;
      }
      if (node.children) {
        const found = findSkillFile(node.children);
        if (found) return found;
      }
    }
    return null;
  }, []);

  // 加载文件内容
  const loadFile = useCallback(async (skillId: string, filePath: string) => {
    try {
      const result = await api.skillFileContent(skillId, filePath);
      if (result.success && result.data !== undefined) {
        const content = result.data;
        setCurrentFilePath(filePath);
        setFileContent(content);
        setOriginalContent(content);
        setHasUnsavedChanges(false);
      }
    } catch (e) {
      console.error('Failed to load file:', e);
    }
  }, []);

  // ============================================
  // 会话管理
  // ============================================

  const loadConversation = useCallback(
    async (conversationId: string) => {
      try {
        const result = await api.skillConversationGet(conversationId);
        if (result.success && result.data) {
          const conversation = result.data as any;
          setLoadedMessages(conversation.messages || []);
          setCurrentConversationId(conversationId);
          setAgentPanelOpen(true);
        }
      } catch (e) {
        console.error('Failed to load conversation:', e);
      }
    },
    [setAgentPanelOpen],
  );

  const initSkillSessionState = useCallback((conversationId: string) => {
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

  // 选择技能并自动加载/创建关联会话
  const selectSkill = useCallback(
    async (skillId: string | null) => {
      if (!skillId) {
        setCurrentSkillId(null);
        setCurrentSkill(null);
        setCurrentFilePath(null);
        setFileContent('');
        setOriginalContent('');
        setSkillFiles([]);
        setHasUnsavedChanges(false);
        setCurrentConversationId(null);
        setLoadedMessages([]);
        return;
      }

      const skill = installedSkills.find((s) => s.appId === skillId);
      if (!skill) return;

      setCurrentSkillId(skillId);
      setCurrentSkill(skill);
      setHasUnsavedChanges(false);
      setError(null);

      // 加载文件树
      setLoadingFiles(true);
      try {
        const result = await api.skillFiles(skillId);
        if (result.success && result.data) {
          setSkillFiles(result.data as SkillFileNode[]);
          // 自动选择 SKILL.yaml 或 SKILL.md
          const skillYaml = findSkillFile(result.data as SkillFileNode[]);
          if (skillYaml) {
            await loadFile(skillId, skillYaml);
          } else {
            setCurrentFilePath(null);
            setFileContent('');
            setOriginalContent('');
          }
        }
      } catch (e) {
        console.error('Failed to load skill files:', e);
      } finally {
        setLoadingFiles(false);
      }

      // 加载所有会话历史（历史列表始终显示全部）
      const allConversations = await loadConversationHistoryFn();
      // 筛选出当前 skill 关联的会话
      const skillConversations = allConversations.filter((c) => c.relatedSkillId === skillId);
      if (skillConversations.length > 0) {
        // 自动加载该 skill 最近的会话
        const latestConv = skillConversations[0];
        await loadConversation(latestConv.id);
        setAgentPanelOpen(true);
      } else {
        // 没有历史会话，创建一个新的
        try {
          const createResult = await api.skillConversationCreate(
            `Edit: ${skill.spec?.name || skillId}`,
            skillId,
          );
          if (createResult.success && createResult.data) {
            const newConversationId = (createResult.data as any).id;
            setCurrentConversationId(newConversationId);
            setLoadedMessages([]);
            setAgentPanelOpen(true);
            // 刷新历史列表
            loadConversationHistoryFn();
          }
        } catch (e) {
          console.error('Failed to create conversation for skill:', e);
        }
      }
    },
    [
      installedSkills,
      loadConversationHistoryFn,
      loadConversation,
      loadFile,
      findSkillFile,
      setAgentPanelOpen,
    ],
  );

  // ============================================
  // 对话选择（新建 Skill 模式）
  // ============================================

  const toggleConversation = async (conv: ConversationOption) => {
    const exists = selectedConversations.find((c) => c.id === conv.id);
    if (exists) {
      // 取消选中
      setSelectedConversations((prev) => prev.filter((c) => c.id !== conv.id));
    } else {
      // 选中新会话，先标记为加载中
      setSelectedConversations((prev) => [...prev, { ...conv, isLoadingMessages: true }]);
      try {
        // 加载完整会话内容
        const result = await api.getConversation(conv.spaceId, conv.id);
        if (result.success && result.data) {
          const conversation = result.data as any;
          const messages = conversation.messages || [];

          // 加载每个消息的 thoughts（如果 thoughts 是 null，说明需要从单独文件加载）
          const messagesWithThoughts = await Promise.all(
            messages.map(async (msg: Message) => {
              // thoughts 为 null 表示 thoughts 存在但存储在单独文件中
              if (msg.thoughts === null && msg.thoughtsSummary) {
                try {
                  const thoughtsResult = await api.getMessageThoughts(
                    conv.spaceId,
                    conv.id,
                    msg.id,
                  );
                  if (thoughtsResult.success && thoughtsResult.data) {
                    return { ...msg, thoughts: thoughtsResult.data as Thought[] };
                  }
                } catch (e) {
                  console.warn('Failed to load thoughts for message:', msg.id, e);
                }
              }
              return msg;
            }),
          );

          setSelectedConversations((prev) =>
            prev.map((c) =>
              c.id === conv.id
                ? { ...c, messages: messagesWithThoughts, isLoadingMessages: false }
                : c,
            ),
          );
        } else {
          // 加载失败，移除该会话
          setSelectedConversations((prev) => prev.filter((c) => c.id !== conv.id));
        }
      } catch (e) {
        console.error('Failed to load conversation:', e);
        // 加载失败，移除该会话
        setSelectedConversations((prev) => prev.filter((c) => c.id !== conv.id));
      }
    }
  };

  const toggleSpaceExpand = (spaceId: string) => {
    setExpandedSpaces((prev) => {
      const next = new Set(prev);
      if (next.has(spaceId)) {
        next.delete(spaceId);
      } else {
        next.add(spaceId);
      }
      return next;
    });
  };

  const toggleSpaceConversations = async (spaceId: string, selectAll: boolean) => {
    const spaceConvs = conversationsBySpace.get(spaceId) || [];

    if (!selectAll) {
      // 取消选中该空间的所有会话
      setSelectedConversations((prev) => prev.filter((c) => c.spaceId !== spaceId));
      return;
    }

    // 选中该空间的所有会话，需要加载完整内容
    const existingIds = new Set(selectedConversations.map((c) => c.id));
    const newConvs = spaceConvs.filter((c) => !existingIds.has(c.id));

    // 先添加所有新会话，标记为加载中
    setSelectedConversations((prev) => [
      ...prev,
      ...newConvs.map((c) => ({ ...c, isLoadingMessages: true })),
    ]);

    // 并行加载所有会话的完整内容
    const loadPromises = newConvs.map(async (conv) => {
      try {
        const result = await api.getConversation(conv.spaceId, conv.id);
        if (result.success && result.data) {
          const conversation = result.data as any;
          return { id: conv.id, messages: conversation.messages || [], success: true };
        }
        return { id: conv.id, messages: [], success: false };
      } catch (e) {
        console.error(`Failed to load conversation ${conv.id}:`, e);
        return { id: conv.id, messages: [], success: false };
      }
    });

    const results = await Promise.all(loadPromises);

    // 更新加载完成的会话
    setSelectedConversations((prev) => {
      return prev.map((c) => {
        const result = results.find((r) => r.id === c.id);
        if (result) {
          return { ...c, messages: result.messages, isLoadingMessages: false };
        }
        return c;
      });
    });
  };

  const getSpaceSelectionState = (spaceId: string): 'all' | 'partial' | 'none' => {
    const spaceConvs = conversationsBySpace.get(spaceId) || [];
    if (spaceConvs.length === 0) return 'none';
    const selectedCount = selectedConversations.filter((c) => c.spaceId === spaceId).length;
    if (selectedCount === 0) return 'none';
    if (selectedCount === spaceConvs.length) return 'all';
    return 'partial';
  };

  // 从内容中提取技能名称
  const extractSkillName = useCallback((content: string): string | null => {
    const patterns = [
      /~\/\.agents\/skills\/([a-zA-Z0-9_-]+)\/?/g,
      /\.agents\/skills\/([a-zA-Z0-9_-]+)\/?/g,
      /skills\/([a-zA-Z0-9_-]+)\/SKILL\.(yaml|md)/g,
      /创建技能[:：]\s*`?([a-zA-Z0-9_-]+)`?/g,
      /skill name[:：]\s*`?([a-zA-Z0-9_-]+)`?/gi,
    ];
    for (const pattern of patterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        if (match[1] && match[1] !== 'skill-creator') {
          return match[1];
        }
      }
    }
    return null;
  }, []);

  // 从流式内容中提取技能名称
  useEffect(() => {
    if (!streamingContent) return;
    const skillName = extractSkillName(streamingContent);
    if (skillName && skillName !== generatedSkillName) {
      setGeneratedSkillName(skillName);
    }
  }, [streamingContent, extractSkillName, generatedSkillName]);

  // 从历史消息中提取技能名称
  useEffect(() => {
    if (generatedSkillName || messages.length === 0) return;
    for (const msg of messages) {
      const skillName = extractSkillName(msg.content || '');
      if (skillName) {
        setGeneratedSkillName(skillName);
        break;
      }
    }
  }, [messages, generatedSkillName, extractSkillName]);

  // ============================================
  // 启动生成（新建 Skill）
  // ============================================

  // 格式化单个会话的完整内容
  const formatConversationContent = useCallback((conv: ConversationOption): string => {
    if (!conv.messages || conv.messages.length === 0) {
      return `[${conv.spaceName}] ${conv.title}\n（无消息内容）`;
    }

    const header = `### 会话: [${conv.spaceName}] ${conv.title}`;
    const messages = conv.messages
      .map((msg) => {
        const role = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? 'Claude' : '系统';
        let content = msg.content || '';

        // 处理思考过程，只包含需要的类型
        // 需要：tool_use（工具调用）、tool_result（工具返回）、text（AI 输出）
        // 不需要：thinking（思考中）、system（系统）
        if (msg.thoughts && msg.thoughts.length > 0) {
          const relevantThoughts = msg.thoughts.filter(
            (t) => t.type === 'tool_use' || t.type === 'tool_result' || t.type === 'text',
          );

          if (relevantThoughts.length > 0) {
            const thoughtsContent = relevantThoughts
              .map((t) => {
                if (t.type === 'tool_use') {
                  // 工具调用：显示工具名和输入参数
                  const toolInfo = t.toolName || 'unknown';
                  const inputInfo = t.toolInput
                    ? `\n输入: ${JSON.stringify(t.toolInput, null, 2)}`
                    : '';
                  return `【工具调用】${toolInfo}${inputInfo}`;
                } else if (t.type === 'tool_result') {
                  // 工具返回：显示结果（可能存储在 content 或 toolOutput 字段）
                  const output = t.content || t.toolOutput || '';
                  if (!output) return '';
                  const truncatedOutput =
                    output.length > 500 ? output.substring(0, 500) + '...(已截断)' : output;
                  const errorPrefix = t.isError ? '❌ ' : '';
                  return `【工具返回】${errorPrefix}${truncatedOutput}`;
                } else if (t.type === 'text') {
                  // AI 输出（text 类型）
                  return `【AI】${t.content || ''}`;
                }
                return '';
              })
              .filter(Boolean)
              .join('\n\n');

            if (thoughtsContent) {
              content = `${thoughtsContent}\n\n【最终回复】\n${content}`;
            }
          }
        }

        return `#### ${role}:\n${content}`;
      })
      .join('\n\n');

    return `${header}\n\n${messages}`;
  }, []);

  const handleStartGeneration = async () => {
    const hasConversations = selectedConversations.length > 0;
    const loadedPages = webPageEntries.filter((e) => e.status === 'loaded');
    const hasPages = loadedPages.length > 0;
    const hasRequirements = skillRequirements.trim().length > 0;

    if (!hasConversations && !hasPages && !hasRequirements) {
      await alertDialog(
        t('Please select conversations, add webpage URLs, or describe the skill you want'),
      );
      return;
    }

    // 检查是否有会话还在加载中
    if (hasConversations) {
      const stillLoading = selectedConversations.some((c) => c.isLoadingMessages);
      if (stillLoading) {
        await alertDialog(t('Please wait for conversations to finish loading'));
        return;
      }
    }

    // 检查 skill-creator 技能是否已安装
    const skillCreatorInstalled = installedSkills.some(
      (skill) => skill.appId === 'skill-creator' || skill.spec?.name === 'skill-creator',
    );
    if (!skillCreatorInstalled) {
      await alertDialog(
        t('skill-creator skill is not installed. Please install it from the Skill Market first.'),
      );
      useSkillStore.getState().setCurrentView('market');
      return;
    }

    // 构建上下文内容
    const contextParts: string[] = [];
    const metadata: any = {};

    // 添加对话历史
    if (hasConversations) {
      const conversationContext = selectedConversations
        .map((c) => formatConversationContent(c))
        .join('\n\n---\n\n');
      contextParts.push(`## 对话历史\n${conversationContext}`);

      // 存储选中的会话信息用于前端折叠显示
      metadata.selectedConversations = selectedConversations.map((c) => ({
        id: c.id,
        title: c.title,
        spaceName: c.spaceName,
        messageCount: c.messages?.length || 0,
        formattedContent: formatConversationContent(c),
      }));
    }

    // 添加网页内容
    if (hasPages) {
      const pageContents = loadedPages
        .map((p, i) => `### 网页 ${i + 1}: ${p.title || p.url}\n${p.content}`)
        .join('\n\n---\n\n');
      contextParts.push(`## 参考网页内容\n${pageContents}`);

      metadata.sourceWebpages = loadedPages.map((p) => ({
        url: p.url,
        title: p.title,
        content: p.content,
      }));
    }

    // 添加用户要求
    if (hasRequirements) {
      contextParts.push(`## 用户的技能要求\n${skillRequirements.trim()}`);
    }

    const initialPrompt = `请根据以下内容帮我创建一个可复用的技能。

${contextParts.join('\n\n')}

## 任务要求
1. 分析上述内容，理解用户的核心需求
2. 自行为技能选择一个合适的英文名称（简洁、有意义、kebab-case 格式）
3. 自行生成合适的触发命令（如 /xxx 格式）
4. 编写清晰的技能描述和系统提示词
5. 使用 skill-creator 技能来创建新的技能到 ~/.agents/skills/<技能名称>/ 目录

请开始创建技能。`;

    setAgentPanelOpen(true);
    setError(null);

    try {
      // 生成标题
      let title = 'Skill: ';
      if (hasRequirements) {
        title += skillRequirements.trim().slice(0, 30) + '...';
      } else if (hasPages) {
        title += 'From Webpages';
      } else {
        title += new Date().toLocaleDateString();
      }

      const createResult = await api.skillConversationCreate(title);
      if (!createResult.success || !createResult.data) {
        setError(createResult.error || 'Failed to create conversation');
        return;
      }

      const newConversationId = (createResult.data as any).id;
      setCurrentConversationId(newConversationId);
      loadConversationHistoryFn();

      const userMsg: Message = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content: initialPrompt,
        timestamp: new Date().toISOString(),
        metadata,
      };
      setLoadedMessages([userMsg]);
      initSkillSessionState(newConversationId);

      api
        .skillConversationSend(newConversationId, initialPrompt, metadata)
        .then((sendResult) => {
          if (!sendResult.success) {
            setError(sendResult.error || 'Failed to send message');
          }
          loadConversationHistoryFn();
          // 不再调用 loadConversation，因为 SSE 事件会自动更新消息
          // metadata 已经通过 API 传递到后端保存，折叠卡片会正确显示
        })
        .catch((e) => {
          setError(e instanceof Error ? e.message : 'Failed to send message');
        });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start generation');
    }
  };

  // ============================================
  // 从空白创建相关处理函数
  // ============================================

  // 添加网页 URL
  const handleAddWebPageUrl = async () => {
    const url = newUrlInput.trim();
    if (!url) return;

    // 检查是否已存在
    if (webPageEntries.some((e) => e.url === url)) {
      return;
    }

    const newEntry: WebPageEntry = {
      id: `webpage-${Date.now()}`,
      url,
      status: 'loading',
    };

    setWebPageEntries((prev) => [...prev, newEntry]);
    setNewUrlInput('');

    try {
      const result = await api.fetchWebPageContent(url);
      if (result.success && result.data) {
        setWebPageEntries((prev) =>
          prev.map((e) =>
            e.id === newEntry.id
              ? {
                  ...e,
                  status: 'loaded' as const,
                  title: result.data!.title || url,
                  content: result.data!.content,
                }
              : e,
          ),
        );
      } else {
        setWebPageEntries((prev) =>
          prev.map((e) =>
            e.id === newEntry.id
              ? {
                  ...e,
                  status: 'error' as const,
                  error: result.error || 'Failed to load webpage',
                }
              : e,
          ),
        );
      }
    } catch (e) {
      setWebPageEntries((prev) =>
        prev.map((entry) =>
          entry.id === newEntry.id
            ? {
                ...entry,
                status: 'error' as const,
                error: e instanceof Error ? e.message : 'Failed to load webpage',
              }
            : entry,
        ),
      );
    }
  };

  // 移除网页 URL
  const handleRemoveWebPageUrl = (id: string) => {
    setWebPageEntries((prev) => prev.filter((e) => e.id !== id));
  };

  // ============================================
  // 发送消息
  // ============================================

  const handleSendMessage = () => {
    if (!userInput.trim() || isGenerating || !currentConversationId) return;

    const message = userInput.trim();
    setUserInput('');

    // 获取当前 skill 名称用于上下文
    const skillName = currentSkill?.spec?.name || generatedSkillName || currentSkillId;
    const skillContext = skillName ? `当前正在编辑的技能名称: ${skillName}\n\n` : '';

    const userMsg: Message = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: selection
        ? `${skillContext}${message}\n\n选中内容:\n\`\`\`\n${selection.text}\n\`\`\``
        : `${skillContext}${message}`,
      timestamp: new Date().toISOString(),
    };
    setLoadedMessages((prev) => [...prev, userMsg]);
    setSelection(null);
    setShowSelectionMenu(false);
    initSkillSessionState(currentConversationId);

    api
      .skillConversationSend(currentConversationId, userMsg.content)
      .then((sendResult) => {
        if (!sendResult.success) {
          setError(sendResult.error || 'Failed to send message');
        }
        // 不再调用 loadConversation，因为 SSE 事件会自动更新消息
        // 如果调用 loadConversation，可能会覆盖本地添加的用户消息
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Failed to send message');
      });
  };

  // ============================================
  // 删除会话
  // ============================================

  const handleDeleteConversation = async (conversationId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!(await confirmDialog(t('Delete this conversation?')))) return;

    try {
      await api.skillConversationDelete(conversationId);
      setConversationHistory((prev) => prev.filter((c) => c.id !== conversationId));
      if (currentConversationId === conversationId) {
        setCurrentConversationId(null);
        setLoadedMessages([]);
        setAgentPanelOpen(false);
      }
    } catch (err) {
      console.error('Failed to delete conversation:', err);
    }
  };

  // ============================================
  // 关闭面板
  // ============================================

  const handleClosePanel = async () => {
    if (currentConversationId) {
      try {
        await api.skillConversationClose(currentConversationId);
      } catch (e) {
        console.error('Failed to close conversation:', e);
      }
    }
    setCurrentConversationId(null);
    setLoadedMessages([]);
    setAgentPanelOpen(false);
    setError(null);
  };

  // ============================================
  // 文件树渲染
  // ============================================

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const refreshSkillFiles = async () => {
    const skillName = generatedSkillName || currentSkillId;
    if (!skillName) return;

    setLoadingFiles(true);
    try {
      const result = await api.skillFiles(skillName);
      if (result.success && result.data) {
        setSkillFiles(result.data as SkillFileNode[]);
        const skillYaml = findSkillFile(result.data as SkillFileNode[]);
        if (skillYaml) {
          await loadFile(skillName, skillYaml);
        }
      }
    } catch (e) {
      console.error('Failed to refresh skill files:', e);
    } finally {
      setLoadingFiles(false);
    }
  };

  const renderFileTree = (nodes: SkillFileNode[], path = ''): React.ReactNode => {
    return nodes.map((node) => {
      const fullPath = path ? `${path}/${node.name}` : node.name;
      if (node.type === 'directory') {
        const isExpanded = expandedDirs.has(fullPath);
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
              <div className="ml-4">{renderFileTree(node.children, fullPath)}</div>
            )}
          </div>
        );
      } else {
        return (
          <div
            key={fullPath}
            className={`flex items-center gap-1 px-2 py-1 hover:bg-secondary/50 cursor-pointer text-sm ${
              currentFilePath === fullPath ? 'bg-primary/20' : ''
            }`}
            onClick={() => {
              if (currentSkillId) {
                loadFile(currentSkillId, fullPath);
              }
            }}
          >
            <File className="w-4 h-4 text-blue-400" />
            <span>{node.name}</span>
          </div>
        );
      }
    });
  };

  // ============================================
  // 编辑器变更处理
  // ============================================

  const handleEditorChange = useCallback(
    (content: string) => {
      setFileContent(content);
      setHasUnsavedChanges(content !== originalContent);
    },
    [originalContent],
  );

  // 保存文件
  const handleSave = useCallback(async () => {
    const skillId = currentSkillId || generatedSkillName;
    if (!skillId || !currentFilePath || !hasUnsavedChanges) return;

    setIsSaving(true);
    try {
      const result = await api.skillFileSave(skillId, currentFilePath, fileContent);
      if (result.success) {
        setOriginalContent(fileContent);
        setHasUnsavedChanges(false);
      } else {
        setError(result.error || 'Failed to save file');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save file');
    } finally {
      setIsSaving(false);
    }
  }, [currentSkillId, generatedSkillName, currentFilePath, fileContent, hasUnsavedChanges]);

  const handleTextSelection = useCallback(
    (sel: SelectionState | null) => {
      setSelection(sel);
      // 如果其他会话正在生成，不显示选择菜单
      if (anySessionGenerating) {
        setShowSelectionMenu(false);
        return;
      }
      if (sel && sel.text.length > 10) {
        setShowSelectionMenu(true);
        setSelectionMenuPosition({
          x: sel.menuX ?? 200,
          y: sel.menuY ?? 200,
        });
      } else {
        setShowSelectionMenu(false);
      }
    },
    [anySessionGenerating],
  );

  // ============================================
  // 右侧面板拖动
  // ============================================

  const handlePanelMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingPanel(true);
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingPanel) return;
      const newWidth = window.innerWidth - e.clientX - 10;
      if (newWidth >= 280 && newWidth <= 500) {
        setRightPanelWidth(newWidth);
      }
    };
    const handleMouseUp = () => setIsResizingPanel(false);

    if (isResizingPanel) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingPanel]);

  // 自动滚动（支持用户手动滚动时暂停自动滚动）
  useEffect(() => {
    const justSwitched = prevConversationIdRef.current !== currentConversationId;
    prevConversationIdRef.current = currentConversationId;

    // 如果切换了会话，重置滚动标志
    if (justSwitched) {
      userScrolledRef.current = false;
    }

    // 只有在用户没有手动滚动时才自动滚动
    if ((justSwitched || isGenerating) && !userScrolledRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingContent, thoughts, isGenerating, currentConversationId]);

  // 监听用户手动滚动
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      // 如果用户向上滚动了一定距离（比如 100px），标记为手动滚动
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      if (distanceFromBottom > 100) {
        userScrolledRef.current = true;
      } else {
        // 如果用户滚动到底部附近，重置标志，恢复自动滚动
        userScrolledRef.current = false;
      }
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [currentConversationId]); // 切换会话时重新绑定

  // 生成完成后刷新文件
  useEffect(() => {
    if (!isGenerating && currentConversationId && streamingContent) {
      const timer = setTimeout(() => {
        // 清除待替换范围（实时替换已在 SkillCodeEditor 中处理）
        if (pendingReplaceRangeRef.current) {
          pendingReplaceRangeRef.current = null;
          // 只刷新历史，不刷新文件（因为编辑器内容已经通过实时替换修改）
          loadConversationHistoryFn();
        } else {
          // 没有待替换范围，正常刷新文件
          refreshSkillFiles();
          loadConversationHistoryFn();
        }
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [isGenerating, currentConversationId, streamingContent]);

  // 监听 thoughts 中的文件操作工具，实时刷新文件
  useEffect(() => {
    if (!thoughts || thoughts.length === 0 || !currentConversationId) return;

    // 只处理新增的 thoughts
    const newThoughtsStart = lastProcessedThoughtsLengthRef.current;
    if (newThoughtsStart >= thoughts.length) return;

    const newThoughts = thoughts.slice(newThoughtsStart);
    lastProcessedThoughtsLengthRef.current = thoughts.length;

    // 检测文件操作工具调用（Write, Edit 等）
    const fileOperationTools = [
      'Write',
      'Edit',
      'write_file',
      'edit_file',
      'create_file',
      'delete_file',
    ];
    const hasFileOperation = newThoughts.some((thought) => {
      if (thought.type === 'tool_use' && thought.toolName) {
        return (
          fileOperationTools.includes(thought.toolName) ||
          thought.toolName.toLowerCase().includes('write') ||
          thought.toolName.toLowerCase().includes('edit') ||
          thought.toolName.toLowerCase().includes('file')
        );
      }
      // 检测 tool_result 中是否包含文件路径相关的信息
      if (thought.type === 'tool_result' && thought.content) {
        const content =
          typeof thought.content === 'string' ? thought.content : JSON.stringify(thought.content);
        return (
          content.includes('.agents/skills/') ||
          content.includes('SKILL.yaml') ||
          content.includes('SKILL.md') ||
          content.includes('successfully wrote') ||
          content.includes('successfully edited')
        );
      }
      return false;
    });

    // 如果检测到文件操作且有完成的 tool_result，刷新文件
    if (hasFileOperation) {
      // 检查是否有已完成的文件操作（tool_result 且不是流式中）
      const hasCompletedFileOp = newThoughts.some(
        (thought) => thought.type === 'tool_result' && !thought.isStreaming && !thought.isError,
      );

      if (hasCompletedFileOp) {
        // 延迟刷新，等待文件系统同步
        setTimeout(() => {
          refreshSkillFiles();
        }, 300);
      }
    }
  }, [thoughts, currentConversationId]);

  // 重置 thoughts 追踪（切换会话时）
  useEffect(() => {
    lastProcessedThoughtsLengthRef.current = 0;
  }, [currentConversationId]);

  // ============================================
  // 渲染消息内容（使用 metadata 中的会话信息渲染折叠卡片）
  // ============================================

  const renderMessageContent = (msg: Message) => {
    const selectedConvInfo = (msg.metadata as any)?.selectedConversations;
    const sourceWebpagesInfo = (msg.metadata as any)?.sourceWebpages;

    // 如果有会话或网页信息，渲染折叠卡片
    if (
      (selectedConvInfo && selectedConvInfo.length > 0) ||
      (sourceWebpagesInfo && sourceWebpagesInfo.length > 0)
    ) {
      const elements: React.ReactNode[] = [];

      // 前置文本
      elements.push(
        <div key="intro" className="whitespace-pre-wrap break-words mb-2 text-xs opacity-90">
          {t('Creating skill based on the following content:')}
        </div>,
      );

      // 渲染会话折叠卡片
      if (selectedConvInfo && selectedConvInfo.length > 0) {
        selectedConvInfo.forEach((conv: any, idx: number) => {
          const content = conv.formattedContent || '';
          const lines = content.split('\n');
          const body = lines.slice(1).join('\n').trim();

          elements.push(
            <details
              key={`session-${currentConversationId}-${msg.id}-${idx}`}
              className="my-1 bg-blue-500/10 rounded border border-blue-500/20"
              open={false}
            >
              <summary className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer text-xs font-medium text-blue-400 select-none hover:bg-blue-500/10 rounded">
                <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate flex-1">
                  [{conv.spaceName}] {conv.title}
                </span>
                <span className="text-muted-foreground text-[10px]">
                  ({conv.messageCount} {t('messages')})
                </span>
                <ChevronDown className="w-3.5 h-3.5 opacity-50 ml-1 shrink-0" />
              </summary>
              <div className="px-3 py-2 text-sm text-foreground whitespace-pre-wrap max-h-60 overflow-y-auto border-t border-blue-500/20 mt-1 bg-background/50">
                {body}
              </div>
            </details>,
          );
        });
      }

      // 渲染网页折叠卡片
      if (sourceWebpagesInfo && sourceWebpagesInfo.length > 0) {
        sourceWebpagesInfo.forEach((page: any, idx: number) => {
          const displayTitle = page.title || page.url;
          const pageContent = page.content || '';
          // 显示内容摘要（前 500 字符）
          const contentPreview =
            pageContent.length > 500 ? pageContent.substring(0, 500) + '...' : pageContent;

          elements.push(
            <details
              key={`webpage-${currentConversationId}-${msg.id}-${idx}`}
              className="my-1 bg-green-500/10 rounded border border-green-500/20"
              open={false}
            >
              <summary className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer text-xs font-medium text-green-400 select-none hover:bg-green-500/10 rounded">
                <Globe className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate flex-1">{displayTitle}</span>
                <ChevronDown className="w-3.5 h-3.5 opacity-50 ml-1 shrink-0" />
              </summary>
              <div className="px-3 py-2 text-sm text-foreground whitespace-pre-wrap max-h-60 overflow-y-auto border-t border-green-500/20 mt-1 bg-background/50">
                {contentPreview}
              </div>
            </details>,
          );
        });
      }

      // 从 content 中提取 "## 任务要求" 之后的部分
      const requirementsIdx = msg.content.indexOf('## 任务要求');
      if (requirementsIdx > 0) {
        elements.push(
          <div key="outro" className="whitespace-pre-wrap break-words mt-2 text-xs">
            {msg.content.substring(requirementsIdx)}
          </div>,
        );
      }

      return <>{elements}</>;
    }

    // 没有 metadata，直接显示内容
    return <div className="whitespace-pre-wrap break-words">{msg.content}</div>;
  };

  // ============================================
  // 渲染思考过程
  // ============================================

  const renderThoughts = (thoughts: Thought[], isThinking: boolean) => {
    if (!thoughts || thoughts.length === 0) return null;

    const getCurrentAction = (): string => {
      for (let i = thoughts.length - 1; i >= 0; i--) {
        const th = thoughts[i];
        if (th.type === 'tool_use' && th.toolName) {
          if (th.isStreaming || !th.isReady) return `${th.toolName}...`;
          return th.toolName;
        }
        if (th.type === 'thinking') return t('Thinking...');
      }
      return t('Processing...');
    };

    return (
      <div className="mb-2">
        <details className="group" open={false}>
          <summary className="flex items-center gap-2 px-2 py-1.5 bg-purple-500/10 hover:bg-purple-500/20 rounded cursor-pointer text-xs select-none">
            <Lightbulb className="w-3.5 h-3.5 text-purple-500" />
            <span className="text-purple-600 dark:text-purple-400 font-medium">
              {t('Thinking Process')}
            </span>
            <span className="text-muted-foreground">({thoughts.length})</span>
            {isThinking && (
              <span className="flex items-center gap-1 text-muted-foreground ml-auto">
                <Loader2 className="w-3 h-3 animate-spin" />
                {getCurrentAction()}
              </span>
            )}
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground ml-1 group-open:rotate-180 transition-transform" />
          </summary>
          <div className="mt-1 space-y-1 max-h-60 overflow-y-auto">
            {thoughts.map((thought, idx) => {
              const isError = thought.type === 'error' || thought.isError;
              const isSuccess = thought.type === 'tool_result' && !thought.isError;
              const isToolUse = thought.type === 'tool_use';
              const isThinking = thought.type === 'thinking';

              const bgClass = isError
                ? 'bg-red-500/10 border-red-500/30'
                : isSuccess
                  ? 'bg-green-500/10 border-green-500/30'
                  : isToolUse
                    ? 'bg-blue-500/10 border-blue-500/30'
                    : isThinking
                      ? 'bg-purple-500/10 border-purple-500/30'
                      : 'bg-secondary/50 border-border/50';

              const Icon = isError
                ? AlertTriangle
                : isSuccess
                  ? CheckCircle2
                  : isToolUse
                    ? Wrench
                    : isThinking
                      ? Brain
                      : MessageSquare;
              const iconColor = isError
                ? 'text-red-500'
                : isSuccess
                  ? 'text-green-500'
                  : isToolUse
                    ? 'text-blue-500'
                    : isThinking
                      ? 'text-purple-500'
                      : 'text-muted-foreground';

              const content =
                thought.type === 'tool_use'
                  ? thought.toolName
                    ? `${thought.toolName}${thought.toolInput ? `: ${JSON.stringify(thought.toolInput).substring(0, 100)}...` : ''}`
                    : ''
                  : thought.content || '';

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
                        <span className="text-muted-foreground">· {thought.toolName}</span>
                      )}
                    </div>
                    {content && (
                      <pre className="mt-0.5 text-muted-foreground whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed">
                        {content.length > 200 ? content.substring(0, 200) + '...' : content}
                      </pre>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      </div>
    );
  };

  // ============================================
  // 获取文件语言
  // ============================================

  const getFileLanguage = (filePath: string | null): string => {
    if (!filePath) return 'yaml';
    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'yaml':
      case 'yml':
        return 'yaml';
      case 'md':
        return 'markdown';
      case 'json':
        return 'json';
      case 'ts':
      case 'tsx':
        return 'typescript';
      case 'js':
      case 'jsx':
        return 'javascript';
      case 'py':
        return 'python';
      default:
        return 'yaml';
    }
  };

  // ============================================
  // 渲染
  // ============================================

  return (
    <>
      {ConfirmDialogElement}
      <div className="flex h-full">
        {/* 左侧面板 */}
        <div className="w-80 border-r border-border flex flex-col flex-shrink-0">
          {/* Tab 切换 */}
          <div className="flex border-b border-border">
            <button
              onClick={() => setLeftPanelView('select')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors ${
                leftPanelView === 'select'
                  ? 'text-primary border-b-2 border-primary bg-primary/5'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
              }`}
            >
              <Sparkles className="w-4 h-4" />
              {t('New')}
            </button>
            <button
              onClick={() => setLeftPanelView('edit')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors ${
                leftPanelView === 'edit'
                  ? 'text-primary border-b-2 border-primary bg-primary/5'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
              }`}
            >
              <FileCode className="w-4 h-4" />
              {t('Edit')}
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
            {/* === 新建 Skill 模式 === */}
            {leftPanelView === 'select' && (
              <>
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
                    <MessageSquare className="w-4 h-4" />
                    {t('Select Conversations')}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {t('Click space to expand, then select conversations')}
                  </p>

                  <div className="max-h-60 overflow-y-auto border border-border rounded-lg">
                    {allSpaces.map((space) => {
                      const convs = conversationsBySpace.get(space.id) || [];
                      if (convs.length === 0) return null;

                      const isExpanded = expandedSpaces.has(space.id);
                      const selectionState = getSpaceSelectionState(space.id);

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
                            <span className="text-xs text-muted-foreground">{convs.length}</span>
                          </div>

                          {isExpanded && (
                            <div className="bg-secondary/10">
                              <div
                                className="flex items-center gap-2 px-3 py-1.5 hover:bg-secondary/30 cursor-pointer border-b border-border/50"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleSpaceConversations(space.id, selectionState !== 'all');
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
                              {convs.map((conv) => {
                                const isSelected = selectedConversations.some(
                                  (c) => c.id === conv.id,
                                );
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
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {selectedConversations.length > 0 && (
                    <p className="text-xs text-primary">
                      {t('{count} conversations selected', { count: selectedConversations.length })}
                    </p>
                  )}
                </div>

                <div className="border-t border-border" />

                {/* === 或者添加网页 URL === */}
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
                    <Globe className="w-4 h-4" />
                    {t('Or add webpage URLs')}
                  </h3>
                  <div className="flex gap-2">
                    <input
                      type="url"
                      value={newUrlInput}
                      onChange={(e) => setNewUrlInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddWebPageUrl();
                        }
                      }}
                      placeholder={t('https://example.com/docs')}
                      className="flex-1 px-3 py-1.5 bg-secondary border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <button
                      onClick={handleAddWebPageUrl}
                      disabled={!newUrlInput.trim()}
                      className="px-3 py-1.5 bg-secondary hover:bg-secondary/80 rounded-lg text-sm transition-colors disabled:opacity-50"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>

                  {/* 已添加的网页列表 */}
                  {webPageEntries.length > 0 && (
                    <div className="space-y-1">
                      {webPageEntries.map((entry) => (
                        <div
                          key={entry.id}
                          className="flex items-center gap-2 px-2 py-1.5 bg-secondary rounded-lg"
                        >
                          {entry.status === 'loading' && (
                            <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin flex-shrink-0" />
                          )}
                          {entry.status === 'loaded' && (
                            <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                          )}
                          {entry.status === 'error' && (
                            <AlertTriangle className="w-3.5 h-3.5 text-destructive flex-shrink-0" />
                          )}
                          {entry.status === 'pending' && (
                            <Link className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-foreground truncate">
                              {entry.title || entry.url}
                            </p>
                            {entry.status === 'error' && entry.error && (
                              <p className="text-xs text-destructive truncate">{entry.error}</p>
                            )}
                          </div>
                          <button
                            onClick={() => handleRemoveWebPageUrl(entry.id)}
                            className="p-0.5 hover:bg-secondary/80 rounded"
                          >
                            <X className="w-3 h-3 text-muted-foreground" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border-t border-border" />

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

                <button
                  onClick={handleStartGeneration}
                  disabled={!canGenerate}
                  className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    !canGenerate
                      ? 'bg-primary/50 cursor-not-allowed text-primary-foreground/70'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90'
                  }`}
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
            )}

            {/* === 编辑模式 === */}
            {leftPanelView === 'edit' && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-foreground">{t('Installed Skills')}</h3>
                {sortedSkills.map((skill) => (
                  <div
                    key={skill.appId}
                    onClick={() => selectSkill(skill.appId)}
                    className={`flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors ${
                      currentSkillId === skill.appId
                        ? 'bg-primary/10 text-primary'
                        : 'hover:bg-secondary/50 text-foreground'
                    }`}
                  >
                    <FileCode className="w-4 h-4 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{skill.spec.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {skill.spec.description}
                      </p>
                    </div>
                  </div>
                ))}
                {sortedSkills.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4">
                    {t('No skills installed')}
                  </p>
                )}
              </div>
            )}

            {/* === 历史记录 === */}
            {leftPanelView === 'history' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
                    <History className="w-4 h-4" />
                    {t('Conversation History')}
                  </h3>
                  <button
                    onClick={loadConversationHistoryFn}
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
                    conversationHistory.map((conv) => {
                      const convIsGenerating = sessions.get(conv.id)?.isGenerating || false;
                      // 查找关联的 skill 名称
                      let skillLabel: string | null = null;
                      if (conv.relatedSkillId) {
                        const relatedSkill = installedSkills.find(
                          (s) => s.id === conv.relatedSkillId,
                        );
                        if (relatedSkill?.spec?.name) {
                          skillLabel = relatedSkill.spec.name;
                        } else {
                          // 有 relatedSkillId 但找不到对应的 skill，说明是新建的 skill
                          skillLabel = t('skill name pending...') || 'skill名称待生成...';
                        }
                      }
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
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm text-foreground truncate">{conv.title}</p>
                              {convIsGenerating && (
                                <span className="flex items-center gap-1 text-xs text-green-500">
                                  <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                                  {t('generating')}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                              {skillLabel && (
                                <span
                                  className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 truncate max-w-[120px]"
                                  title={skillLabel}
                                >
                                  {skillLabel}
                                </span>
                              )}
                              <p className="text-xs text-muted-foreground">
                                {new Date(conv.updatedAt).toLocaleDateString()} ·{' '}
                                {conv.messageCount} {t('messages')}
                              </p>
                            </div>
                          </div>
                          <button
                            onClick={(e) => handleDeleteConversation(conv.id, e)}
                            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-destructive/20 rounded transition-opacity"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 中间：编辑器 */}
        <div className={`flex-1 flex flex-col overflow-hidden ${agentPanelOpen ? '' : ''}`}>
          {/* 工具栏 */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-secondary/30">
            <div className="flex items-center gap-2">
              {currentFilePath && (
                <span className="text-sm font-mono text-muted-foreground">{currentFilePath}</span>
              )}
              {hasUnsavedChanges && (
                <span className="text-xs text-orange-500">({t('unsaved')})</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {hasUnsavedChanges && (
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium ${
                    isSaving
                      ? 'bg-primary/50 cursor-not-allowed text-primary-foreground/70'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90'
                  }`}
                >
                  {isSaving ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Save className="w-3 h-3" />
                  )}
                  {isSaving ? t('Saving...') : t('Save')}
                </button>
              )}
              <button
                onClick={() => setAgentPanelOpen(!agentPanelOpen)}
                className={`flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  agentPanelOpen
                    ? 'bg-secondary text-foreground'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
                }`}
              >
                <MessageSquare className="w-3 h-3" />
                {agentPanelOpen ? t('Hide Chat') : t('AI Assistant')}
              </button>
            </div>
          </div>

          {/* 编辑器区域 */}
          <div className="flex-1 overflow-hidden flex">
            {/* 文件树 */}
            {agentPanelOpen && (skillFiles.length > 0 || loadingFiles) && (
              <div className="w-56 border-r border-border overflow-y-auto flex-shrink-0">
                <div className="p-2 border-b border-border flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                    <FolderTree className="w-3 h-3" />
                    {generatedSkillName || currentSkillId || 'skill'}/
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
                    <p className="text-xs text-muted-foreground p-2">{t('No files yet...')}</p>
                  )}
                </div>
              </div>
            )}

            {/* 编辑器 */}
            <div className="flex-1 overflow-hidden relative">
              {agentPanelOpen ? (
                currentFilePath ? (
                  <SkillCodeEditor
                    ref={editorRef}
                    content={fileContent}
                    language={getFileLanguage(currentFilePath)}
                    readOnly={false}
                    onChange={handleEditorChange}
                    onSelectionChange={handleTextSelection}
                    streamingContent={streamingContent}
                    isStreaming={isStreaming}
                    pendingReplaceRange={pendingReplaceRangeRef.current}
                    onReplaceComplete={(newContent) => {
                      setFileContent(newContent);
                      setHasUnsavedChanges(newContent !== originalContent);
                    }}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    <p className="text-sm">{t('Select a file to edit')}</p>
                  </div>
                )
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground p-8">
                  <FileCode className="w-16 h-16 mb-4 opacity-30" />
                  <h3 className="text-lg font-semibold text-foreground mb-2">{t('技能生成器')}</h3>
                  <p className="text-sm max-w-md mb-4">
                    {t(
                      'Select conversations to generate a new skill, or edit an existing skill from the left panel.',
                    )}
                  </p>
                </div>
              )}

              {/* 文本选择菜单 */}
              {showSelectionMenu && selection && currentConversationId && (
                <SelectionMenu
                  position={selectionMenuPosition}
                  selection={selection}
                  onAction={(action, customInput) => {
                    // 不再使用，保留兼容
                    setShowSelectionMenu(false);
                  }}
                  onClose={() => setShowSelectionMenu(false)}
                  onSendDirectly={(message) => {
                    // 获取当前 skill 名称用于上下文
                    const skillName =
                      currentSkill?.spec?.name || generatedSkillName || currentSkillId;
                    const skillContext = skillName
                      ? `当前正在编辑的技能名称: ${skillName}\n\n`
                      : '';

                    // 记录选中范围，用于后续 AI 响应完成后自动应用修改
                    pendingReplaceRangeRef.current = { from: selection.from, to: selection.to };

                    // 直接发送消息
                    const fullMessage = `${skillContext}${message}\n\n${t('Selected content')}:\n\`\`\`\n${selection.text}\n\`\`\``;

                    const userMsg: Message = {
                      id: `msg-${Date.now()}`,
                      role: 'user',
                      content: fullMessage,
                      timestamp: new Date().toISOString(),
                    };
                    setLoadedMessages((prev) => [...prev, userMsg]);
                    setSelection(null);
                    setShowSelectionMenu(false);
                    initSkillSessionState(currentConversationId);

                    api
                      .skillConversationSend(currentConversationId, fullMessage)
                      .then((sendResult) => {
                        if (!sendResult.success) {
                          setError(sendResult.error || 'Failed to send message');
                        }
                        // 不再调用 loadConversation，因为 SSE 事件会自动更新消息
                        // 如果调用 loadConversation，可能会覆盖本地添加的用户消息
                      })
                      .catch((e) => {
                        setError(e instanceof Error ? e.message : 'Failed to send message');
                      });
                  }}
                />
              )}
            </div>
          </div>
        </div>

        {/* 右侧：对话面板 */}
        {agentPanelOpen && (
          <div
            className="flex flex-col border-l border-border bg-background relative"
            style={{ width: `${rightPanelWidth}px`, minWidth: '280px', maxWidth: '500px' }}
          >
            {/* 拖动手柄 */}
            <div
              ref={panelResizeRef}
              onMouseDown={handlePanelMouseDown}
              className={`absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize z-10 hover:bg-primary/50 transition-colors ${
                isResizingPanel ? 'bg-primary' : 'bg-transparent'
              }`}
            >
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 hover:opacity-100 transition-opacity">
                <GripVertical className="w-3 h-3 text-muted-foreground" />
              </div>
            </div>

            {/* 头部 */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <div
                  className={`w-2 h-2 rounded-full ${isGenerating ? 'bg-green-500 animate-pulse' : error ? 'bg-red-500' : 'bg-gray-400'}`}
                />
                <Bot className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium">skill-creator</span>
              </div>
              <button onClick={handleClosePanel} className="p-1.5 hover:bg-secondary rounded-lg">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 消息列表 */}
            <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.length === 0 && !isGenerating ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <Bot className="w-10 h-10 mb-2 opacity-30" />
                  <p className="text-sm">{t('Starting...')}</p>
                </div>
              ) : (
                <>
                  {messages.map((msg, msgIdx) => {
                    const isLastAssistantMsg =
                      msg.role === 'assistant' && msgIdx === messages.length - 1 && !msg.content;
                    if (isLastAssistantMsg && isGenerating) return null;

                    return (
                      <div
                        key={msg.id}
                        className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={`max-w-[85%] px-3 py-2 rounded-lg text-sm ${
                            msg.role === 'user'
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-secondary text-foreground'
                          }`}
                        >
                          {msg.role === 'assistant' &&
                            msg.thoughts &&
                            msg.thoughts.length > 0 &&
                            renderThoughts(msg.thoughts, false)}
                          {/* 渲染消息内容（使用 metadata 中的会话信息渲染折叠卡片） */}
                          {msg.role === 'user' &&
                          ((msg.metadata as any)?.selectedConversations ||
                            (msg.metadata as any)?.sourceWebpages) ? (
                            renderMessageContent(msg)
                          ) : (
                            <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {(isGenerating || streamingContent || thoughts.length > 0) && (
                    <div className="flex justify-start">
                      <div className="max-w-[85%] px-3 py-2 rounded-lg text-sm bg-secondary text-foreground">
                        {renderThoughts(thoughts, isGenerating && isStreaming)}
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
                      e.preventDefault();
                      handleSendMessage();
                    }
                  }}
                  placeholder={t('Continue conversation...')}
                  className="flex-1 px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  disabled={isGenerating || !currentConversationId}
                />
                <button
                  onClick={handleSendMessage}
                  disabled={isGenerating || !userInput.trim() || !currentConversationId}
                  className={`px-3 py-2 rounded-lg ${
                    isGenerating || !userInput.trim() || !currentConversationId
                      ? 'bg-primary/50 cursor-not-allowed'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90'
                  }`}
                >
                  {isGenerating ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </button>
              </div>
              {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ============================================
// 子组件：CodeEditor with streaming
// ============================================

interface SkillCodeEditorProps {
  content: string;
  language?: string;
  readOnly?: boolean;
  onChange?: (content: string) => void;
  onSelectionChange?: (selection: SelectionState | null) => void;
  streamingContent?: string;
  isStreaming?: boolean;
  /** 待替换的选中范围（用于AI修改选中内容时实时更新） */
  pendingReplaceRange?: { from: number; to: number } | null;
  /** 替换完成后的回调 */
  onReplaceComplete?: (newContent: string) => void;
}

const SkillCodeEditor = forwardRef<CodeMirrorEditorRef, SkillCodeEditorProps>(
  function SkillCodeEditor(
    {
      content,
      language,
      readOnly = false,
      onChange,
      onSelectionChange,
      streamingContent,
      isStreaming,
      pendingReplaceRange,
      onReplaceComplete,
    },
    ref,
  ) {
    const internalRef = useRef<CodeMirrorEditorRef>(null);
    const lastStreamingContentRef = useRef('');
    const lastExtractedCodeRef = useRef('');
    const hasReplacedRef = useRef(false);

    useEffect(() => {
      if (streamingContent && streamingContent !== lastStreamingContentRef.current) {
        const view = internalRef.current?.getView();
        if (view) {
          // 如果有待替换的范围，实时提取代码块并替换
          if (pendingReplaceRange && !hasReplacedRef.current) {
            // 从流式内容中提取代码块
            const codeBlockMatch = streamingContent.match(/```[\w]*\n([\s\S]*?)```/);
            if (codeBlockMatch && codeBlockMatch[1]) {
              const newCode = codeBlockMatch[1].trim();
              // 只有当代码块内容变化时才更新
              if (newCode !== lastExtractedCodeRef.current) {
                lastExtractedCodeRef.current = newCode;
                view.dispatch({
                  changes: {
                    from: pendingReplaceRange.from,
                    to: pendingReplaceRange.to,
                    insert: newCode,
                  },
                });
                // 通知父组件内容已更新
                if (onReplaceComplete) {
                  const updatedContent = view.state.doc.toString();
                  onReplaceComplete(updatedContent);
                }
              }
            }
          } else {
            // 没有待替换范围，追加到末尾
            const delta = streamingContent.slice(lastStreamingContentRef.current.length);
            if (delta) {
              const currentContent = view.state.doc.toString();
              view.dispatch({
                changes: { from: currentContent.length, insert: delta },
              });
            }
          }
          lastStreamingContentRef.current = streamingContent;
        }
      }
    }, [streamingContent, pendingReplaceRange, onReplaceComplete]);

    // 当 pendingReplaceRange 变为 null 时，重置标记
    useEffect(() => {
      if (!pendingReplaceRange) {
        hasReplacedRef.current = false;
        lastExtractedCodeRef.current = '';
      }
    }, [pendingReplaceRange]);

    useEffect(() => {
      const view = internalRef.current?.getView();
      if (!view || !onSelectionChange) return;

      const handleMouseUp = (event: MouseEvent) => {
        const selection = view.state.selection.main;
        if (selection.from !== selection.to) {
          const text = view.state.doc.sliceString(selection.from, selection.to);
          const lineFrom = view.state.doc.lineAt(selection.from).number;
          const lineTo = view.state.doc.lineAt(selection.to).number;

          // 计算菜单位置 - 显示在选中内容上方，避免遮挡
          let menuX = event.clientX;
          let menuY = event.clientY;

          try {
            const coordsStart = view.coordsAtPos(selection.from);
            const coordsEnd = view.coordsAtPos(selection.to);
            if (coordsStart) {
              const editorRect = view.dom.getBoundingClientRect();
              menuX = coordsStart.left - editorRect.left;
              // 计算选中区域高度，将菜单放在上方
              const selectionHeight = coordsEnd ? coordsEnd.bottom - coordsStart.top : 20;
              // 菜单高度约 100px，放在选中内容上方
              menuY = coordsStart.top - editorRect.top - 105; // 在选择上方，留出菜单高度空间
              // 如果上方空间不够，则放在下方
              if (menuY < 10) {
                menuY = coordsEnd.bottom - editorRect.top + 5;
              }
            }
          } catch {
            // 使用鼠标位置作为后备
            const editorRect = view.dom.getBoundingClientRect();
            menuX = event.clientX - editorRect.left;
            menuY = event.clientY - editorRect.top - 110; // 尝试放在鼠标上方
          }

          onSelectionChange({
            text,
            from: selection.from,
            to: selection.to,
            lineFrom,
            lineTo,
            menuX,
            menuY,
          });
        } else {
          onSelectionChange(null);
        }
      };

      view.dom.addEventListener('mouseup', handleMouseUp);
      return () => view.dom.removeEventListener('mouseup', handleMouseUp);
    }, [onSelectionChange]);

    return (
      <CodeMirrorEditor
        ref={(editorRef) => {
          (internalRef as any).current = editorRef;
          if (typeof ref === 'function') {
            ref(editorRef);
          } else if (ref) {
            ref.current = editorRef;
          }
        }}
        content={content}
        language={language}
        readOnly={readOnly || isStreaming}
        onChange={onChange}
        className="h-full"
      />
    );
  },
);

// ============================================
// 子组件：SelectionMenu
// ============================================

interface SelectionMenuProps {
  position: { x: number; y: number };
  selection: SelectionState;
  onAction: (action: string, customInput?: string) => void;
  onClose: () => void;
  /** 直接发送消息（不需要填入右侧输入框） */
  onSendDirectly: (message: string) => void;
}

function SelectionMenu({ position, onAction, onClose, onSendDirectly }: SelectionMenuProps) {
  const { t } = useTranslation();
  const [customInput, setCustomInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // 自动聚焦输入框
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 处理直接发送
  const handleSendDirectly = () => {
    if (customInput.trim()) {
      onSendDirectly(customInput.trim());
      onClose();
    }
  };

  // 处理快捷按钮
  const handleQuickAction = (action: string) => {
    const prompts: Record<string, string> = {
      modify: t('Please modify the selected content:'),
      explain: t('Please explain the selected content:'),
      optimize: t('Please optimize the selected content:'),
      extend: t('Please extend the selected content:'),
    };
    const prompt = prompts[action] || action;
    if (customInput.trim()) {
      // 如果有自定义输入，组合成完整消息直接发送
      onSendDirectly(`${prompt}\n\n${t('User requirement')}: ${customInput.trim()}`);
    } else {
      // 否则只发送快捷提示
      onSendDirectly(prompt);
    }
    onClose();
  };

  // 处理键盘事件
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendDirectly();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div
      className="absolute z-50 bg-background border border-border rounded-lg shadow-lg py-2 min-w-[280px]"
      style={{ left: position.x, top: position.y }}
    >
      {/* 快捷按钮行 */}
      <div className="flex gap-1 px-2 pb-2 border-b border-border mb-2">
        <button
          onClick={() => handleQuickAction('modify')}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-secondary/50"
          title={t('Modify selected content')}
        >
          <Wrench className="w-3 h-3" />
          {t('Modify')}
        </button>
        <button
          onClick={() => handleQuickAction('explain')}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-secondary/50"
          title={t('Explain selected content')}
        >
          <Lightbulb className="w-3 h-3" />
          {t('Explain')}
        </button>
        <button
          onClick={() => handleQuickAction('optimize')}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-secondary/50"
          title={t('Optimize selected content')}
        >
          <Sparkles className="w-3 h-3" />
          {t('Optimize')}
        </button>
        <button
          onClick={() => handleQuickAction('extend')}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-secondary/50"
          title={t('Extend selected content')}
        >
          <Brain className="w-3 h-3" />
          {t('Extend')}
        </button>
      </div>

      {/* 自定义输入框 */}
      <div className="px-2">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('Describe how you want to modify...')}
            className="flex-1 px-2 py-1.5 text-sm bg-secondary/30 border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={handleSendDirectly}
            disabled={!customInput.trim()}
            className="px-2 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            title={t('Send directly')}
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {t('Press Enter to send, Escape to close')}
        </p>
      </div>
    </div>
  );
}

export default SkillEditorPage;
