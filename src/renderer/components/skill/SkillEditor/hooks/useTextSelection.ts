/**
 * useTextSelection - 文本选择处理 Hook
 *
 * 功能：
 * 1. 监听编辑器文本选择
 * 2. 管理选择菜单的显示位置
 * 3. 提供选择操作（修改、解释、优化等）
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { EditorView } from '@codemirror/view';

export interface TextSelection {
  text: string;
  from: number;
  to: number;
  lineFrom: number;
  lineTo: number;
}

interface UseTextSelectionOptions {
  /** 编辑器容器元素 ref */
  containerRef: React.RefObject<HTMLDivElement>;
  /** 编辑器视图 ref */
  editorViewRef: React.RefObject<EditorView | null>;
  /** 最小选择字符数（少于此数量不显示菜单） */
  minSelectionLength?: number;
  /** 选择变化回调 */
  onSelectionChange?: (selection: TextSelection | null) => void;
}

interface UseTextSelectionReturn {
  /** 当前选择状态 */
  selection: TextSelection | null;
  /** 是否显示选择菜单 */
  showMenu: boolean;
  /** 菜单位置 */
  menuPosition: { x: number; y: number };
  /** 清除选择 */
  clearSelection: () => void;
  /** 隐藏菜单 */
  hideMenu: () => void;
  /** 手动设置选择 */
  setSelection: (selection: TextSelection | null) => void;
}

export function useTextSelection(options: UseTextSelectionOptions): UseTextSelectionReturn {
  const { containerRef, editorViewRef, minSelectionLength = 10, onSelectionChange } = options;

  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });

  const isMenuPinnedRef = useRef(false);

  // 计算菜单位置
  const calculateMenuPosition = useCallback(
    (view: EditorView, from: number): { x: number; y: number } => {
      if (!containerRef.current) return { x: 0, y: 0 };

      try {
        // 获取选择起始位置的坐标
        const pos = view.posAtCoords(view.coordsAtPos(from) || null, false);
        if (pos === null) return { x: 0, y: 0 };

        const coords = view.coordsAtPos(from);
        if (!coords) return { x: 0, y: 0 };

        const containerRect = containerRef.current.getBoundingClientRect();

        // 计算相对于容器的位置
        return {
          x: coords.left - containerRect.left,
          y: coords.bottom - containerRect.top + 5, // 在选择文本下方 5px
        };
      } catch {
        return { x: 0, y: 0 };
      }
    },
    [containerRef],
  );

  // 处理鼠标释放事件
  const handleMouseUp = useCallback(() => {
    const view = editorViewRef.current;
    if (!view) return;

    const sel = view.state.selection.main;
    if (sel.from !== sel.to) {
      const text = view.state.doc.sliceString(sel.from, sel.to);
      const lineFrom = view.state.doc.lineAt(sel.from).number;
      const lineTo = view.state.doc.lineAt(sel.to).number;

      const newSelection: TextSelection = {
        text,
        from: sel.from,
        to: sel.to,
        lineFrom,
        lineTo,
      };

      setSelection(newSelection);
      onSelectionChange?.(newSelection);

      // 只有选择足够长的文本才显示菜单
      if (text.length >= minSelectionLength) {
        const position = calculateMenuPosition(view, sel.from);
        setMenuPosition(position);
        setShowMenu(true);
      }
    } else {
      // 如果菜单没有被固定，则隐藏
      if (!isMenuPinnedRef.current) {
        setSelection(null);
        setShowMenu(false);
        onSelectionChange?.(null);
      }
    }
  }, [editorViewRef, minSelectionLength, onSelectionChange, calculateMenuPosition]);

  // 绑定事件
  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;

    view.dom.addEventListener('mouseup', handleMouseUp);
    return () => view.dom.removeEventListener('mouseup', handleMouseUp);
  }, [editorViewRef, handleMouseUp]);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!showMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (isMenuPinnedRef.current) return;

      const target = e.target as HTMLElement;
      // 检查是否点击在编辑器外部
      if (containerRef.current && !containerRef.current.contains(target)) {
        setShowMenu(false);
        setSelection(null);
        onSelectionChange?.(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu, containerRef, onSelectionChange]);

  // 方法实现
  const clearSelection = useCallback(() => {
    const view = editorViewRef.current;
    if (view) {
      // 清除编辑器选择
      view.dispatch({
        selection: { anchor: view.state.selection.main.from },
      });
    }
    setSelection(null);
    setShowMenu(false);
    isMenuPinnedRef.current = false;
    onSelectionChange?.(null);
  }, [editorViewRef, onSelectionChange]);

  const hideMenu = useCallback(() => {
    setShowMenu(false);
    isMenuPinnedRef.current = false;
  }, []);

  const setSelectionManual = useCallback(
    (newSelection: TextSelection | null) => {
      setSelection(newSelection);
      if (newSelection) {
        onSelectionChange?.(newSelection);
      } else {
        setShowMenu(false);
        onSelectionChange?.(null);
      }
    },
    [onSelectionChange],
  );

  return {
    selection,
    showMenu,
    menuPosition,
    clearSelection,
    hideMenu,
    setSelection: setSelectionManual,
  };
}
