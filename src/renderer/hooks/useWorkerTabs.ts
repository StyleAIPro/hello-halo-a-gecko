/**
 * useWorkerTabs - Hyper Space worker tab management
 *
 * Builds the tab list from worker sessions, tracks unread workers,
 * and handles tab switching.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useChatStore } from '../stores/chat.store';
import type { WorkerSessionState } from '../stores/chat.store';
import type { WorkerTab } from '../components/chat/WorkerTabBar';

interface UseWorkerTabsOptions {
  spaceName: string;
  isGenerating: boolean;
}

interface UseWorkerTabsResult {
  activeTabId: string;
  tabs: WorkerTab[];
  unreadWorkers: Set<string>;
  activeWorkerSession: WorkerSessionState | null;
  isViewingWorker: boolean;
  handleTabChange: (tabId: string) => void;
}

export function useWorkerTabs({
  spaceName,
  isGenerating,
}: UseWorkerTabsOptions): UseWorkerTabsResult {
  const activeAgentId = useChatStore((s) => s.activeAgentId);
  const activeTabId = activeAgentId || 'main';
  const setActiveAgentId = useChatStore((s) => s.setActiveAgentId);

  const [unreadWorkers, setUnreadWorkers] = useState<Set<string>>(new Set());

  const workerSessions = useChatStore((s) => {
    const convId = s.getCurrentSpaceState().currentConversationId;
    return convId ? s.sessions.get(convId)?.workerSessions : undefined;
  });

  const tabs: WorkerTab[] = useMemo(() => {
    const result: WorkerTab[] = [
      { id: 'main', name: spaceName, role: 'leader', status: isGenerating ? 'running' : 'idle' },
    ];
    if (workerSessions && workerSessions.size > 0) {
      for (const [agentId, ws] of workerSessions) {
        result.push({
          id: agentId,
          name: ws.agentName,
          role: 'worker',
          type: ws.type,
          status: ws.status,
          workerSession: ws,
        });
      }
    }
    return result;
  }, [workerSessions, isGenerating, spaceName]);

  // When a worker completes while user is viewing a different tab, mark it unread
  useEffect(() => {
    if (!workerSessions) return;
    for (const [agentId, ws] of workerSessions) {
      if (ws.status === 'completed' && !ws.isRunning && activeTabId !== agentId) {
        setUnreadWorkers((prev) => {
          if (prev.has(agentId)) return prev;
          const next = new Set(prev);
          next.add(agentId);
          return next;
        });
      }
    }
  }, [workerSessions, activeTabId]);

  const handleTabChange = useCallback(
    (tabId: string) => {
      setActiveAgentId(tabId === 'main' ? null : tabId);
      if (tabId !== 'main') {
        setUnreadWorkers((prev) => {
          const next = new Set(prev);
          next.delete(tabId);
          return next;
        });
      }
    },
    [setActiveAgentId],
  );

  const activeWorkerSession = useMemo(() => {
    if (activeTabId === 'main') return null;
    return workerSessions?.get(activeTabId) || null;
  }, [activeTabId, workerSessions]);

  const isViewingWorker = activeTabId !== 'main' && activeWorkerSession !== null;

  return {
    activeTabId,
    tabs,
    unreadWorkers,
    activeWorkerSession,
    isViewingWorker,
    handleTabChange,
  };
}
