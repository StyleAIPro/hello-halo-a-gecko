/**
 * useInputHistory - Arrow key navigation through user message history
 *
 * Allows users to press Up/Down arrows in the input area to browse
 * previous user messages in the current conversation.
 *
 * State:
 * - historyIndex: ref tracking position in user message list (-1 = not browsing)
 * - savedDraft: ref preserving user's unsent input when entering browse mode
 */

import { useRef, useEffect, useMemo, useCallback } from 'react';
import { useChatStore } from '../stores/chat.store';

interface UseInputHistoryOptions {
  conversationId: string | undefined;
  content: string;
  setContent: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function useInputHistory({
  conversationId,
  content,
  setContent,
  textareaRef,
}: UseInputHistoryOptions) {
  const historyIndex = useRef(-1);
  const savedDraft = useRef('');

  // Subscribe to current conversation from cache
  const conversation = useChatStore((state) =>
    conversationId ? (state.conversationCache.get(conversationId) ?? null) : null,
  );

  // Extract user messages from current conversation
  const userMessages = useMemo(() => {
    if (!conversation) return [];
    return conversation.messages
      .filter((msg) => msg.role === 'user')
      .map((msg) => msg.content)
      .filter((c) => c.trim().length > 0);
  }, [conversation]);

  // Reset on conversation change
  useEffect(() => {
    historyIndex.current = -1;
    savedDraft.current = '';
  }, [conversationId]);

  // Move cursor to end of textarea
  const moveCursorToEnd = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const len = textarea.value.length;
    textarea.setSelectionRange(len, len);
  }, [textareaRef]);

  // Navigate history: direction -1 = older, +1 = newer
  const navigateHistory = useCallback(
    (direction: -1 | 1) => {
      const total = userMessages.length;
      if (total === 0) return;

      if (historyIndex.current === -1) {
        // First time entering browse mode
        if (direction === -1) {
          savedDraft.current = content;
          historyIndex.current = total - 1;
          setContent(userMessages[historyIndex.current]);
          moveCursorToEnd();
        }
        return;
      }

      const newIndex = historyIndex.current + direction;

      if (newIndex < 0) {
        // Already at oldest, do nothing
        return;
      }

      if (newIndex >= total) {
        // Past newest, restore draft and exit
        historyIndex.current = -1;
        setContent(savedDraft.current);
        savedDraft.current = '';
        moveCursorToEnd();
        return;
      }

      historyIndex.current = newIndex;
      setContent(userMessages[newIndex]);
      moveCursorToEnd();
    },
    [userMessages, content, setContent, moveCursorToEnd],
  );

  // Check if cursor is on the first line of textarea content
  const isOnFirstLine = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return false;
    const pos = textarea.selectionStart;
    return !textarea.value.substring(0, pos).includes('\n');
  }, [textareaRef]);

  // Check if cursor is on the last line of textarea content
  const isOnLastLine = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return false;
    const pos = textarea.selectionStart;
    return !textarea.value.substring(pos).includes('\n');
  }, [textareaRef]);

  // Check if cursor is at column 0 of current line
  const isAtLineStart = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return false;
    const pos = textarea.selectionStart;
    const textBefore = textarea.value.substring(0, pos);
    const lastNewline = textBefore.lastIndexOf('\n');
    return pos === 0 || pos === lastNewline + 1;
  }, [textareaRef]);

  // Check if cursor is at end of current line
  const isAtLineEnd = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return false;
    const pos = textarea.selectionStart;
    const textAfter = textarea.value.substring(pos);
    const nextNewline = textAfter.indexOf('\n');
    return nextNewline === -1; // no newline after cursor → at end of last line
  }, [textareaRef]);

  // KeyDown handler - call after mention/slash handlers
  // Behavior (matches terminal/Claude Code CLI):
  // ArrowUp:   not on first line → let default | first line, not col 0 → move to col 0 | first line, col 0 → browse history
  // ArrowDown: not on last line  → let default | last line, not end    → move to end   | last line, at end → browse history
  const handleHistoryKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const textarea = textareaRef.current;
      if (!textarea) return false;

      // If user has a text selection, let default behavior
      if (textarea.selectionStart !== textarea.selectionEnd) return false;

      if (e.key === 'ArrowUp') {
        if (!isOnFirstLine()) {
          // More lines above → let default cursor movement
          return false;
        }
        if (!isAtLineStart()) {
          // First line but not at column 0 → move cursor to start of line
          e.preventDefault();
          const textBefore = textarea.value.substring(0, textarea.selectionStart);
          const lastNewline = textBefore.lastIndexOf('\n');
          textarea.setSelectionRange(lastNewline + 1, lastNewline + 1);
          return true;
        }
        // At column 0 of first line → browse history
        e.preventDefault();
        navigateHistory(-1);
        return true;
      }

      if (e.key === 'ArrowDown') {
        if (!isOnLastLine()) {
          // More lines below → let default cursor movement
          return false;
        }
        if (!isAtLineEnd()) {
          // Last line but not at end → move cursor to end of line
          e.preventDefault();
          const pos = textarea.selectionStart;
          const textAfter = textarea.value.substring(pos);
          const nextNewline = textAfter.indexOf('\n');
          const endOfLine = nextNewline === -1 ? textarea.value.length : pos + nextNewline;
          textarea.setSelectionRange(endOfLine, endOfLine);
          return true;
        }
        // At end of last line → browse history
        e.preventDefault();
        navigateHistory(1);
        return true;
      }

      return false;
    },
    [navigateHistory, textareaRef, isOnFirstLine, isOnLastLine, isAtLineStart, isAtLineEnd],
  );

  // Exit browse mode on user input
  const handleHistoryInputChange = useCallback(() => {
    if (historyIndex.current !== -1) {
      historyIndex.current = -1;
      savedDraft.current = '';
    }
  }, []);

  // Reset on send
  const resetHistory = useCallback(() => {
    historyIndex.current = -1;
    savedDraft.current = '';
  }, []);

  return {
    handleHistoryKeyDown,
    handleHistoryInputChange,
    resetHistory,
  };
}
