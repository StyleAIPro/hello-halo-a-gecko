/**
 * useMentionSystem - @Mention autocomplete for Hyper Space agents
 *
 * Detects @ typed in textarea, shows filtered popup, supports
 * keyboard navigation, inserts selected mention text, and
 * maintains targetAgentIds synced with @mentions in text.
 */

import { useState, useEffect, useCallback, useRef, type KeyboardEvent } from 'react';
import { api } from '../api';

export interface AgentMember {
  id: string;
  name: string;
  role: 'leader' | 'worker';
  type: 'local' | 'remote';
  capabilities?: string[];
}

interface UseMentionSystemOptions {
  spaceId: string | undefined;
  isHyperSpace: boolean;
  content: string;
  setContent: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

interface UseMentionSystemResult {
  targetAgentIds: string[];
  setTargetAgentIds: React.Dispatch<React.SetStateAction<string[]>>;
  showMentionPopup: boolean;
  mentionPopupRef: React.RefObject<HTMLDivElement | null>;
  filteredMembers: AgentMember[];
  selectedMentionIndex: number;
  handleTextChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  selectAgent: (agent: AgentMember) => void;
  handleMentionKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

export function useMentionSystem({
  spaceId,
  isHyperSpace,
  content,
  setContent,
  textareaRef,
}: UseMentionSystemOptions): UseMentionSystemResult {
  const [agentMembers, setAgentMembers] = useState<AgentMember[]>([]);
  const [showMentionPopup, setShowMentionPopup] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [mentionPosition, setMentionPosition] = useState<{ start: number; end: number } | null>(
    null,
  );
  const [targetAgentIds, setTargetAgentIds] = useState<string[]>([]);

  const mentionPopupRef = useRef<HTMLDivElement>(null);

  // Load agent members for Hyper Space only
  useEffect(() => {
    if (!spaceId || !isHyperSpace) {
      setAgentMembers([]);
      return;
    }

    api
      .getHyperSpaceMembers(spaceId)
      .then((result) => {
        if (result.success && result.data?.members) {
          setAgentMembers(result.data.members);
        }
      })
      .catch(console.error);
  }, [spaceId, isHyperSpace]);

  // Filter members based on query; include @all special option
  const allAgentOption: AgentMember = { id: '__all__', name: 'all', role: 'worker', type: 'local' };
  const filteredMembers = agentMembers.filter((member) =>
    member.name.toLowerCase().includes(mentionQuery.toLowerCase()),
  );
  const allInResults =
    filteredMembers.some((m) => m.id === '__all__') || mentionQuery.toLowerCase().includes('all');
  const displayMembers = allInResults ? filteredMembers : [allAgentOption, ...filteredMembers];

  // Close mention popup when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (mentionPopupRef.current && !mentionPopupRef.current.contains(event.target as Node)) {
        setShowMentionPopup(false);
      }
    };

    if (showMentionPopup) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showMentionPopup]);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedMentionIndex(0);
  }, [mentionQuery]);

  // Parse @ mention position in text
  const parseMentionPosition = useCallback((text: string, cursorPosition: number) => {
    const atIndex = text.lastIndexOf('@', cursorPosition - 1);
    if (atIndex === -1) return null;

    const betweenAtAndCursor = text.substring(atIndex + 1, cursorPosition);
    if (/\s/.test(betweenAtAndCursor)) return null;

    return {
      start: atIndex,
      end: cursorPosition,
      query: betweenAtAndCursor,
    };
  }, []);

  // Handle text change - check for @ mention and sync targetAgentIds
  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      const cursorPosition = e.target.selectionStart;

      setContent(newValue);

      // Check for @ mention - only in Hyper Space
      if (isHyperSpace && agentMembers.length > 0) {
        const mentionInfo = parseMentionPosition(newValue, cursorPosition);

        if (mentionInfo) {
          setMentionQuery(mentionInfo.query);
          setMentionPosition({ start: mentionInfo.start, end: mentionInfo.end });
          setShowMentionPopup(true);
        } else {
          setShowMentionPopup(false);
          setMentionQuery('');
          setMentionPosition(null);
        }

        // Sync targetAgentIds with remaining @mentions in text
        const remainingIds: string[] = [];
        for (const agent of agentMembers) {
          if (newValue.includes(`@${agent.name}`)) {
            remainingIds.push(agent.id);
          }
        }
        setTargetAgentIds(remainingIds);
      }
    },
    [parseMentionPosition, agentMembers, isHyperSpace, setContent],
  );

  // Select agent from mention popup
  const selectAgent = useCallback(
    (agent: AgentMember) => {
      if (!mentionPosition || !textareaRef.current) return;

      const textarea = textareaRef.current;
      const beforeText = content.substring(0, mentionPosition.start);
      const afterText = content.substring(mentionPosition.end);

      const mentionText = agent.id === '__all__' ? '@all ' : `@${agent.name} `;
      const newValue = beforeText + mentionText + afterText;

      setContent(newValue);

      // Handle @all: set a special marker so the store knows to broadcast
      if (agent.id === '__all__') {
        setTargetAgentIds(['__all__']);
      } else {
        setTargetAgentIds((prev) => (prev.includes(agent.id) ? prev : [...prev, agent.id]));
      }

      // Update cursor position after the mention
      const newCursorPos = mentionPosition.start + mentionText.length;
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(newCursorPos, newCursorPos);
      }, 0);

      // Close popup
      setShowMentionPopup(false);
      setMentionQuery('');
      setMentionPosition(null);
    },
    [mentionPosition, content, setContent, textareaRef],
  );

  // Handle key press - returns true if the key was consumed by the mention system
  const handleMentionKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (e.nativeEvent.isComposing) return false;

      if (showMentionPopup) {
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            setSelectedMentionIndex((prev) => (prev < displayMembers.length - 1 ? prev + 1 : 0));
            return true;

          case 'ArrowUp':
            e.preventDefault();
            setSelectedMentionIndex((prev) => (prev > 0 ? prev - 1 : displayMembers.length - 1));
            return true;

          case 'Enter':
          case 'Tab':
            if (displayMembers.length > 0 && mentionPosition) {
              e.preventDefault();
              selectAgent(displayMembers[selectedMentionIndex]);
              return true;
            }
            break;

          case 'Escape':
            e.preventDefault();
            setShowMentionPopup(false);
            setMentionQuery('');
            setMentionPosition(null);
            return true;
        }
      }

      return false;
    },
    [showMentionPopup, displayMembers, selectedMentionIndex, mentionPosition, selectAgent],
  );

  return {
    targetAgentIds,
    setTargetAgentIds,
    showMentionPopup,
    mentionPopupRef,
    filteredMembers,
    selectedMentionIndex,
    handleTextChange,
    selectAgent,
    handleMentionKeyDown,
  };
}
