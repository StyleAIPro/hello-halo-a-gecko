/**
 * Remote Agent Chat - Chat interface for remote AI agents
 */

import React, { useState, useEffect, useRef } from 'react'
import { Send, Loader2, Terminal, FileText, Image as ImageIcon, Copy, Check, CheckCircle, AlertCircle, Paperclip, X } from 'lucide-react'
import { api } from '../api'
import { useTranslation } from '../i18n'
import { TokenUsageIndicator } from './chat/TokenUsageIndicator'
import type { TokenUsage } from '../types'

export interface RemoteFileAttachment {
  path: string
  name: string
  type: 'file' | 'directory'
}

export interface RemoteAgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  attachments?: Array<{
    type: 'image' | 'file'
    name: string
    url: string
    path?: string
  }>
  status?: 'sending' | 'sent' | 'error'
  tokenUsage?: TokenUsage
}

export interface RemoteAgentChatProps {
  serverId: string
  sessionId?: string
  onSessionChange?: (sessionId: string) => void
  onFileAttachment?: (file: RemoteFileAttachment) => void
}

export function RemoteAgentChat({ serverId, sessionId, onSessionChange, onFileAttachment }: RemoteAgentChatProps) {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<RemoteAgentMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attachedFiles, setAttachedFiles] = useState<RemoteFileAttachment[]>([])
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Load initial session state
  useEffect(() => {
    if (sessionId) {
      loadSessionMessages(sessionId)
    }
  }, [sessionId, serverId])

  // Check connection status
  useEffect(() => {
    checkConnection()
    const interval = setInterval(checkConnection, 30000) // Check every 30s
    return () => clearInterval(interval)
  }, [serverId])

  const checkConnection = async () => {
    try {
      const result = await api.checkRemoteAgentConnection(serverId)
      setConnected(result.success)
      if (!result.success) {
        setError(result.error || t('Connection lost'))
      } else {
        setError(null)
      }
    } catch (err) {
      console.error('[RemoteAgentChat] Connection check failed:', err)
      setConnected(false)
    }
  }

  const loadSessionMessages = async (sessionId: string) => {
    try {
      const result = await api.getRemoteAgentMessages(serverId, sessionId)
      if (result.success && result.data) {
        setMessages(result.data as RemoteAgentMessage[])
      }
    } catch (err) {
      console.error('[RemoteAgentChat] Failed to load messages:', err)
    }
  }

  const handleSend = async () => {
    if ((!input.trim() && attachedFiles.length === 0) || sending) return

    // Build attachments from attached files
    const attachments = attachedFiles.map(file => ({
      type: 'file' as const,
      name: file.name,
      path: file.path
    }))

    const userMessage: RemoteAgentMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: input.trim(),
      timestamp: new Date().toISOString(),
      status: 'sending',
      attachments: attachments.length > 0 ? attachments : undefined
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')
    setAttachedFiles([])
    setSending(true)

    try {
      const result = await api.sendRemoteAgentMessage(serverId, {
        sessionId,
        content: userMessage.content,
        attachments
      })

      if (result.success) {
        // Update user message status
        setMessages(prev => prev.map(msg =>
          msg.id === userMessage.id
            ? { ...msg, status: 'sent' }
            : msg
        ))

        // If new session was created, update it
        if (result.data?.sessionId && onSessionChange) {
          onSessionChange(result.data.sessionId)
        }

        // Add assistant response if available
        if (result.data?.response) {
          const assistantMessage: RemoteAgentMessage = {
            id: `msg-${Date.now() + 1}`,
            role: 'assistant',
            content: result.data.response,
            timestamp: new Date().toISOString(),
            tokenUsage: result.data.tokenUsage || undefined
          }
          setMessages(prev => [...prev, assistantMessage])
        }
      } else {
        setMessages(prev => prev.map(msg =>
          msg.id === userMessage.id
            ? { ...msg, status: 'error' }
            : msg
        ))
        setError(result.error || t('Failed to send message'))
      }
    } catch (err) {
      console.error('[RemoteAgentChat] Failed to send message:', err)
      setMessages(prev => prev.map(msg =>
        msg.id === userMessage.id
          ? { ...msg, status: 'error' }
          : msg
      ))
      setError(t('Failed to send message'))
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  const handleAttachFile = (file: RemoteFileAttachment) => {
    setAttachedFiles(prev => {
      // Check if file is already attached
      if (prev.some(f => f.path === file.path)) {
        return prev
      }
      return [...prev, file]
    })
    onFileAttachment?.(file)
  }

  const handleRemoveAttachment = (path: string) => {
    setAttachedFiles(prev => prev.filter(f => f.path !== path))
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleRetry = (messageId: string) => {
    const message = messages.find(m => m.id === messageId)
    if (message && message.role === 'user') {
      setInput(message.content)
      setMessages(prev => prev.filter(m => m.id !== messageId))
    }
  }

  const copyMessage = (messageId: string, content: string) => {
    navigator.clipboard.writeText(content)
    setCopiedMessageId(messageId)
    setTimeout(() => setCopiedMessageId(null), 2000)
  }

  return (
    <div className="flex flex-col h-full bg-card border border-border rounded-lg overflow-hidden">
      {/* Connection status bar */}
      <div className={`flex items-center gap-2 px-4 py-2 text-sm ${
        connected ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'
      }`}>
        {connected ? (
          <CheckCircle className="w-4 h-4" />
        ) : (
          <AlertCircle className="w-4 h-4" />
        )}
        <span className="flex-1">
          {connected ? t('Connected to remote agent') : t('Disconnected from remote agent')}
        </span>
        {sessionId && (
          <span className="text-xs opacity-70 font-mono">
            {sessionId.slice(0, 8)}...
          </span>
        )}
      </div>

      {/* Error message */}
      {error && (
        <div className="px-4 py-3 bg-red-500/10 text-red-500 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-2 p-1 hover:bg-red-500/20 rounded"
          >
            ×
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Terminal className="w-12 h-12 mb-4 opacity-50" />
            <p className="text-sm">{t('Start a conversation with the remote agent')}</p>
            <p className="text-xs mt-2">{t('Type your message below and press Enter to send')}</p>
          </div>
        ) : (
          <>
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div className={`max-w-[80%] rounded-lg px-4 py-3 ${
                  message.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-foreground'
                }`}>
                  {/* Message content */}
                  <p className="text-sm whitespace-pre-wrap">{message.content}</p>

                  {/* Attachments */}
                  {message.attachments && message.attachments.length > 0 && (
                    <div className="mt-2 space-y-2">
                      {message.attachments.map((att, idx) => (
                        <div key={idx} className="flex items-center gap-2 text-sm opacity-80">
                          {att.type === 'image' ? (
                            <ImageIcon className="w-4 h-4" />
                          ) : (
                            <FileText className="w-4 h-4" />
                          )}
                          <span>{att.name}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Message metadata */}
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-xs opacity-60">
                      {new Date(message.timestamp).toLocaleTimeString()}
                    </span>

                    {/* Message status indicators */}
                    {message.status === 'sending' && (
                      <Loader2 className="w-3 h-3 animate-spin opacity-60" />
                    )}
                    {message.status === 'error' && (
                      <button
                        onClick={() => handleRetry(message.id)}
                        className="text-xs text-red-400 hover:text-red-300"
                      >
                        {t('Retry')}
                      </button>
                    )}
                  </div>

                  {/* Token usage indicator + copy button for assistant messages */}
                  {message.role === 'assistant' && (
                    <div className="flex justify-end items-center gap-2 mt-2 pt-1">
                      {/* Token usage indicator (only show if tokenUsage exists) */}
                      {message.tokenUsage && (
                        <TokenUsageIndicator tokenUsage={message.tokenUsage} previousCost={0} />
                      )}
                      {/* Copy button */}
                      <button
                        onClick={() => copyMessage(message.id, message.content)}
                        className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground/60 hover:text-foreground hover:bg-white/5 rounded-md transition-all"
                        title={t('Copy message')}
                      >
                        {copiedMessageId === message.id ? (
                          <>
                            <Check size={14} className="text-green-400" />
                            <span className="text-green-400">{t('Copied')}</span>
                          </>
                        ) : (
                          <Copy size={14} />
                        )}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input area */}
      <div className="p-4 border-t border-border">
        {/* Attached files */}
        {attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {attachedFiles.map((file) => (
              <div
                key={file.path}
                className="flex items-center gap-2 px-3 py-1.5 bg-secondary rounded-lg text-sm"
              >
                <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="truncate max-w-[150px]">{file.name}</span>
                <button
                  onClick={() => handleRemoveAttachment(file.path)}
                  className="p-0.5 hover:bg-muted-foreground/20 rounded transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('Type a message...')}
              disabled={!connected || sending}
              className="w-full px-4 py-3 pr-12 bg-input border border-border rounded-lg text-foreground focus:ring-2 focus:ring-primary focus:border-transparent resize-none transition-colors disabled:opacity-50 min-h-[80px] max-h-[200px]"
              rows={1}
            />
            <button
              onClick={() => {
                // Trigger file attachment from file browser
                // This would be called by the parent page when a file is selected in the browser
              }}
              className="absolute bottom-3 right-3 p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
              title={t('Attach files from file browser')}
            >
              <Paperclip className="w-4 h-4" />
            </button>
          </div>
          <button
            onClick={handleSend}
            disabled={(!input.trim() && attachedFiles.length === 0) || !connected || sending}
            className="px-4 py-3 bg-primary hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground text-primary-foreground rounded-lg transition-colors flex items-center gap-2"
          >
            {sending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            <span className="hidden sm:inline">{t('Send')}</span>
          </button>
        </div>
        <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
          <span>{t('Press Enter to send, Shift+Enter for new line')}</span>
          <div className="flex items-center gap-2">
            {attachedFiles.length > 0 && (
              <span>{t('{{count}} file(s) attached', { count: attachedFiles.length })}</span>
            )}
            {!connected && (
              <span className="text-red-500">{t('Reconnecting...')}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
