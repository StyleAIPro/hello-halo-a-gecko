/**
 * TaskMonitorCard - Background task monitor visualization
 *
 * When Claude creates a Digital Human (automation app) to monitor a long-running task,
 * this card is embedded in the conversation to show real-time status.
 *
 * Features:
 * - Real-time status from appsStore (running/idle/error/completed)
 * - Recent activity entries summary
 * - "Continue" button to resume Claude with task results
 * - "View details" button to navigate to AppsPage
 *
 * Design: Clean, minimal card that persists in the conversation thread,
 * similar to BrowserTaskCard but optimized for long-running background tasks.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Bot,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Pause,
  Clock,
  ExternalLink,
  Play,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useAppsStore } from '../../stores/apps.store';
import { useChatStore } from '../../stores/chat.store';
import { useAppStore } from '../../stores/app.store';
import { useAppsPageStore } from '../../stores/apps-page.store';
import type { AutomationAppState, ActivityEntry } from '../../../shared/apps/app-types';
import { useTranslation } from '../../i18n';

// ============================================
// Types
// ============================================

export interface TaskMonitorInfo {
  appId: string;
  taskName: string;
  description?: string;
  onCompletePrompt?: string; // Prompt to send to Claude when task completes
  isRemote?: boolean; // True if app was created by remote Claude
}

interface TaskMonitorCardProps {
  monitor: TaskMonitorInfo;
  isActive?: boolean; // True during streaming
}

// ============================================
// Constants
// ============================================

const TASK_MONITOR_TOOL_NAMES = [
  'mcp__aico-bot-apps__create_automation_app',
  'create_task_monitor',
];

const POLL_INTERVAL_MS = 15_000; // Poll app state every 15s

// ============================================
// Helpers
// ============================================

export function isTaskMonitorTool(toolName: string): boolean {
  return TASK_MONITOR_TOOL_NAMES.some((t) => toolName.includes(t));
}

/**
 * Extract TaskMonitorInfo from a tool_use thought.
 * The appId comes from the tool result (create_automation_app returns the app ID).
 */
export function extractTaskMonitorFromThought(thought: {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: { output?: string };
}): TaskMonitorInfo | null {
  if (!thought.toolName || !isTaskMonitorTool(thought.toolName)) return null;

  const input = thought.toolInput || {};
  const name = (input.name as string) || '';
  const description = (input.description as string) || '';
  const systemPrompt = (input.system_prompt as string) || '';

  // Only treat it as a task monitor if the system_prompt contains monitoring-related keywords
  // or if it's called through the dedicated create_task_monitor tool
  if (!isTaskMonitorTool(thought.toolName!) && thought.toolName !== 'create_task_monitor') {
    return null;
  }

  // Try to extract appId from tool result
  let appId = '';
  if (thought.toolResult?.output) {
    try {
      const output = JSON.parse(thought.toolResult.output);
      appId = output.appId || output.id || output.data?.id || '';
    } catch {
      // Try to parse as plain string ID
      appId = thought.toolResult.output.trim();
    }
  }

  // If no appId from result, try from input
  if (!appId) {
    appId = (input.app_id as string) || '';
  }

  if (!appId) return null;

  return {
    appId,
    taskName: name,
    description: description || undefined,
    onCompletePrompt: undefined, // Will be set by the calling context
  };
}

/**
 * Filter task monitor tool calls from thoughts list
 */
export function filterTaskMonitorThoughts(
  thoughts: Array<{
    type: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: { output?: string };
  }>,
): TaskMonitorInfo[] {
  return thoughts
    .filter((t) => t.type === 'tool_use')
    .map((t) => extractTaskMonitorFromThought(t))
    .filter((m): m is TaskMonitorInfo => m !== null);
}

/**
 * Filter task monitor tool calls from streaming thoughts (tool_use type)
 */
export function filterStreamingTaskMonitors(
  thoughts: Array<{
    type: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: { output?: string };
  }>,
): TaskMonitorInfo[] {
  return filterTaskMonitorThoughts(thoughts);
}

// ============================================
// Status Display Helpers
// ============================================

function getStatusConfig(state: AutomationAppState | undefined) {
  if (!state) {
    return {
      Icon: Bot,
      color: 'text-muted-foreground',
      bgColor: 'bg-muted/20',
      borderColor: 'border-border/50',
      labelKey: 'Loading...',
    };
  }

  switch (state.status) {
    case 'running':
      return {
        Icon: Loader2,
        color: 'text-primary',
        bgColor: 'bg-primary/10',
        borderColor: 'border-primary/30',
        spin: true,
        labelKey: 'Running',
      };
    case 'queued':
      return {
        Icon: Clock,
        color: 'text-amber-500',
        bgColor: 'bg-amber-500/10',
        borderColor: 'border-amber-500/30',
        labelKey: 'Queued',
      };
    case 'idle':
      return {
        Icon: Bot,
        color: 'text-blue-500',
        bgColor: 'bg-blue-500/10',
        borderColor: 'border-blue-500/30',
        labelKey: 'Idle',
      };
    case 'paused':
      return {
        Icon: Pause,
        color: 'text-muted-foreground',
        bgColor: 'bg-muted/20',
        borderColor: 'border-border/50',
        labelKey: 'Paused',
      };
    case 'waiting_user':
      return {
        Icon: AlertCircle,
        color: 'text-amber-500',
        bgColor: 'bg-amber-500/10',
        borderColor: 'border-amber-500/30',
        labelKey: 'Waiting for you',
      };
    case 'error':
      return {
        Icon: AlertCircle,
        color: 'text-red-500',
        bgColor: 'bg-red-500/10',
        borderColor: 'border-red-500/30',
        labelKey: 'Error',
      };
    default:
      return {
        Icon: Bot,
        color: 'text-muted-foreground',
        bgColor: 'bg-muted/20',
        borderColor: 'border-border/50',
        labelKey: 'Unknown',
      };
  }
}

/**
 * Format a timestamp to relative time string
 */
function formatRelativeTime(ts: number, t: (key: string) => string): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return t('just now');
  if (minutes < 60) return t('{{count}}m ago', { count: minutes });
  if (hours < 24) return t('{{count}}h ago', { count: hours });
  return t('{{count}}d ago', { count: days });
}

// ============================================
// Sub-components
// ============================================

/** Single activity entry in the compact log */
function ActivityLogItem({
  entry,
  t,
}: {
  entry: ActivityEntry;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const summary = entry.content?.summary || '';

  return (
    <div className="flex items-start gap-2 text-xs py-1">
      <div className="flex-shrink-0 mt-1">
        {entry.content?.status === 'error' ? (
          <AlertCircle size={12} className="text-red-500" />
        ) : entry.content?.status === 'ok' ? (
          <CheckCircle2 size={12} className="text-green-500" />
        ) : (
          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 mt-0.5" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-muted-foreground break-words">{summary}</span>
      </div>
      <span className="text-muted-foreground/50 flex-shrink-0">
        {entry.ts ? formatRelativeTime(entry.ts, t) : ''}
      </span>
    </div>
  );
}

// ============================================
// Main Component
// ============================================

export function TaskMonitorCard({ monitor, isActive }: TaskMonitorCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { t } = useTranslation();

  // Get app state from store
  const appState = useAppsStore((state) => state.appStates[monitor.appId]);
  const activityEntries = useAppsStore((state) => state.activityEntries[monitor.appId]);
  const loadAppState = useAppsStore((state) => state.loadAppState);
  const loadActivity = useAppsStore((state) => state.loadActivity);
  const pauseApp = useAppsStore((state) => state.pauseApp);
  const resumeApp = useAppsStore((state) => state.resumeApp);
  const triggerApp = useAppsStore((state) => state.triggerApp);
  const deleteApp = useAppsStore((state) => state.deleteApp);

  // App navigation
  const setView = useAppStore((state) => state.setView);
  const selectApp = useAppsPageStore((state) => state.selectApp);

  // Chat continuation
  const sendMessage = useChatStore((state) => state.sendMessage);

  // Poll app state and activity periodically
  useEffect(() => {
    // Initial load
    loadAppState(monitor.appId);
    loadActivity(monitor.appId, { limit: 5 });

    const interval = setInterval(() => {
      loadAppState(monitor.appId);
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [monitor.appId, loadAppState, loadActivity]);

  const statusConfig = getStatusConfig(appState);

  // Determine if task is "done" (idle and has successful last run)
  const isCompleted =
    appState?.status === 'idle' &&
    appState?.lastStatus === 'ok' &&
    activityEntries?.some((e) => e.content?.status === 'ok');
  const isError = appState?.status === 'error';

  // Recent activity entries for display (max 3 when collapsed)
  const recentEntries = useMemo(() => {
    if (!activityEntries || activityEntries.length === 0) return [];
    return isExpanded ? activityEntries.slice(0, 10) : activityEntries.slice(0, 3);
  }, [activityEntries, isExpanded]);

  // Last run info
  const lastRunText = useMemo(() => {
    if (!appState?.lastRunAtMs) return null;
    return formatRelativeTime(appState.lastRunAtMs, t);
  }, [appState?.lastRunAtMs, t]);

  const nextRunText = useMemo(() => {
    if (!appState?.nextRunAtMs) return null;
    const diff = appState.nextRunAtMs - Date.now();
    if (diff <= 0) return t('Soon');
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return t('in {{count}}m', { count: minutes });
    const hours = Math.floor(minutes / 60);
    return t('in {{count}}h {{min}}m', { count: hours, min: minutes % 60 });
  }, [appState?.nextRunAtMs, t]);

  // Navigate to AppsPage for this app
  const handleViewDetails = useCallback(() => {
    selectApp(monitor.appId, 'automation');
    setView('apps');
  }, [monitor.appId, selectApp, setView]);

  // Send continuation prompt to Claude
  const handleContinue = useCallback(() => {
    const prompt =
      monitor.onCompletePrompt ||
      `Background task "${monitor.taskName}" is complete. Please continue processing based on the results.`;
    sendMessage(prompt);
  }, [monitor.taskName, monitor.onCompletePrompt, sendMessage]);

  // Toggle pause/resume
  const handleTogglePause = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (appState?.status === 'paused') {
        await resumeApp(monitor.appId);
      } else {
        await pauseApp(monitor.appId);
      }
    },
    [appState?.status, monitor.appId, pauseApp, resumeApp],
  );

  // Manual trigger
  const handleTriggerNow = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      await triggerApp(monitor.appId);
    },
    [monitor.appId, triggerApp],
  );

  const StatusIcon = statusConfig.Icon;

  return (
    <div className="task-monitor-card mt-3 animate-fade-in">
      <div
        className={`rounded-xl border ${statusConfig.borderColor} ${statusConfig.bgColor} overflow-hidden`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/20">
          <div className="flex items-center gap-2 min-w-0">
            <div className="relative flex-shrink-0">
              <Bot
                size={16}
                className={`${statusConfig.color} ${statusConfig.spin ? 'animate-spin' : ''}`}
              />
              {appState?.status === 'running' && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              )}
            </div>
            <span className="text-sm font-medium text-foreground truncate">
              {monitor.taskName || t('Background Task')}
            </span>
            {monitor.isRemote && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-600 border border-blue-500/30">
                Remote
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-shrink-0">
            {/* Status label */}
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${statusConfig.bgColor} ${statusConfig.color}`}
            >
              {t(statusConfig.labelKey)}
            </span>

            {/* Quick actions */}
            {appState && appState.status !== 'error' && (
              <button
                onClick={handleTogglePause}
                className="p-1 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-white/5 transition-colors"
                title={appState.status === 'paused' ? t('Resume') : t('Pause')}
              >
                {appState.status === 'paused' ? <Play size={13} /> : <Pause size={13} />}
              </button>
            )}
          </div>
        </div>

        {/* Description */}
        {monitor.description && (
          <div className="px-4 py-2 text-xs text-muted-foreground border-b border-border/10">
            {monitor.description}
          </div>
        )}

        {/* Activity log */}
        {recentEntries.length > 0 && (
          <div className="px-4 py-1.5">
            {recentEntries.map((entry) => (
              <ActivityLogItem key={entry.id} entry={entry} t={t} />
            ))}
            {activityEntries && activityEntries.length > 3 && (
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="flex items-center gap-1 text-xs text-primary/60 hover:text-primary mt-1 transition-colors"
              >
                {isExpanded ? (
                  <>
                    <ChevronUp size={12} />
                    <span>{t('Collapse')}</span>
                  </>
                ) : (
                  <>
                    <ChevronDown size={12} />
                    <span>{t('Show more ({{count}})', { count: activityEntries.length - 3 })}</span>
                  </>
                )}
              </button>
            )}
          </div>
        )}

        {/* Empty state */}
        {!activityEntries?.length && appState && (
          <div className="px-4 py-3 text-xs text-muted-foreground/60 text-center">
            {t('Waiting for first run...')}
          </div>
        )}

        {/* Error message */}
        {appState?.lastError && (
          <div className="mx-4 mb-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
            <p className="text-xs text-red-500/80 break-words">{appState.lastError}</p>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/20 bg-secondary/20">
          {/* Run info */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {lastRunText && (
              <span>
                {t('Last run')}: {lastRunText}
              </span>
            )}
            {nextRunText && appState?.status !== 'paused' && (
              <span>
                {t('Next')}: {nextRunText}
              </span>
            )}
            {appState?.lastDurationMs && (
              <span>
                {t('Duration')}: {(appState.lastDurationMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1.5">
            {/* Continue button (only when completed) */}
            {isCompleted && (
              <button
                onClick={handleContinue}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                  bg-primary/20 text-primary hover:bg-primary/30 transition-all"
              >
                <Play size={12} />
                <span>{t('Continue')}</span>
              </button>
            )}

            {/* Manual trigger button */}
            {appState && appState.status !== 'running' && appState.status !== 'queued' && (
              <button
                onClick={handleTriggerNow}
                className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs
                  text-muted-foreground hover:text-foreground hover:bg-white/5 transition-all"
                title={t('Run now')}
              >
                <Play size={12} />
              </button>
            )}

            {/* View details */}
            <button
              onClick={handleViewDetails}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs
                text-muted-foreground hover:text-foreground hover:bg-white/5 transition-all"
              title={t('View details')}
            >
              <ExternalLink size={12} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
