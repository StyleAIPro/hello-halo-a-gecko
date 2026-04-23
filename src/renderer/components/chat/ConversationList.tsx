/**
 * Conversation List - Resizable sidebar for multiple conversations
 * Self-contained: subscribes to its own data from stores, no data props from parent.
 * Supports drag-to-resize, inline title editing, and conversation management.
 */

import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import { Virtuoso } from 'react-virtuoso';
import { MessageSquare, Plus } from '../icons/ToolIcons';
import {
  ChevronLeft,
  ChevronRight,
  EllipsisVertical,
  Pin,
  Pencil,
  Trash2,
  Download,
  Square,
  Wrench,
} from 'lucide-react';
import { useTranslation } from '../../i18n';
import { useChatStore, useConversationStatusDetails } from '../../stores/chat.store';
import type { ConversationStatusDetail, WorkerConversationMeta } from '../../stores/chat.store';
import { useSpaceStore } from '../../stores/space.store';
import { useAppStore } from '../../stores/app.store';
import { api } from '../../api';
import { TaskStatusDot } from '../pulse/TaskStatusDot';
import { AutomationBadge } from '../apps/AutomationBadge';
import type { ConversationMeta } from '../../types';
import { exportConversationAsMarkdown } from '../../utils/conversation-export';

// Width constraints (in pixels)
const MIN_WIDTH = 140;
const MAX_WIDTH = 360;
const DEFAULT_WIDTH = 260;
const clampWidth = (v: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v));

/** Format elapsed time from a start timestamp */
function formatElapsed(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

const STATUS_LABEL: Record<string, string> = {
  generating: 'Generating...',
  waiting: 'Waiting for input',
  'completed-unseen': 'Completed',
  error: 'Error',
};

// ─── WorkerConversationItem (shown under parent conversations) ───

interface WorkerItemProps {
  worker: WorkerConversationMeta;
  parentConvId: string;
  isExpanded: boolean;
}

const WorkerConversationItem = memo(function WorkerConversationItem({
  worker,
  parentConvId,
  isExpanded,
}: WorkerItemProps) {
  const { t } = useTranslation();
  const spaceId = useSpaceStore.getState().currentSpace?.id;

  const handleSelect = useCallback(() => {
    if (!spaceId) return;
    // Select the parent conversation first, then the worker tab
    useChatStore.getState().selectConversation(parentConvId);
    // After selection, the WorkerTabBar will be visible and user can click the worker tab
    // We also set the active worker tab via a store action if available
  }, [spaceId, parentConvId]);

  return (
    <div
      onClick={handleSelect}
      className="w-full pl-8 pr-3 py-1.5 text-left hover:bg-secondary/30 transition-colors cursor-pointer group"
    >
      <div className="flex items-center gap-1.5">
        <Wrench size={11} className="text-blue-400/70 flex-shrink-0" />
        <span className="text-xs text-muted-foreground truncate flex-1">{worker.title}</span>
        {worker.messageCount > 0 && (
          <span className="text-[10px] text-muted-foreground/50 flex-shrink-0">
            {worker.messageCount}
          </span>
        )}
      </div>
      {isExpanded && (
        <p className="text-[10px] text-muted-foreground/40 mt-0.5 pl-4">
          {worker.updatedAt ? new Date(worker.updatedAt).toLocaleDateString() : ''}
        </p>
      )}
    </div>
  );
});

// ─── ConversationItem (extracted as its own component for hooks) ───

interface ConversationItemProps {
  conversation: ConversationMeta;
  isCurrent: boolean;
  statusDetail: ConversationStatusDetail | undefined;
  isEditing: boolean;
  editValue: string;
  menuOpenId: string | null;
  workerConversations?: WorkerConversationMeta[];
  workersExpanded: boolean;
  onEditValueChange: (v: string) => void;
  onEditKeyDown: (e: React.KeyboardEvent) => void;
  onEditSave: () => void;
  onSelect: () => void;
  onMenuToggle: (e: React.MouseEvent) => void;
  onMenuClose: () => void;
  onToggleWorkers: () => void;
}

const ConversationItem = memo(function ConversationItem({
  conversation,
  isCurrent,
  statusDetail,
  isEditing,
  editValue,
  menuOpenId,
  workerConversations,
  workersExpanded,
  onEditValueChange,
  onEditKeyDown,
  onEditSave,
  onSelect,
  onMenuToggle,
  onMenuClose,
  onToggleWorkers,
}: ConversationItemProps) {
  const { t } = useTranslation();
  const editInputRef = useRef<HTMLInputElement>(null);
  const [elapsed, setElapsed] = useState('');

  const status = statusDetail?.status ?? 'idle';
  const isActive = status === 'generating' || status === 'waiting';
  const hasWorkers = workerConversations && workerConversations.length > 0;

  // Live elapsed timer for generating tasks
  useEffect(() => {
    if (!statusDetail?.generatingStartedAt || status !== 'generating') {
      setElapsed('');
      return;
    }
    setElapsed(formatElapsed(statusDetail.generatingStartedAt));
    const timer = setInterval(() => {
      setElapsed(formatElapsed(statusDetail.generatingStartedAt!));
    }, 1000);
    return () => clearInterval(timer);
  }, [statusDetail?.generatingStartedAt, status]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [isEditing]);

  // Format date
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) return t('Today');
    return `${date.getMonth() + 1}-${date.getDate()}`;
  };

  return (
    <>
      <div
        onClick={() => !isEditing && onSelect()}
        className={`w-full px-3 py-2 text-left hover:bg-secondary/50 transition-colors cursor-pointer group relative ${
          isCurrent ? 'bg-primary/10 border-l-2 border-primary' : ''
        }`}
      >
        {/* Edit mode */}
        {isEditing ? (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <input
              ref={editInputRef}
              type="text"
              value={editValue}
              onChange={(e) => onEditValueChange(e.target.value)}
              onKeyDown={onEditKeyDown}
              onBlur={onEditSave}
              className="flex-1 text-sm bg-input border border-border rounded px-2 py-1 focus:outline-none focus:border-primary min-w-0"
              placeholder={t('Conversation title...')}
            />
            <button
              onClick={onEditSave}
              className="p-1 hover:bg-primary/20 text-primary rounded transition-colors flex-shrink-0"
              title={t('Save')}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </button>
          </div>
        ) : (
          <>
            {/* Unseen completion highlight — subtle background */}
            <div className={`flex items-center gap-2 relative`}>
              <TaskStatusDot status={status} size="sm" />
              <span
                className={`text-sm truncate flex-1 ${
                  status === 'completed-unseen' ? 'font-medium text-foreground' : ''
                }`}
              >
                {conversation.title}
              </span>

              {/* Unseen badge */}
              {status === 'completed-unseen' && (
                <span className="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-green-500/15 text-green-600 border border-green-500/20">
                  {t('New')}
                </span>
              )}

              {/* Elapsed time */}
              {elapsed && (
                <span className="font-mono text-[11px] text-muted-foreground/80 tabular-nums flex-shrink-0">
                  {elapsed}
                </span>
              )}

              {/* Workers expand/collapse button */}
              {hasWorkers && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleWorkers();
                  }}
                  className="p-0.5 text-muted-foreground/50 hover:text-muted-foreground rounded transition-colors flex-shrink-0"
                  title={t('Workers')}
                >
                  <ChevronRight
                    size={12}
                    className={`transition-transform duration-150 ${workersExpanded ? 'rotate-90' : ''}`}
                  />
                </button>
              )}

              {/* Stop button (generating) or More button (idle/other) */}
              {status === 'generating' ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    useChatStore.getState().stopGeneration(conversation.id);
                  }}
                  className="p-1 text-muted-foreground hover:text-destructive hover:bg-secondary rounded-md transition-colors flex-shrink-0"
                  title={t('Stop')}
                >
                  <Square className="w-3 h-3" />
                </button>
              ) : (
                <>
                  {/* More button — show on hover, or when menu is open */}
                  {menuOpenId === conversation.id ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onMenuClose();
                      }}
                      className="px-1.5 py-1 rounded bg-secondary text-foreground flex-shrink-0"
                      title={t('More')}
                    >
                      <EllipsisVertical className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button
                      onClick={onMenuToggle}
                      className="px-1.5 py-1 rounded transition-colors bg-secondary text-foreground/80 hover:text-foreground hover:bg-secondary flex-shrink-0 opacity-0 group-hover:opacity-100"
                      title={t('More')}
                    >
                      <EllipsisVertical className="w-3.5 h-3.5" />
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Row 2: Status info for active conversations */}
            {statusDetail && status !== 'idle' && (
              <div className="flex items-center gap-1.5 mt-0.5 ml-5">
                <span
                  className={`text-xs ${
                    status === 'waiting'
                      ? 'text-yellow-500'
                      : status === 'error'
                        ? 'text-red-500'
                        : status === 'completed-unseen'
                          ? 'text-green-500'
                          : status === 'generating'
                            ? 'text-blue-500'
                            : 'text-muted-foreground'
                  }`}
                >
                  {t(STATUS_LABEL[status] ?? status)}
                </span>

                {/* Current action */}
                {statusDetail.currentAction && (
                  <>
                    <span className="text-muted-foreground/30 text-xs">·</span>
                    <span className="text-xs text-muted-foreground truncate">
                      {statusDetail.currentAction}
                    </span>
                  </>
                )}

                {/* Step count */}
                {statusDetail.totalSteps > 0 && (
                  <>
                    <span className="text-muted-foreground/30 text-xs">·</span>
                    <span className="text-xs text-muted-foreground">
                      {statusDetail.completedSteps}/{statusDetail.totalSteps} {t('steps')}
                    </span>
                  </>
                )}
              </div>
            )}

            {/* Date row (only show for idle conversations or when no status detail) */}
            {(!statusDetail || status === 'idle') && (
              <p className="text-xs text-muted-foreground mt-1 ml-5">
                {formatDate(conversation.updatedAt)}
              </p>
            )}
          </>
        )}
      </div>

      {/* Worker conversations (collapsible, indented under parent) */}
      {hasWorkers && workersExpanded && (
        <div className="border-l border-border/30 ml-3 bg-secondary/10">
          {workerConversations!.map((worker) => (
            <WorkerConversationItem
              key={worker.id}
              worker={worker}
              parentConvId={conversation.id}
              isExpanded={isCurrent}
            />
          ))}
        </div>
      )}
    </>
  );
});

// ─── ConversationList ───

interface ConversationListProps {
  onClose?: () => void;
  /** Whether the sidebar is currently visible */
  visible?: boolean;
}

export const ConversationList = memo(function ConversationList({
  onClose,
  visible = true,
}: ConversationListProps) {
  const { t } = useTranslation();

  // Self-subscribe to data from stores (precise selectors)
  const conversations = useChatStore((state) => {
    const spaceState = state.spaceStates.get(state.currentSpaceId ?? '');
    return spaceState?.conversations ?? [];
  });
  const workerConversations = useChatStore((state) => {
    const spaceState = state.spaceStates.get(state.currentSpaceId ?? '');
    return spaceState?.workerConversations ?? new Map();
  });
  const currentConversationId = useChatStore((state) => {
    const spaceState = state.spaceStates.get(state.currentSpaceId ?? '');
    return spaceState?.currentConversationId ?? undefined;
  });
  const layoutConfig = useAppStore((state) => state.config?.layout);
  const currentSpace = useSpaceStore((state) => state.currentSpace);
  const isHyperSpace = currentSpace?.spaceType === 'hyper';

  // Detailed status for all conversations (includes steps, action, time)
  const statusDetails = useConversationStatusDetails();

  // Width state - initialized from persisted config
  const initialWidth = layoutConfig?.sidebarWidth;
  const [width, setWidth] = useState(
    initialWidth != null ? clampWidth(initialWidth) : DEFAULT_WIDTH,
  );
  const [isDragging, setIsDragging] = useState(false);
  const widthRef = useRef(width);

  // Track which conversation's workers are expanded
  const [workersExpandedId, setWorkersExpandedId] = useState<string | null>(null);

  // Sync width when config arrives asynchronously
  useEffect(() => {
    if (initialWidth !== undefined && !isDragging) {
      const clamped = clampWidth(initialWidth);
      setWidth(clamped);
      widthRef.current = clamped;
    }
  }, [initialWidth, isDragging]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Handle drag resize
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const newWidth = e.clientX - containerRect.left;
      const clampedWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, newWidth));
      setWidth(clampedWidth);
      widthRef.current = clampedWidth;
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      const currentConfig = useAppStore.getState().config;
      if (currentConfig) {
        useAppStore
          .getState()
          .updateConfig({ layout: { ...currentConfig.layout, sidebarWidth: widthRef.current } });
      }
      api
        .setConfig({ layout: { sidebarWidth: widthRef.current } })
        .catch((err) => console.error('[ConversationList] Failed to persist sidebar width:', err));
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // Close dropdown menu on outside click
  useEffect(() => {
    if (!menuOpenId) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
        setMenuPosition(null);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [menuOpenId]);

  // Reset menu state when conversations change (e.g. space switch)
  useEffect(() => {
    setMenuOpenId(null);
    setMenuPosition(null);
  }, [conversations]);

  // Save edited title
  const handleSaveEdit = useCallback(() => {
    if (editingId && editingTitle.trim()) {
      const spaceId = useSpaceStore.getState().currentSpace?.id;
      if (spaceId) {
        useChatStore.getState().renameConversation(spaceId, editingId, editingTitle.trim());
      }
    }
    setEditingId(null);
    setEditingTitle('');
  }, [editingId, editingTitle]);

  // Handle input key events
  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSaveEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setEditingId(null);
        setEditingTitle('');
      }
    },
    [handleSaveEdit],
  );

  // Menu toggle handler
  const handleMenuToggle = useCallback(
    (conversationId: string) => (e: React.MouseEvent) => {
      e.stopPropagation();
      if (menuOpenId === conversationId) {
        setMenuOpenId(null);
        setMenuPosition(null);
      } else {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const MENU_HEIGHT_ESTIMATE = 120;
        const spaceBelow = window.innerHeight - rect.bottom - 4;
        const top =
          spaceBelow >= MENU_HEIGHT_ESTIMATE
            ? rect.bottom + 4
            : Math.max(4, rect.top - MENU_HEIGHT_ESTIMATE - 4);
        setMenuPosition({ top, left: rect.right });
        setMenuOpenId(conversationId);
      }
    },
    [menuOpenId],
  );

  // Toggle workers expansion for a conversation
  const handleToggleWorkers = useCallback((conversationId: string) => {
    setWorkersExpandedId((prev) => (prev === conversationId ? null : conversationId));
  }, []);

  // Render a single conversation item (used by Virtuoso)
  const renderConversationItem = useCallback(
    (conversation: ConversationMeta) => (
      <ConversationItem
        conversation={conversation}
        isCurrent={conversation.id === currentConversationId}
        statusDetail={statusDetails.get(conversation.id)}
        isEditing={editingId === conversation.id}
        editValue={editingTitle}
        menuOpenId={menuOpenId}
        workerConversations={isHyperSpace ? workerConversations.get(conversation.id) : undefined}
        workersExpanded={workersExpandedId === conversation.id}
        onEditValueChange={setEditingTitle}
        onEditKeyDown={handleEditKeyDown}
        onEditSave={handleSaveEdit}
        onSelect={() =>
          editingId !== conversation.id &&
          useChatStore.getState().selectConversation(conversation.id)
        }
        onMenuToggle={handleMenuToggle(conversation.id)}
        onMenuClose={() => {
          setMenuOpenId(null);
          setMenuPosition(null);
        }}
        onToggleWorkers={() => handleToggleWorkers(conversation.id)}
      />
    ),
    [
      currentConversationId,
      statusDetails,
      editingId,
      editingTitle,
      menuOpenId,
      isHyperSpace,
      workerConversations,
      workersExpandedId,
      handleEditKeyDown,
      handleSaveEdit,
      handleMenuToggle,
      handleToggleWorkers,
    ],
  );

  return (
    <>
      <div
        ref={containerRef}
        className="border-r border-border flex flex-col bg-card/50 relative"
        style={{ width, transition: isDragging ? 'none' : 'width 0.2s ease' }}
      >
        {/* Header */}
        <div className="p-3 border-b border-border flex items-center justify-between">
          <span className="text-sm font-medium text-muted-foreground">{t('Conversations')}</span>
          {onClose && (
            <button
              onClick={onClose}
              className="relative p-1 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-foreground before:content-[''] before:absolute before:-inset-2"
              title={t('Close sidebar')}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Automation apps status badge — quick jump to AppsPage */}
        <AutomationBadge />

        {/* Conversation list - virtualized for performance with large lists */}
        <div className="flex-1 overflow-hidden">
          <Virtuoso
            data={conversations}
            overscan={200}
            itemContent={(_index, conversation) => renderConversationItem(conversation)}
          />
        </div>

        {/* New conversation button */}
        <div className="p-2 border-t border-border">
          <button
            onClick={() => {
              const spaceId = useSpaceStore.getState().currentSpace?.id;
              if (spaceId) useChatStore.getState().createConversation(spaceId);
            }}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t('New conversation')}
          </button>
        </div>

        {/* Drag handle - on right side */}
        <div
          className={`absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/50 transition-colors z-20 ${
            isDragging ? 'bg-primary/50' : ''
          }`}
          onMouseDown={handleMouseDown}
          title={t('Drag to resize width')}
        />
      </div>

      {/* Dropdown menu — Portal to document.body, fully outside flex layout */}
      {menuOpenId &&
        menuPosition &&
        (() => {
          const conv = conversations.find((c) => c.id === menuOpenId);
          if (!conv) return null;
          return createPortal(
            <div
              ref={menuRef}
              className="fixed z-[9999] min-w-[140px] bg-popover border border-border rounded-lg shadow-lg py-1"
              style={{
                top: menuPosition.top,
                left: menuPosition.left,
                transform: 'translateX(-100%)',
              }}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const spaceId = useSpaceStore.getState().currentSpace?.id;
                  if (spaceId)
                    useChatStore.getState().toggleStarConversation(spaceId, conv.id, !conv.starred);
                  setMenuOpenId(null);
                  setMenuPosition(null);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary transition-colors"
              >
                <Pin className={`w-3.5 h-3.5 ${conv.starred ? 'text-primary' : ''}`} />
                <span>{conv.starred ? t('Unpin') : t('Pin')}</span>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingId(conv.id);
                  setEditingTitle(conv.title || '');
                  setMenuOpenId(null);
                  setMenuPosition(null);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary transition-colors"
              >
                <Pencil className="w-3.5 h-3.5" />
                <span>{t('Rename')}</span>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpenId(null);
                  setMenuPosition(null);
                  const spaceId = useSpaceStore.getState().currentSpace?.id;
                  if (spaceId)
                    exportConversationAsMarkdown(spaceId, conv.id).catch((err) =>
                      console.error('Export failed:', err),
                    );
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{t('Export conversation')}</span>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const spaceId = useSpaceStore.getState().currentSpace?.id;
                  if (spaceId) useChatStore.getState().deleteConversation(spaceId, conv.id);
                  setMenuOpenId(null);
                  setMenuPosition(null);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{t('Delete')}</span>
              </button>
            </div>,
            document.body,
          );
        })()}
    </>
  );
});
