/**
 * SessionDetailView
 *
 * Read-only message viewer for automation App run sessions.
 * Displays the full AI execution trace (thinking, tool calls, results, text)
 * by reusing the exact same components as the main chat:
 * - MessageItem for message bubbles (markdown, error display, copy, etc.)
 * - CollapsedThoughtProcess for thinking/tool call timeline
 *
 * Design decisions (per AppsPage-前端UI规格.md §7):
 * - Read-only: no input area, users cannot interact with automation sessions
 * - Identical rendering to main chat — all thinking, tool calls, results visible
 * - Loaded via dedicated app:get-session API (separate JSONL storage, not conversations)
 * - Does NOT use Virtuoso (automation sessions are short, typically < 50 messages)
 *
 * Live mode:
 * - When viewing a session for a currently running task (detected via appStates),
 *   the view polls the backend every 2 seconds to refresh messages.
 * - Polling stops automatically when the run completes (status changes from 'running').
 * - A pulsing indicator shows that the session is live.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { api } from '../../api'
import { useAppsStore } from '../../stores/apps.store'
import { MessageItem } from '../chat/MessageItem'
import { CollapsedThoughtProcess } from '../chat/CollapsedThoughtProcess'
import { useTranslation } from '../../i18n'
import type { Message, Thought } from '../../types'

interface SessionDetailViewProps {
  /** App ID that owns this run */
  appId: string
  /** Run ID to load session messages for */
  runId: string
}

type LoadState = 'loading' | 'loaded' | 'error' | 'empty'

/** Polling interval for live sessions (ms) */
const LIVE_POLL_INTERVAL = 2000

export function SessionDetailView({ appId, runId }: SessionDetailViewProps) {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<Message[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Check if this run is currently active via the app's runtime state
  const runtimeState = useAppsStore(s => s.appStates[appId])
  const isLive = runtimeState?.status === 'running' && runtimeState?.runningRunId === runId

  // ── Load session messages (reusable for initial load + polling) ──
  const loadSession = useCallback(async (isPolling = false) => {
    if (!isPolling) {
      setLoadState('loading')
      setErrorMsg(null)
    }
    try {
      const res = await api.appGetSession(appId, runId)

      if (res.success && res.data) {
        const msgs = (res.data as Message[]) ?? []
        setMessages(msgs)
        if (!isPolling) {
          setLoadState(msgs.length > 0 ? 'loaded' : 'empty')
        } else if (msgs.length > 0 && loadState === 'empty') {
          setLoadState('loaded')
        }
      } else if (!isPolling) {
        setLoadState('empty')
      }
    } catch (err) {
      if (!isPolling) {
        console.error('[SessionDetailView] Failed to load session:', err)
        setErrorMsg(String(err))
        setLoadState('error')
      }
    }
  }, [appId, runId, loadState])

  // ── Initial load ──
  useEffect(() => {
    loadSession(false)
  }, [appId, runId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live polling: refresh messages while the run is active ──
  useEffect(() => {
    if (!isLive) return

    const timer = setInterval(() => {
      loadSession(true)
    }, LIVE_POLL_INTERVAL)

    return () => clearInterval(timer)
  }, [isLive, loadSession])

  // ── When run completes (isLive → false), do a final reload to get the complete session ──
  const prevIsLive = useRef(isLive)
  useEffect(() => {
    if (prevIsLive.current && !isLive) {
      // Run just finished — reload to capture the final messages
      loadSession(false)
    }
    prevIsLive.current = isLive
  }, [isLive, loadSession])

  // Scroll to top when session changes
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [runId])

  // ── Loading state ──
  if (loadState === 'loading') {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">{t('Loading session...')}</span>
        </div>
      </div>
    )
  }

  // ── Error state ──
  if (loadState === 'error') {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="flex flex-col items-center gap-2 text-muted-foreground max-w-sm text-center">
          <AlertCircle className="w-5 h-5 text-destructive" />
          <p className="text-sm">{t('Failed to load session')}</p>
          {errorMsg && <p className="text-xs text-muted-foreground/60">{errorMsg}</p>}
        </div>
      </div>
    )
  }

  // ── Empty state (show running indicator if live) ──
  if (loadState === 'empty' && !isLive) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">{t('No messages in this session')}</p>
      </div>
    )
  }

  // ── Loaded: render messages ──
  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto py-6 px-4">
        {/* Live indicator */}
        {isLive && (
          <div className="flex items-center gap-2 mb-4 px-2 py-1.5 rounded-md bg-green-500/10 border border-green-500/20">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
            <span className="text-xs text-green-600 dark:text-green-400">{t('Running — auto-refreshing')}</span>
          </div>
        )}

        {messages.map((message) => {
          const hasInlineThoughts = Array.isArray(message.thoughts) && message.thoughts.length > 0

          // Assistant messages with thoughts: CollapsedThoughtProcess above + MessageItem
          // Mirrors MessageList.tsx itemContent rendering exactly
          if (message.role === 'assistant' && hasInlineThoughts) {
            return (
              <div key={message.id} className="flex justify-start pb-4">
                <div className="w-[85%]">
                  <CollapsedThoughtProcess
                    thoughts={message.thoughts as Thought[]}
                    defaultExpanded={false}
                  />
                  {/* Only render the message bubble if there is text content.
                      Assistant events with only tool_use/thinking blocks have empty content —
                      rendering MessageItem for those would produce empty visible bubbles. */}
                  {message.content && (
                    <MessageItem
                      message={message}
                      hideThoughts
                      isInContainer
                    />
                  )}
                </div>
              </div>
            )
          }

          // Regular messages (user or assistant without thoughts)
          return (
            <div key={message.id} className="pb-4">
              <MessageItem message={message} />
            </div>
          )
        })}

        {/* Live trailing indicator — show when running and there are already messages */}
        {isLive && messages.length > 0 && (
          <div className="flex items-center gap-2 py-4 text-muted-foreground/60">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span className="text-xs">{t('Processing...')}</span>
          </div>
        )}
      </div>
    </div>
  )
}
