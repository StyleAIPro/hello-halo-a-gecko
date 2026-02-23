/**
 * AppChatView
 *
 * Interactive chat view for automation Apps.
 * Allows users to chat with an App's AI agent in real-time,
 * reusing the same streaming infrastructure as the main Agent chat.
 *
 * Architecture:
 * - Uses the virtual conversationId "app-chat:{appId}" for event routing
 * - The existing agent event listeners in App.tsx are GLOBAL — they dispatch
 *   to chat.store.ts sessions by conversationId. App chat events automatically
 *   flow to sessions.get("app-chat:{appId}") without any extra wiring.
 * - Persisted messages loaded from JSONL via app:chat-messages IPC
 * - InputArea for user input, ThoughtProcess + MarkdownRenderer for streaming
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { api } from '../../api'
import { useChatStore } from '../../stores/chat.store'
import { MessageItem } from '../chat/MessageItem'
import { CollapsedThoughtProcess } from '../chat/CollapsedThoughtProcess'
import { ThoughtProcess } from '../chat/ThoughtProcess'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { InputArea } from '../chat/InputArea'
import { useTranslation } from '../../i18n'
import type { Message, Thought } from '../../types'

interface AppChatViewProps {
  /** App ID */
  appId: string
  /** Space ID (for loading messages and sending chat) */
  spaceId: string
}

/**
 * Build the virtual conversationId for app chat.
 * Must match the backend's getAppChatConversationId().
 */
function getConversationId(appId: string): string {
  return `app-chat:${appId}`
}

type LoadState = 'loading' | 'loaded' | 'error' | 'empty'

export function AppChatView({ appId, spaceId }: AppChatViewProps) {
  const { t } = useTranslation()
  const conversationId = getConversationId(appId)

  // ── Persisted messages ──
  const [messages, setMessages] = useState<Message[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // ── Streaming state from chat store (uses virtual conversationId) ──
  const session = useChatStore(s => s.getSession(conversationId))
  const {
    isGenerating,
    streamingContent,
    isStreaming,
    thoughts,
    isThinking,
    pendingQuestion,
  } = session

  // ── Load persisted chat messages on mount ──
  useEffect(() => {
    let cancelled = false

    async function loadMessages() {
      setLoadState('loading')
      setErrorMsg(null)
      try {
        const res = await api.appChatMessages(appId, spaceId)
        if (cancelled) return

        if (res.success && res.data) {
          const msgs = (res.data as Message[]) ?? []
          setMessages(msgs)
          setLoadState(msgs.length > 0 ? 'loaded' : 'empty')
        } else {
          setLoadState('empty')
        }
      } catch (err) {
        if (cancelled) return
        console.error('[AppChatView] Failed to load messages:', err)
        setErrorMsg(String(err))
        setLoadState('error')
      }
    }

    loadMessages()
    return () => { cancelled = true }
  }, [appId, spaceId])

  // ── Reload messages when generation completes ──
  // This ensures the persisted messages include the latest assistant response
  const prevIsGeneratingRef = useRef(isGenerating)
  useEffect(() => {
    if (prevIsGeneratingRef.current && !isGenerating) {
      // Generation just completed — reload messages from JSONL
      api.appChatMessages(appId, spaceId).then(res => {
        if (res.success && res.data) {
          const msgs = (res.data as Message[]) ?? []
          setMessages(msgs)
          setLoadState(msgs.length > 0 ? 'loaded' : 'empty')
        }
      }).catch(err => {
        console.error('[AppChatView] Failed to reload messages after completion:', err)
      })
    }
    prevIsGeneratingRef.current = isGenerating
  }, [isGenerating, appId, spaceId])

  // ── Auto-scroll to bottom when streaming ──
  useEffect(() => {
    if (isStreaming || isThinking) {
      const el = scrollRef.current
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      }
    }
  }, [streamingContent, thoughts.length, isStreaming, isThinking])

  // ── Send message ──
  const handleSend = useCallback(async (content: string, _images?: unknown[], thinkingEnabled?: boolean) => {
    try {
      const res = await api.appChatSend({
        appId,
        spaceId,
        message: content,
        thinkingEnabled,
      })
      if (!res.success) {
        console.error('[AppChatView] Send failed:', res.error)
      }
      // Optimistically add user message to local list
      const userMsg: Message = {
        id: `user-${Date.now()}`,
        role: 'user',
        content,
        timestamp: Date.now(),
      }
      setMessages(prev => [...prev, userMsg])
      setLoadState('loaded')

      // Scroll to bottom after sending
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
      })
    } catch (err) {
      console.error('[AppChatView] Send error:', err)
    }
  }, [appId, spaceId])

  // ── Stop generation ──
  const handleStop = useCallback(async () => {
    try {
      await api.appChatStop(appId)
    } catch (err) {
      console.error('[AppChatView] Stop error:', err)
    }
  }, [appId])

  // ── Loading state ──
  if (loadState === 'loading') {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">{t('Loading chat...')}</span>
          </div>
        </div>
        <div className="shrink-0 p-4">
          <InputArea
            onSend={handleSend}
            onStop={handleStop}
            isGenerating={false}
            placeholder={t('Chat with this App...')}
            isCompact
          />
        </div>
      </div>
    )
  }

  // ── Error state ──
  if (loadState === 'error') {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="flex flex-col items-center gap-2 text-muted-foreground max-w-sm text-center">
            <AlertCircle className="w-5 h-5 text-destructive" />
            <p className="text-sm">{t('Failed to load chat')}</p>
            {errorMsg && <p className="text-xs text-muted-foreground/60">{errorMsg}</p>}
          </div>
        </div>
        <div className="shrink-0 p-4">
          <InputArea
            onSend={handleSend}
            onStop={handleStop}
            isGenerating={false}
            placeholder={t('Chat with this App...')}
            isCompact
          />
        </div>
      </div>
    )
  }

  // ── Active state: messages + streaming + input ──
  const hasStreamingContent = isGenerating && (streamingContent || thoughts.length > 0 || isThinking)

  return (
    <div className="flex flex-col h-full">
      {/* Message area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto py-6 px-4">
          {/* Empty state hint */}
          {loadState === 'empty' && !hasStreamingContent && (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-muted-foreground">{t('Send a message to start chatting with this App')}</p>
            </div>
          )}

          {/* Persisted messages */}
          {messages.map((message) => {
            const hasInlineThoughts = Array.isArray(message.thoughts) && message.thoughts.length > 0

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

            return (
              <div key={message.id} className="pb-4">
                <MessageItem message={message} />
              </div>
            )
          })}

          {/* Live streaming content */}
          {hasStreamingContent && (
            <div className="flex justify-start pb-4 animate-fade-in">
              <div className="w-[85%]">
                {/* Real-time thought process */}
                {(thoughts.length > 0 || isThinking) && (
                  <ThoughtProcess thoughts={thoughts} isThinking={isThinking} />
                )}

                {/* Streaming text content */}
                {streamingContent && (
                  <div className="message-bubble assistant rounded-2xl px-4 py-3 bg-muted/50">
                    <MarkdownRenderer content={streamingContent} />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Input area */}
      <div className="shrink-0 p-4">
        <InputArea
          onSend={handleSend}
          onStop={handleStop}
          isGenerating={isGenerating}
          placeholder={t('Chat with this App...')}
          isCompact
        />
      </div>
    </div>
  )
}
