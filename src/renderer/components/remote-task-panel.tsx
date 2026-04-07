/**
 * Remote Task Panel - Shows background tasks running on the remote server.
 * Polls the remote server for task list and displays status/output.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Activity, CheckCircle, XCircle, Loader2, X, ChevronDown, ChevronUp, Terminal } from 'lucide-react'
import { api } from '../api'
import { useTranslation } from '../i18n'

// Track notified task IDs to avoid duplicate notifications
const notifiedTasks = new Set<string>()

interface RemoteTask {
  id: string
  command: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  pid?: number
  startedAt: number
  completedAt?: number
  exitCode?: number
  output: string
  outputLines: number
}

interface RemoteTaskPanelProps {
  serverId: string
  visible: boolean
}

export function RemoteTaskPanel({ serverId, visible }: RemoteTaskPanelProps) {
  const { t } = useTranslation()
  const [tasks, setTasks] = useState<RemoteTask[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval>>()
  const outputRef = useRef<HTMLPreElement>(null)

  // Request notification permission on first render
  useEffect(() => {
    if (window.Notification?.permission === 'default') {
      window.Notification.requestPermission()
    }
  }, [])
  useEffect(() => {
    if (expandedId && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [tasks, expandedId])

  // Poll for tasks when visible (fallback for when WebSocket push is not available)
  const fetchTasks = useCallback(async () => {
    try {
      const result = await api.remoteServerListTasks(serverId)
      if (result.success && result.data) {
        setTasks(result.data as RemoteTask[])
      }
    } catch {
      // Silently ignore polling errors
    }
  }, [serverId])

  // Initial fetch when becoming visible + subscribe to WebSocket push
  useEffect(() => {
    if (!visible || !serverId) return
    fetchTasks()
    api.remoteServerSubscribeTasks(serverId).catch(() => {})
  }, [visible, serverId])

  // Poll every 5s as fallback (only when visible)
  useEffect(() => {
    if (!visible || !serverId) return
    pollRef.current = setInterval(fetchTasks, 5000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [visible, serverId])

  // Real-time updates via WebSocket push
  useEffect(() => {
    if (!visible || !serverId) return
    const unsub = api.onRemoteTaskUpdate((event: any) => {
      if (event?.serverId === serverId && event?.data) {
        const update = event.data as { type: string; task: RemoteTask }
        setTasks(prev => {
          const idx = prev.findIndex(t => t.id === update.task.id)
          if (idx >= 0) {
            const next = [...prev]
            next[idx] = update.task
            return next
          }
          return [...prev, update.task]
        })
        // Desktop notification for task completion/failure
        if ((update.type === 'completed' || update.type === 'failed') && !notifiedTasks.has(update.task.id)) {
          notifiedTasks.add(update.task.id)
          if (window.Notification) {
            new window.Notification(
              update.type === 'completed' ? 'Task completed' : 'Task failed',
              {
                body: update.task.command.slice(0, 100),
                tag: update.task.id,
              }
            )
          }
        }
      }
    })
    return unsub
  }, [visible, serverId])

  const handleCancel = useCallback(async (taskId: string) => {
    setLoading(true)
    try {
      await api.remoteServerCancelTask(serverId, taskId)
      // Immediately refresh
      const result = await api.remoteServerListTasks(serverId)
      if (result.success && result.data) {
        setTasks(result.data as RemoteTask[])
      }
    } catch {
      // Ignore
    } finally {
      setLoading(false)
    }
  }, [serverId])

  if (!visible) return null

  const runningCount = tasks.filter(t => t.status === 'running').length

  const statusIcon = (status: RemoteTask['status']) => {
    switch (status) {
      case 'running': return <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
      case 'completed': return <CheckCircle className="w-3.5 h-3.5 text-green-400" />
      case 'failed': return <XCircle className="w-3.5 h-3.5 text-red-400" />
      case 'cancelled': return <XCircle className="w-3.5 h-3.5 text-yellow-400" />
    }
  }

  const formatDuration = (startedAt: number, completedAt?: number) => {
    const end = completedAt || Date.now()
    const seconds = Math.floor((end - startedAt) / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${minutes}m ${secs}s`
  }

  return (
    <div className="border-t border-border bg-card">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Activity className="w-4 h-4" />
          <span>{t('Background Tasks')}</span>
          {runningCount > 0 && (
            <span className="px-1.5 py-0.5 text-xs bg-blue-500/20 text-blue-400 rounded-full">
              {runningCount}
            </span>
          )}
        </div>
        <button
          onClick={() => {
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = setInterval(async () => {
              const result = await api.remoteServerListTasks(serverId)
              if (result.success && result.data) setTasks(result.data as RemoteTask[])
            }, 3000)
          }}
          className="p-1 hover:bg-secondary rounded transition-colors"
          title={t('Refresh')}
        >
          <Terminal className="w-3.5 h-3.5" />
        </button>
      </div>

      {tasks.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground/60">
          {t('No background tasks')}
        </div>
      ) : (
        <div className="max-h-[200px] overflow-y-auto">
          {tasks.map(task => {
            const isExpanded = expandedId === task.id
            // Extract short command name (first 60 chars)
            const shortCmd = task.command.length > 60
              ? task.command.slice(0, 57) + '...'
              : task.command

            return (
              <div key={task.id} className="border-t border-border/50">
                {/* Task header */}
                <div
                  className="flex items-center gap-2 px-3 py-1.5 hover:bg-secondary/50 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : task.id)}
                >
                  {statusIcon(task.status)}
                  <span className="text-xs font-mono flex-1 truncate">{shortCmd}</span>
                  <span className="text-xs text-muted-foreground/60">
                    {formatDuration(task.startedAt, task.completedAt)}
                  </span>
                  {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </div>

                {/* Expanded output */}
                {isExpanded && (
                  <div className="px-3 pb-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-muted-foreground">
                        PID: {task.pid || '-'} | {task.outputLines} lines
                      </span>
                      {task.status === 'running' && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleCancel(task.id) }}
                          disabled={loading}
                          className="flex items-center gap-1 px-2 py-0.5 text-xs text-red-400 hover:bg-red-500/10 rounded transition-colors"
                        >
                          <X className="w-3 h-3" />
                          {t('Cancel')}
                        </button>
                      )}
                    </div>
                    <pre
                      ref={outputRef}
                      className="text-xs font-mono bg-black/30 rounded p-2 max-h-[120px] overflow-y-auto text-muted-foreground whitespace-pre-wrap break-all"
                    >
                      {task.output || '(no output yet)'}
                    </pre>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
