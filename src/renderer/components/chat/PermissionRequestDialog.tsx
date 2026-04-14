/**
 * PermissionRequestDialog - Renders tool permission requests from remote workers
 *
 * When a worker agent on a remote NPU server needs user approval for a tool call,
 * this dialog presents the request in the main chat for the user to approve or deny.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { Shield, ShieldAlert, ShieldCheck } from 'lucide-react'

export interface PermissionRequestData {
  requestId: string
  requestingAgentId: string
  requestingAgentName: string
  toolName: string
  toolInput: Record<string, unknown>
  taskId?: string
  timestamp: number
}

interface PermissionRequestDialogProps {
  request: PermissionRequestData
  onResolve: (approved: boolean) => void
}

export function PermissionRequestDialog({ request, onResolve }: PermissionRequestDialogProps) {
  const [resolved, setResolved] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>()

  // Auto-deny after 5 minutes
  useEffect(() => {
    timeoutRef.current = setTimeout(() => {
      if (!resolved) {
        setResolved(true)
        onResolve(false)
      }
    }, 5 * 60 * 1000)
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [resolved, onResolve])

  const handleResolve = useCallback((approved: boolean) => {
    if (resolved) return
    setResolved(true)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    onResolve(approved)
  }, [resolved, onResolve])

  const formatToolInput = (input: Record<string, unknown>): string => {
    const entries = Object.entries(input).slice(0, 5) // Limit display
    if (entries.length === 0) return '(no input)'
    return entries.map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v)
      const truncated = val.length > 200 ? val.substring(0, 200) + '...' : val
      return `${k}: ${truncated}`
    }).join('\n')
  }

  return (
    <div className={`
      mt-3 rounded-xl border overflow-hidden transition-all duration-300
      ${resolved
        ? 'border-border/50 bg-card/30 opacity-50'
        : 'border-amber-400/60 bg-gradient-to-br from-amber-50/80 via-background to-amber-100/5 animate-fade-in'
      }
    `}>
      {/* Header */}
      <div className={`px-3 py-2 flex items-center gap-2 ${
        resolved
          ? 'bg-muted/30'
          : 'bg-gradient-to-r from-amber-500/10 to-transparent'
      }`}>
        {!resolved ? (
          <ShieldAlert size={14} className="text-amber-600 animate-pulse-gentle" />
        ) : (
          <ShieldCheck size={14} className="text-green-500" />
        )}
        <span className="text-xs font-medium text-foreground">
          Tool Permission Request
        </span>
        <span className="text-[10px] text-muted-foreground ml-auto">
          {new Date(request.timestamp).toLocaleTimeString()}
        </span>
      </div>

      {/* Body */}
      <div className="p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs">
          <Shield size={12} className="text-muted-foreground" />
          <span className="text-muted-foreground">
            Worker <strong className="text-foreground">{request.requestingAgentName}</strong>
            requests permission to use:
          </span>
        </div>

        {/* Tool name badge */}
        <div className="ml-5 px-2.5 py-1 bg-muted/50 rounded-md font-mono text-xs text-primary">
          {request.toolName}
        </div>

        {/* Tool input preview */}
        <div className="ml-5 p-2 bg-muted/30 rounded-md">
          <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap font-mono break-all">
            {formatToolInput(request.toolInput)}
          </pre>
        </div>

        {request.taskId && (
          <div className="text-[10px] text-muted-foreground/70 ml-5">
            Task: {request.taskId}
          </div>
        )}

        {/* Action buttons */}
        {!resolved && (
          <div className="flex items-center gap-2 pt-1 ml-5">
            <button
              onClick={() => handleResolve(true)}
              className="text-xs bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded-md transition-colors"
            >
              Approve
            </button>
            <button
              onClick={() => handleResolve(false)}
              className="text-xs bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded-md transition-colors"
            >
              Deny
            </button>
            <span className="text-[10px] text-muted-foreground/60">
              (auto-denies in 5 min)
            </span>
          </div>
        )}

        {/* Resolved status */}
        {resolved && (
          <div className="text-xs text-muted-foreground ml-5">
            {request.requestingAgentName}'s request has been resolved.
          </div>
        )}
      </div>
    </div>
  )
}
