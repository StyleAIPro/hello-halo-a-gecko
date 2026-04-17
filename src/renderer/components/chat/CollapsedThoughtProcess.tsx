/**
 * CollapsedThoughtProcess - Displays saved thought history above completed messages
 * Collapsed by default, expandable to show full details
 *
 * TodoWrite is rendered separately at the bottom (only one instance)
 */

import { useState, useMemo, useRef, useCallback, useEffect, type RefObject } from 'react';
import {
  Lightbulb,
  Loader2,
  XCircle,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Braces,
  Copy,
  Check,
  Wrench,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { TodoCard, parseTodoInput } from '../tool/TodoCard';
import { ToolResultViewer } from './tool-result';
import {
  getThoughtIcon,
  getThoughtColor,
  getThoughtLabelKey,
  getToolFriendlyFormat,
  groupSubagentThoughts,
  groupSubagentThoughtsFromPersisted,
  type ThoughtGroup,
} from './thought-utils';
import { useLazyVisible } from '../../hooks/useLazyVisible';
import type { Thought, ThoughtsSummary } from '../../types';
import type { WorkerSessionState } from '../../stores/chat.store';
import { getCurrentLanguage, useTranslation } from '../../i18n';

interface CollapsedThoughtProcessProps {
  thoughts: Thought[];
  defaultExpanded?: boolean;
  workerSessions?: Map<string, WorkerSessionState>;
}

// Agent/Task (sub-agent) panel — renders inside historical thought timeline
// Shows agent name, task description, status, and tool result output
// Default collapsed, expandable to see full details
function HistoricalTaskPanel({ thought }: { thought: Thought }) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  // Extract task description from tool input
  const description =
    (thought.toolInput?.description as string) ||
    (thought.toolInput?.prompt as string) ||
    t('Subtask');

  // Determine status from tool result
  const hasResult = !!thought.toolResult;
  const isError = thought.toolResult?.isError ?? false;
  const statusLabel = hasResult ? (isError ? t('Failed') : t('Completed')) : t('Running');
  const statusColor = hasResult ? (isError ? 'text-amber-500' : 'text-green-400') : 'text-blue-400';

  // Duration
  const duration = thought.duration ? (thought.duration / 1000).toFixed(1) + 's' : null;

  // Extract actual text content from Agent tool result
  // Agent output can be raw SDK format: [{"type":"text","text":"..."}]
  // or plain text. Try to extract the text content.
  const rawOutput = thought.toolResult?.output || '';
  const output = useMemo(() => {
    if (!rawOutput) return '';
    try {
      const parsed = JSON.parse(rawOutput);
      // SDK format: array of content blocks
      if (Array.isArray(parsed)) {
        return parsed
          .filter((b: any) => b.type === 'text' && b.text)
          .map((b: any) => b.text)
          .join('\n\n');
      }
      // Single object with text field
      if (parsed.text) return parsed.text;
      // Fallback: return as-is
      return rawOutput;
    } catch {
      return rawOutput;
    }
  }, [rawOutput]);

  const toolName = thought.toolName || 'Agent';

  return (
    <div className="py-1.5 text-xs">
      {/* Collapsed: clickable header row */}
      <div
        className="flex items-center gap-2 rounded-lg px-2 py-1 cursor-pointer hover:bg-white/5 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <Wrench size={13} className="text-blue-400 shrink-0" />
        <span className="font-medium text-blue-400 shrink-0">{t('Subtask')}</span>
        <span className="text-muted-foreground/60 truncate flex-1 min-w-0">
          {description.length > 80 ? description.substring(0, 80) + '...' : description}
        </span>
        <span className={`text-[10px] ${statusColor} shrink-0`}>{statusLabel}</span>
        {duration && (
          <span className="text-[10px] text-muted-foreground/40 shrink-0">{duration}</span>
        )}
        <ChevronRight
          size={11}
          className={`text-muted-foreground/40 transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
        />
      </div>

      {/* Expanded: task description + tool result output */}
      {isExpanded && (
        <div className="mt-1 ml-[22px] rounded-lg border border-border/30 bg-muted/20 overflow-hidden animate-slide-down">
          {/* Task description */}
          <div className="px-3 py-2 text-[11px] text-foreground/80 whitespace-pre-wrap break-words">
            {description}
          </div>

          {/* Tool result output */}
          {output && (
            <div className="border-t border-border/20">
              <ToolResultViewer
                toolName={toolName}
                toolInput={thought.toolInput}
                output={output}
                isError={isError}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Single thought item in expanded view
function ThoughtItem({ thought }: { thought: Thought }) {
  const { t } = useTranslation();
  const [showRawJson, setShowRawJson] = useState(false);
  const [isContentExpanded, setIsContentExpanded] = useState(false);
  const [isToolExpanded, setIsToolExpanded] = useState(false); // Historical: collapsed by default
  const [copied, setCopied] = useState(false);
  const color = getThoughtColor(thought.type, thought.isError);
  const Icon = getThoughtIcon(thought.type, thought.toolName);

  // Check if tool has result (merged tool_result)
  const hasToolResult = thought.type === 'tool_use' && thought.toolResult;

  // Use friendly format for tool_use, raw content for others
  const content =
    thought.type === 'tool_use'
      ? getToolFriendlyFormat(thought.toolName || '', thought.toolInput)
      : thought.type === 'tool_result'
        ? thought.toolOutput || ''
        : thought.content;

  const maxLen = 120;
  const needsTruncate = content.length > maxLen;

  // Copy tool call + result combined content
  const handleCopyTool = useCallback(async () => {
    if (thought.type !== 'tool_use') return;
    const parts: string[] = [];
    const input = thought.toolInput
      ? getToolFriendlyFormat(thought.toolName || '', thought.toolInput)
      : '';
    const rawInput = thought.toolInput ? JSON.stringify(thought.toolInput, null, 2) : '';
    if (input) parts.push(`[${thought.toolName}] ${input}`);
    if (rawInput && rawInput !== '{}') parts.push(`Input:\n${rawInput}`);
    if (thought.toolResult?.output) parts.push(`Output:\n${thought.toolResult.output}`);
    if (parts.length > 0) {
      try {
        await navigator.clipboard.writeText(parts.join('\n\n'));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    }
  }, [thought.type, thought.toolName, thought.toolInput, thought.toolResult]);

  // Special rendering for Agent/Task (sub-agent) tool_use thoughts
  if (
    thought.type === 'tool_use' &&
    (thought.toolName === 'Agent' || thought.toolName === 'Task')
  ) {
    return <HistoricalTaskPanel thought={thought} />;
  }

  return (
    <div className="py-1.5 text-xs border-b border-border/20 last:border-b-0">
      {/* First row: Icon + Tool name + Timestamp */}
      <div className="flex items-center gap-2">
        <Icon size={14} className={`${color} shrink-0`} />
        <span className={`font-medium ${color} flex-1 min-w-0 truncate`}>
          {(() => {
            const label = getThoughtLabelKey(thought.type);
            return label === 'AI' ? label : t(label);
          })()}
          {thought.toolName && ` - ${thought.toolName}`}
        </span>
        <span className="text-muted-foreground/40 text-[10px] shrink-0">
          {new Intl.DateTimeFormat(getCurrentLanguage(), {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }).format(new Date(thought.timestamp))}
        </span>
      </div>

      {/* ---- tool_use: unified container ---- */}
      {thought.type === 'tool_use' && (
        <div
          className={`mt-1 ml-[22px] rounded-lg border overflow-hidden transition-colors ${
            hasToolResult
              ? thought.toolResult!.isError
                ? 'border-amber-500/30 bg-amber-500/5'
                : 'border-border/30 bg-muted/20'
              : 'border-border/30 bg-muted/20'
          }`}
        >
          {/* Toolbar */}
          <div
            className={`flex items-center justify-between px-2.5 py-[2px] border-b text-[10px] ${
              hasToolResult
                ? thought.toolResult!.isError
                  ? 'border-amber-500/20 bg-amber-500/10 text-amber-600/60'
                  : 'border-border/20 bg-muted/30 text-muted-foreground/60'
                : 'border-border/20 bg-muted/30 text-muted-foreground/60'
            }`}
          >
            <span>{hasToolResult ? t('Completed') : t('Tool call')}</span>
            <div className="flex items-center gap-0.5">
              {thought.toolInput && Object.keys(thought.toolInput).length > 0 && (
                <button
                  onClick={handleCopyTool}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 hover:text-foreground transition-colors"
                >
                  {copied ? (
                    <>
                      <Check size={10} className="text-green-400" />
                      <span className="hidden sm:inline text-green-400">{t('Copied')}</span>
                    </>
                  ) : (
                    <>
                      <Copy size={10} />
                      <span className="hidden sm:inline">{t('Copy')}</span>
                    </>
                  )}
                </button>
              )}
              {thought.toolInput && Object.keys(thought.toolInput).length > 0 && (
                <button
                  onClick={() => setShowRawJson(!showRawJson)}
                  className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded transition-colors ${
                    showRawJson
                      ? 'bg-primary/20 text-primary'
                      : 'hover:bg-white/10 hover:text-foreground'
                  }`}
                >
                  <Braces size={10} />
                </button>
              )}
              <button
                onClick={() => setIsToolExpanded(!isToolExpanded)}
                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-white/10 hover:text-foreground transition-colors"
              >
                {isToolExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
              </button>
            </div>
          </div>

          {/* Content (collapsible) */}
          {isToolExpanded && (
            <div>
              {content && (
                <div className="px-3 py-2 text-muted-foreground/70 whitespace-pre-wrap break-words">
                  {isContentExpanded || !needsTruncate
                    ? content
                    : content.substring(0, maxLen) + '...'}
                  {needsTruncate && (
                    <button
                      onClick={() => setIsContentExpanded(!isContentExpanded)}
                      className="ml-1 text-primary/60 hover:text-primary"
                    >
                      {isContentExpanded ? t('Collapse') : t('Expand')}
                    </button>
                  )}
                </div>
              )}

              {showRawJson && thought.toolInput && (
                <pre className="mx-3 mb-2 p-2 rounded bg-background/50 text-[10px] text-muted-foreground overflow-x-auto">
                  {JSON.stringify(thought.toolInput, null, 2)}
                </pre>
              )}

              {hasToolResult && thought.toolResult!.output && (
                <div className="border-t border-border/20">
                  <ToolResultViewer
                    toolName={thought.toolName || ''}
                    toolInput={thought.toolInput}
                    output={thought.toolResult!.output}
                    isError={thought.toolResult!.isError}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ---- non-tool_use: original content display ---- */}
      {thought.type !== 'tool_use' && content && (
        <div className="mt-0.5 ml-[22px] text-muted-foreground/70 whitespace-pre-wrap break-words">
          {isContentExpanded || !needsTruncate ? content : content.substring(0, maxLen) + '...'}
          {needsTruncate && (
            <button
              onClick={() => setIsContentExpanded(!isContentExpanded)}
              className="ml-1 text-primary/60 hover:text-primary"
            >
              {isContentExpanded ? t('Collapse') : t('Expand')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Lazy wrapper for historical thought items — defers rendering until scrolled into view
const COLLAPSED_THOUGHT_ESTIMATED_HEIGHT = 36;

function LazyCollapsedThoughtItem({
  thought,
  scrollContainerRef,
}: {
  thought: Thought;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const [ref, isVisible] = useLazyVisible('150px', scrollContainerRef);

  if (isVisible) {
    return <ThoughtItem thought={thought} />;
  }

  return (
    <div
      ref={ref}
      style={{ minHeight: COLLAPSED_THOUGHT_ESTIMATED_HEIGHT }}
      className="border-b border-border/20 last:border-b-0"
    />
  );
}

/**
 * Collapsible subagent thought group for historical (CollapsedThoughtProcess) display.
 * Mirrors the SubagentThoughtGroup from ThoughtProcess but uses simpler styling.
 */
function CollapsedSubagentGroup({
  group,
  scrollContainerRef,
}: {
  group: ThoughtGroup;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { t } = useTranslation();

  const subThoughts = group.subagentThoughts;
  if (!subThoughts || subThoughts.length === 0) {
    return (
      <LazyCollapsedThoughtItem thought={group.main} scrollContainerRef={scrollContainerRef} />
    );
  }

  const agentName = subThoughts[0]?.agentName || '';
  const truncatedName = agentName.length > 40 ? agentName.substring(0, 40) + '...' : agentName;

  const duration = useMemo(() => {
    if (subThoughts.length < 2) return null;
    const start = new Date(subThoughts[0].timestamp).getTime();
    const end = new Date(subThoughts[subThoughts.length - 1].timestamp).getTime();
    return ((end - start) / 1000).toFixed(1);
  }, [subThoughts]);

  return (
    <>
      <LazyCollapsedThoughtItem thought={group.main} scrollContainerRef={scrollContainerRef} />
      <div className="ml-1 my-1 rounded-lg border border-purple-500/20 bg-purple-500/[0.04] overflow-hidden">
        <button
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-purple-500/5 transition-colors"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <ChevronDown
            size={12}
            className={`text-purple-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          />
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
            <span className="text-[11px] font-medium text-purple-400 truncate">
              {truncatedName}
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground/50 flex-1">
            {subThoughts.length} {t('steps')}
            {duration && ` · ${duration}s`}
          </span>
        </button>
        {isExpanded && (
          <div className="border-t border-purple-500/10 max-h-[400px] overflow-auto scrollbar-overlay">
            {subThoughts.map((th, idx) => (
              <div key={th.id} className="ml-3 pl-2 border-l border-purple-500/15">
                <ThoughtItem thought={th} />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export function CollapsedThoughtProcess({
  thoughts,
  defaultExpanded = false,
  workerSessions,
}: CollapsedThoughtProcessProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [isMaximized, setIsMaximized] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Build workerMatchMap from workerSessions
  const workerMatchMap = useMemo((): Map<string, WorkerSessionState> => {
    const matchMap = new Map<string, WorkerSessionState>();
    if (!workerSessions || workerSessions.size === 0) return matchMap;

    const workers = Array.from(workerSessions.values());
    const matchedWorkers = new Set<string>();

    // Match Task/Agent tool_use thoughts to worker sessions by description
    for (const thought of thoughts) {
      if (
        thought.type !== 'tool_use' ||
        (thought.toolName !== 'Task' && thought.toolName !== 'Agent')
      )
        continue;
      const desc = thought.toolInput?.description;
      if (!desc) continue;

      for (const worker of workers) {
        if (matchedWorkers.has(worker.agentId)) continue;
        if (
          worker.task &&
          (worker.task === desc || worker.task.includes(desc) || desc.includes(worker.task))
        ) {
          matchMap.set(thought.id, worker);
          matchedWorkers.add(worker.agentId);
          break;
        }
      }
    }

    // Match remaining by order
    const unmatchedTasks = thoughts.filter(
      (th) =>
        th.type === 'tool_use' &&
        (th.toolName === 'Task' || th.toolName === 'Agent') &&
        !matchMap.has(th.id),
    );
    const unmatchedWorkers = workers.filter((w) => !matchedWorkers.has(w.agentId));
    for (let i = 0; i < Math.min(unmatchedTasks.length, unmatchedWorkers.length); i++) {
      matchMap.set(unmatchedTasks[i].id, unmatchedWorkers[i]);
    }

    return matchMap;
  }, [thoughts, workerSessions]);

  // Get latest todo data (only render one TodoCard at bottom)
  const latestTodos = useMemo(() => {
    const todoThoughts = thoughts.filter(
      (t) => t.type === 'tool_use' && t.toolName === 'TodoWrite' && t.toolInput,
    );
    if (todoThoughts.length === 0) return null;

    const latest = todoThoughts[todoThoughts.length - 1];
    return parseTodoInput(latest.toolInput!);
  }, [thoughts]);

  // Filter thoughts for display (exclude TodoWrite and result)
  // text blocks are now shown in the timeline so users can see AI output
  // interleaved with tool calls and thinking blocks
  const displayThoughts = useMemo(() => {
    return thoughts.filter((t) => {
      if (t.type === 'result') return false;
      if (t.toolName === 'TodoWrite') return false;
      return true;
    });
  }, [thoughts]);

  // Group with subagent thoughts if workerMatchMap is provided
  const thoughtGroups = useMemo((): ThoughtGroup[] => {
    if (workerMatchMap && workerMatchMap.size > 0) {
      return groupSubagentThoughts(displayThoughts, workerMatchMap);
    }
    // Fallback: use persisted agentId tags for grouping (after restart)
    const hasSubagentThoughts = displayThoughts.some((t) => t.agentId);
    if (hasSubagentThoughts) {
      return groupSubagentThoughtsFromPersisted(displayThoughts);
    }
    return displayThoughts.map((t) => ({ main: t }));
  }, [displayThoughts, workerMatchMap]);

  // Check if there's anything to show
  const hasContent = displayThoughts.length > 0 || (latestTodos && latestTodos.length > 0);
  if (!hasContent) return null;

  // Only count system-level errors, not tool execution failures
  const errorCount = thoughts.filter((t) => t.type === 'error').length;

  // Calculate duration from first to last thought
  const duration = useMemo(() => {
    if (thoughts.length < 1) return 0;
    const first = new Date(thoughts[0].timestamp).getTime();
    const last = new Date(thoughts[thoughts.length - 1].timestamp).getTime();
    return (last - first) / 1000;
  }, [thoughts]);

  return (
    <div className="mb-2">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`
          flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs
          transition-all duration-200 w-full
          ${
            isExpanded
              ? 'bg-primary/10 border border-primary/30'
              : 'bg-muted/30 hover:bg-muted/50 border border-transparent'
          }
        `}
      >
        {/* Expand icon */}
        <ChevronRight
          size={12}
          className={`text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
        />

        {/* Icon */}
        {errorCount > 0 ? (
          <XCircle size={14} className="text-destructive" />
        ) : (
          <Lightbulb size={14} className="text-primary" />
        )}

        {/* Label */}
        <span className="text-muted-foreground">{t('Thought process')}</span>

        {/* Stats: time only (file changes moved to message bubble footer) */}
        <div className="flex items-center gap-1.5 text-muted-foreground/60">
          <span>{duration.toFixed(1)}s</span>
        </div>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="mt-1 py-2 bg-muted/20 rounded-lg border border-border/30 animate-slide-down thought-content">
          {/* Thought items — lazy-loaded: only items near the scroll viewport are rendered */}
          {thoughtGroups.length > 0 && (
            <div
              ref={scrollContainerRef}
              className={`${isMaximized ? 'max-h-[80vh]' : 'max-h-[300px]'} scrollbar-overlay px-3 transition-all duration-200`}
            >
              {thoughtGroups.map((group, index) => (
                <CollapsedSubagentGroup
                  key={`${group.main.id}-${index}`}
                  group={group}
                  scrollContainerRef={scrollContainerRef}
                />
              ))}
            </div>
          )}

          {/* TodoCard at bottom - only one instance */}
          {latestTodos && latestTodos.length > 0 && (
            <div
              className={`px-3 ${thoughtGroups.length > 0 ? 'mt-2 pt-2 border-t border-border/20' : ''}`}
            >
              <TodoCard todos={latestTodos} isAgentActive={false} />
            </div>
          )}

          {/* Maximize toggle - bottom right, heuristic: show when likely to overflow */}
          {(thoughtGroups.length > 8 || isMaximized) && (
            <div className="flex justify-end px-3 mt-1">
              <button
                onClick={() => setIsMaximized(!isMaximized)}
                className="flex items-center gap-0.5 px-1 py-px rounded text-xs text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 transition-colors"
                title={isMaximized ? t('Compact view') : t('Full view')}
              >
                {isMaximized ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {isMaximized ? 'Compact' : 'Full'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * LazyCollapsedThoughtProcess - For separated thoughts (v2 format).
 * Shows a collapsed summary bar initially, loads full thoughts on first expand,
 * then renders the full CollapsedThoughtProcess.
 */
interface LazyCollapsedThoughtProcessProps {
  thoughtsSummary: ThoughtsSummary;
  onLoadThoughts: () => Promise<Thought[]>;
}

export function LazyCollapsedThoughtProcess({
  thoughtsSummary,
  onLoadThoughts,
}: LazyCollapsedThoughtProcessProps) {
  const { t } = useTranslation();
  const [loadedThoughts, setLoadedThoughts] = useState<Thought[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Once loaded, render expanded — user explicitly clicked to load thoughts
  if (loadedThoughts) {
    return <CollapsedThoughtProcess thoughts={loadedThoughts} defaultExpanded />;
  }

  const duration = thoughtsSummary.duration;

  const handleClick = async () => {
    console.log('[LazyCollapsedThoughtProcess] User clicked to load thoughts');
    setIsLoading(true);
    try {
      const thoughts = await onLoadThoughts();
      console.log(
        `[LazyCollapsedThoughtProcess] Loaded ${thoughts.length} thoughts, rendering full view`,
      );
      setLoadedThoughts(thoughts);
    } catch (err) {
      console.error('[LazyCollapsedThoughtProcess] Failed to load thoughts:', err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="mb-2">
      <button
        onClick={handleClick}
        disabled={isLoading}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-all duration-200 w-full bg-muted/30 hover:bg-muted/50 border border-transparent"
      >
        {isLoading ? (
          <Loader2 size={12} className="text-muted-foreground animate-spin" />
        ) : (
          <ChevronRight size={12} className="text-muted-foreground" />
        )}
        <Lightbulb size={14} className="text-primary" />
        <span className="text-muted-foreground">{t('Thought process')}</span>
        <div className="flex items-center gap-1.5 text-muted-foreground/60">
          {duration != null && <span>{duration.toFixed(1)}s</span>}
        </div>
      </button>
    </div>
  );
}
