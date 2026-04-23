/**
 * TaskCard - Expandable task progress card for Pulse monitoring
 *
 * Shows real-time progress of an active Claude conversation:
 * - Compact mode: title, status, current action, elapsed time
 * - Expanded mode: adds step-by-step progress list
 *
 * Used by PulseList to render each active task.
 */

import { useState, useEffect, useCallback, memo } from 'react';
import { Star, Square, ChevronDown, ChevronRight, Loader2, CheckCircle2 } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { useChatStore } from '../../stores/chat.store';
import { TaskStatusDot } from './TaskStatusDot';
import { navigateToConversation } from './PulseList';
import type { PulseItem, TaskStatus } from '../../types';

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

const STATUS_LABEL: Record<TaskStatus, string> = {
  generating: 'Generating...',
  waiting: 'Waiting for input',
  'completed-unseen': 'Completed',
  error: 'Error',
  idle: 'Pinned',
};

interface TaskCardProps {
  item: PulseItem;
  /** Callback after item is clicked (e.g. to close a panel) */
  onItemClick?: () => void;
  /** Whether to render in compact mode (smaller padding) */
  compact?: boolean;
}

export const TaskCard = memo(function TaskCard({
  item,
  onItemClick,
  compact = false,
}: TaskCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState<string>('');

  // Update elapsed time every second when generating
  useEffect(() => {
    if (!item.generatingStartedAt || item.status !== 'generating') {
      setElapsed('');
      return;
    }

    setElapsed(formatElapsed(item.generatingStartedAt));
    const timer = setInterval(() => {
      setElapsed(formatElapsed(item.generatingStartedAt!));
    }, 1000);

    return () => clearInterval(timer);
  }, [item.generatingStartedAt, item.status]);

  const handleClick = useCallback(() => {
    navigateToConversation(item.spaceId, item.conversationId);
    onItemClick?.();
  }, [item.spaceId, item.conversationId, onItemClick]);

  const handleTogglePin = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      useChatStore
        .getState()
        .toggleStarConversation(item.spaceId, item.conversationId, !item.starred);
    },
    [item.spaceId, item.conversationId, item.starred],
  );

  const handleStop = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      useChatStore.getState().stopGeneration(item.conversationId);
    },
    [item.conversationId],
  );

  const handleToggleExpand = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded((prev) => !prev);
  }, []);

  const isActive = item.status === 'generating' || item.status === 'waiting';
  const isRead = !!item.readAt;
  const hasProgressInfo = !!(item.currentAction || item.completedSteps);
  const showSteps = expanded && item.totalSteps != null && item.totalSteps > 0;

  return (
    <div
      onClick={handleClick}
      className={`px-3 py-2 border-b border-border/30 cursor-pointer transition-colors ${
        isRead ? 'opacity-50' : 'hover:bg-secondary/30'
      }`}
    >
      {/* Row 1: Status dot + Title + Time + Buttons */}
      <div className="flex items-center gap-2">
        <TaskStatusDot status={item.status} size="md" />

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate text-foreground">{item.title}</p>
        </div>

        {/* Elapsed time */}
        {elapsed && (
          <span className="font-mono text-[11px] text-muted-foreground/80 tabular-nums flex-shrink-0">
            {elapsed}
          </span>
        )}

        {/* Stop button (only when generating) */}
        {item.status === 'generating' && (
          <button
            onClick={handleStop}
            className="p-1 text-muted-foreground hover:text-destructive hover:bg-secondary rounded-md transition-colors flex-shrink-0"
            title={t('Stop')}
          >
            <Square className="w-3 h-3" />
          </button>
        )}

        {/* Pin toggle */}
        <button
          onClick={handleTogglePin}
          className={`p-1 rounded transition-colors flex-shrink-0 ${
            item.starred
              ? 'text-yellow-500 hover:text-yellow-400'
              : 'text-muted-foreground/40 hover:text-yellow-500'
          }`}
          title={item.starred ? t('Unpin') : t('Pin')}
        >
          <Star className={`w-3.5 h-3.5 ${item.starred ? 'fill-current' : ''}`} />
        </button>
      </div>

      {/* Row 2: Space name + Status + Action summary */}
      {(hasProgressInfo || item.status !== 'idle') && (
        <div className="flex items-center gap-1.5 mt-0.5 ml-5">
          <span className="text-xs text-muted-foreground truncate">{item.spaceName}</span>
          <span className="text-muted-foreground/30 text-xs">·</span>
          <span
            className={`text-xs ${
              item.status === 'waiting'
                ? 'text-yellow-500'
                : item.status === 'error'
                  ? 'text-red-500'
                  : item.status === 'completed-unseen'
                    ? 'text-green-500'
                    : item.status === 'generating'
                      ? 'text-blue-500'
                      : 'text-muted-foreground'
            }`}
          >
            {t(STATUS_LABEL[item.status])}
          </span>

          {/* Current action */}
          {item.currentAction && (
            <>
              <span className="text-muted-foreground/30 text-xs">·</span>
              <span className="text-xs text-muted-foreground truncate">{item.currentAction}</span>
            </>
          )}

          {/* Step count */}
          {item.completedSteps != null && item.totalSteps != null && item.totalSteps > 0 && (
            <>
              <span className="text-muted-foreground/30 text-xs">·</span>
              <button
                onClick={handleToggleExpand}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-0.5"
              >
                {expanded ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
                {item.completedSteps}/{item.totalSteps} {t('steps')}
              </button>
            </>
          )}
        </div>
      )}

      {/* Expanded: Step progress (placeholder for future enhancement) */}
      {showSteps && (
        <div className="mt-1.5 ml-5 space-y-0.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="w-3 h-3 text-green-400" />
            <span className="truncate">{item.completedSteps} completed</span>
          </div>
          {item.currentAction && (
            <div className="flex items-center gap-1.5 text-xs text-blue-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="truncate">{item.currentAction}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
