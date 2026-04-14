import React, { useState, useEffect, useCallback } from 'react'
import { CheckCircle, XCircle, Clock, AlertTriangle, Plus, ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '../../api'

// ============================================
// Types
// ============================================

interface TaskBoardTask {
  id: string
  title: string
  description: string
  status: 'posted' | 'claimed' | 'in_progress' | 'completed' | 'failed'
  priority: 'low' | 'normal' | 'high' | 'urgent'
  requiredCapabilities: string[]
  postedBy: string
  claimedBy?: string
  claimedByName?: string
  result?: string
  error?: string
  createdAt: number
  updatedAt: number
}

interface TaskBoardPanelProps {
  spaceId: string
  visible?: boolean
}

// ============================================
// Component
// ============================================

export function TaskBoardPanel({ spaceId, visible = true }: TaskBoardPanelProps) {
  const [tasks, setTasks] = useState<TaskBoardTask[]>([])
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  const [showPostForm, setShowPostForm] = useState(false)
  const [newTask, setNewTask] = useState({ title: '', description: '', priority: 'normal' as const })

  const loadTasks = useCallback(async () => {
    try {
      const result = await api.getTaskBoard(spaceId)
      if (result.success) {
        setTasks(result.data.tasks)
      }
    } catch (err) {
      console.error('Failed to load task board:', err)
    }
  }, [spaceId])

  useEffect(() => {
    if (visible && spaceId) {
      loadTasks()
      const interval = setInterval(loadTasks, 5000) // Refresh every 5s
      return () => clearInterval(interval)
    }
  }, [visible, spaceId, loadTasks])

  const handlePostTask = async () => {
    if (!newTask.title.trim()) return
    try {
      await api.postTask(spaceId, {
        title: newTask.title,
        description: newTask.description,
        priority: newTask.priority
      })
      setNewTask({ title: '', description: '', priority: 'normal' })
      setShowPostForm(false)
      loadTasks()
    } catch (err) {
      console.error('Failed to post task:', err)
    }
  }

  const handleClaimTask = async (taskId: string) => {
    try {
      await api.claimTask(spaceId, taskId)
      loadTasks()
    } catch (err) {
      console.error('Failed to claim task:', err)
    }
  }

  if (!visible) return null

  const statusIcon = (status: string) => {
    switch (status) {
      case 'posted': return <Clock size={14} className="text-muted-foreground" />
      case 'claimed': return <AlertTriangle size={14} className="text-yellow-500" />
      case 'in_progress': return <div className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      case 'completed': return <CheckCircle size={14} className="text-green-500" />
      case 'failed': return <XCircle size={14} className="text-red-500" />
      default: return null
    }
  }

  const priorityBadge = (priority: string) => {
    const styles: Record<string, string> = {
      low: 'bg-gray-100 text-gray-600',
      normal: 'bg-blue-50 text-blue-600',
      high: 'bg-orange-50 text-orange-600',
      urgent: 'bg-red-50 text-red-600'
    }
    return (
      <span className={`text-[10px] px-1.5 py-0.5 rounded ${styles[priority] || styles.normal}`}>
        {priority}
      </span>
    )
  }

  return (
    <div className="border-t border-border/30 p-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">
          TaskBoard ({tasks.length})
        </span>
        <button
          onClick={() => setShowPostForm(!showPostForm)}
          className="p-1 hover:bg-accent rounded"
          title="Post task"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Post task form */}
      {showPostForm && (
        <div className="mb-2 p-2 bg-accent/30 rounded-lg border border-border/30">
          <input
            type="text"
            placeholder="Task title..."
            value={newTask.title}
            onChange={e => setNewTask({ ...newTask, title: e.target.value })}
            className="w-full text-xs bg-transparent border-b border-border/30 pb-1 mb-1.5 outline-none"
            autoFocus
          />
          <textarea
            placeholder="Description (optional)..."
            value={newTask.description}
            onChange={e => setNewTask({ ...newTask, description: e.target.value })}
            className="w-full text-xs bg-transparent resize-none outline-none mb-1.5"
            rows={2}
          />
          <div className="flex items-center gap-2">
            <select
              value={newTask.priority}
              onChange={e => setNewTask({ ...newTask, priority: e.target.value as any })}
              className="text-xs bg-background border border-border/30 rounded px-1.5 py-0.5"
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
            <button
              onClick={handlePostTask}
              disabled={!newTask.title.trim()}
              className="text-xs bg-primary text-primary-foreground px-2 py-0.5 rounded disabled:opacity-50"
            >
              Post
            </button>
            <button
              onClick={() => { setShowPostForm(false); setNewTask({ title: '', description: '', priority: 'normal' }) }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Task list */}
      <div className="space-y-1 max-h-[300px] overflow-y-auto">
        {tasks.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-3">
            No tasks on the board
          </div>
        ) : (
          tasks.map(task => (
            <div key={task.id} className="group">
              <div
                className="flex items-center gap-1.5 py-1 px-1.5 rounded hover:bg-accent/50 cursor-pointer"
                onClick={() => setExpandedTaskId(expandedTaskId === task.id ? null : task.id)}
              >
                {expandedTaskId === task.id
                  ? <ChevronDown size={12} className="text-muted-foreground shrink-0" />
                  : <ChevronRight size={12} className="text-muted-foreground shrink-0" />
                }
                {statusIcon(task.status)}
                <span className="text-xs truncate flex-1" title={task.title}>
                  {task.title}
                </span>
                {priorityBadge(task.priority)}
                {task.status === 'posted' && (
                  <button
                    onClick={e => { e.stopPropagation(); handleClaimTask(task.id) }}
                    className="text-[10px] text-primary hover:underline opacity-0 group-hover:opacity-100"
                  >
                    Claim
                  </button>
                )}
              </div>

              {/* Expanded details */}
              {expandedTaskId === task.id && (
                <div className="ml-5 mt-0.5 mb-1 p-1.5 bg-accent/20 rounded text-xs">
                  {task.description && (
                    <p className="text-muted-foreground mb-1">{task.description}</p>
                  )}
                  <div className="text-[10px] text-muted-foreground/70 space-y-0.5">
                    <div>Posted by: {task.postedBy}</div>
                    {task.claimedByName && <div>Assigned to: {task.claimedByName}</div>}
                    <div>Created: {new Date(task.createdAt).toLocaleTimeString()}</div>
                    {task.requiredCapabilities.length > 0 && (
                      <div>Needs: {task.requiredCapabilities.join(', ')}</div>
                    )}
                    {task.result && (
                      <div className="mt-1 text-green-700">Result: {task.result.substring(0, 200)}</div>
                    )}
                    {task.error && (
                      <div className="mt-1 text-red-600">Error: {task.error}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
