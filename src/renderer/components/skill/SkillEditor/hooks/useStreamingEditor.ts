/**
 * useStreamingEditor - 流式内容编辑器 Hook
 *
 * 功能：
 * 1. 将流式内容实时更新到编辑器
 * 2. 管理编辑器内容和原始内容的差异
 * 3. 处理文本选择状态
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { EditorView } from '@codemirror/view'
import type { CodeMirrorEditorRef } from '../../../canvas/viewers/CodeMirrorEditor'

export interface SelectionState {
  text: string
  from: number
  to: number
  lineFrom: number
  lineTo: number
}

interface UseStreamingEditorOptions {
  /** 编辑器 ref */
  editorRef: React.RefObject<CodeMirrorEditorRef>
  /** 初始内容 */
  initialContent?: string
  /** 流式内容 */
  streamingContent?: string
  /** 是否正在流式输出 */
  isStreaming?: boolean
  /** 内容变更回调 */
  onChange?: (content: string) => void
  /** 选择变更回调 */
  onSelectionChange?: (selection: SelectionState | null) => void
}

interface UseStreamingEditorReturn {
  /** 当前编辑器内容 */
  content: string
  /** 原始内容（用于比较是否有变更） */
  originalContent: string
  /** 是否有未保存的变更 */
  hasChanges: boolean
  /** 当前选择状态 */
  selection: SelectionState | null
  /** 是否正在流式更新 */
  isStreamingActive: boolean

  /** 设置内容 */
  setContent: (content: string) => void
  /** 设置原始内容（用于重置变更状态） */
  setOriginalContent: (content: string) => void
  /** 重置变更状态 */
  resetChanges: () => void
  /** 获取编辑器视图 */
  getEditorView: () => EditorView | null
  /** 聚焦编辑器 */
  focusEditor: () => void
  /** 获取当前内容 */
  getCurrentContent: () => string
}

export function useStreamingEditor(options: UseStreamingEditorOptions): UseStreamingEditorReturn {
  const {
    editorRef,
    initialContent = '',
    streamingContent = '',
    isStreaming = false,
    onChange,
    onSelectionChange,
  } = options

  // 状态
  const [content, setContentState] = useState(initialContent)
  const [originalContent, setOriginalContentState] = useState(initialContent)
  const [selection, setSelection] = useState<SelectionState | null>(null)

  // Refs
  const lastStreamingContentRef = useRef('')
  const isStreamingRef = useRef(isStreaming)

  // 更新 isStreaming ref
  useEffect(() => {
    isStreamingRef.current = isStreaming
  }, [isStreaming])

  // 当 initialContent 变化时更新内容
  useEffect(() => {
    if (initialContent !== content && !isStreamingRef.current) {
      setContentState(initialContent)
      setOriginalContentState(initialContent)
    }
  }, [initialContent])

  // 流式内容更新到编辑器
  useEffect(() => {
    if (!streamingContent || streamingContent === lastStreamingContentRef.current) return

    const view = editorRef.current?.getView()
    if (!view) return

    const delta = streamingContent.slice(lastStreamingContentRef.current.length)
    if (delta) {
      const currentContent = view.state.doc.toString()
      view.dispatch({
        changes: { from: currentContent.length, insert: delta },
      })
      // 更新本地内容状态
      const newContent = currentContent + delta
      setContentState(newContent)
      onChange?.(newContent)
    }
    lastStreamingContentRef.current = streamingContent
  }, [streamingContent, editorRef, onChange])

  // 重置流式内容追踪（当切换文件或会话时）
  useEffect(() => {
    if (!isStreaming) {
      // 流式结束时，重置追踪
      lastStreamingContentRef.current = ''
    }
  }, [isStreaming])

  // 文本选择处理
  useEffect(() => {
    const view = editorRef.current?.getView()
    if (!view || !onSelectionChange) return

    const handleMouseUp = () => {
      const sel = view.state.selection.main
      if (sel.from !== sel.to) {
        const text = view.state.doc.sliceString(sel.from, sel.to)
        const lineFrom = view.state.doc.lineAt(sel.from).number
        const lineTo = view.state.doc.lineAt(sel.to).number
        const newSelection: SelectionState = {
          text,
          from: sel.from,
          to: sel.to,
          lineFrom,
          lineTo,
        }
        setSelection(newSelection)
        onSelectionChange(newSelection)
      } else {
        setSelection(null)
        onSelectionChange(null)
      }
    }

    view.dom.addEventListener('mouseup', handleMouseUp)
    return () => view.dom.removeEventListener('mouseup', handleMouseUp)
  }, [editorRef, onSelectionChange])

  // 计算是否有变更
  const hasChanges = content !== originalContent

  // 方法实现
  const setContent = useCallback((newContent: string) => {
    setContentState(newContent)
    const view = editorRef.current?.getView()
    if (view) {
      const currentContent = view.state.doc.toString()
      if (currentContent !== newContent) {
        view.dispatch({
          changes: { from: 0, to: currentContent.length, insert: newContent },
        })
      }
    }
    onChange?.(newContent)
  }, [editorRef, onChange])

  const setOriginalContent = useCallback((newOriginal: string) => {
    setOriginalContentState(newOriginal)
  }, [])

  const resetChanges = useCallback(() => {
    setOriginalContentState(content)
  }, [content])

  const getEditorView = useCallback(() => {
    return editorRef.current?.getView() || null
  }, [editorRef])

  const focusEditor = useCallback(() => {
    editorRef.current?.focus()
  }, [editorRef])

  const getCurrentContent = useCallback(() => {
    return editorRef.current?.getContent() || content
  }, [editorRef, content])

  return {
    content,
    originalContent,
    hasChanges,
    selection,
    isStreamingActive: isStreaming,

    setContent,
    setOriginalContent,
    resetChanges,
    getEditorView,
    focusEditor,
    getCurrentContent,
  }
}
