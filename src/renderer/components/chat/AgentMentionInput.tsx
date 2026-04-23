/**
 * AgentMentionInput - @Agent mention input with autocomplete
 *
 * Features:
 * - Type '@' to trigger agent autocomplete
 * - Click to select an agent
 * - Supports keyboard navigation (ArrowUp/Down, Enter, Escape)
 * - Displays selected agent as a highlighted chip
 */

import React, { useState, useCallback, useRef, useEffect, memo } from 'react';
import { useTranslation } from '../../i18n';
import { api } from '../../api';
import { Crown, Wrench, Cloud, Monitor, X } from 'lucide-react';

interface AgentMember {
  id: string;
  name: string;
  role: 'leader' | 'worker';
  type: 'local' | 'remote';
  capabilities?: string[];
}

interface AgentMentionInputProps {
  spaceId: string;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  placeholder?: string;
  disabled?: boolean;
}

interface MentionSelection {
  agentId: string;
  agentName: string;
  startPos: number; // Position where @ starts
  endPos: number; // Current cursor position
}

export const AgentMentionInput = memo(function AgentMentionInput({
  spaceId,
  value,
  onChange,
  onSend,
  placeholder,
  disabled = false,
}: AgentMentionInputProps) {
  const { t } = useTranslation();

  // Agent members for autocomplete
  const [members, setMembers] = useState<AgentMember[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);

  // Mention state
  const [showMentionPopup, setShowMentionPopup] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [mentionSelection, setMentionSelection] = useState<MentionSelection | null>(null);

  // Refs
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const mentionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Load members when space changes
  useEffect(() => {
    if (!spaceId) return;

    setIsLoadingMembers(true);
    api
      .getHyperSpaceMembers(spaceId)
      .then((result) => {
        // API returns { success: true, data: { members: [...] } }
        if (result.success && result.data?.members) {
          setMembers(result.data.members);
        }
        setIsLoadingMembers(false);
      })
      .catch(() => {
        setIsLoadingMembers(false);
      });
  }, [spaceId]);

  // Filter members based on query
  const filteredMembers = members.filter((member) =>
    member.name.toLowerCase().includes(mentionQuery.toLowerCase()),
  );

  // Close popup when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) {
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

  // Parse text to find @ mentions
  const parseMentionPosition = useCallback((text: string, cursorPosition: number) => {
    // Find the last @ before cursor
    const atIndex = text.lastIndexOf('@', cursorPosition - 1);
    if (atIndex === -1) return null;

    // Check if there's a space or newline between @ and cursor
    const betweenAtAndCursor = text.substring(atIndex + 1, cursorPosition);
    if (/\s/.test(betweenAtAndCursor)) return null;

    return {
      startPos: atIndex,
      endPos: cursorPosition,
      query: betweenAtAndCursor,
    };
  }, []);

  // Handle text change
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      const cursorPosition = e.target.selectionStart;

      onChange(newValue);

      // Check for @ mention
      const mentionInfo = parseMentionPosition(newValue, cursorPosition);

      if (mentionInfo && members.length > 0) {
        setMentionQuery(mentionInfo.query);
        setMentionSelection({
          agentId: '',
          agentName: '',
          startPos: mentionInfo.startPos,
          endPos: mentionInfo.endPos,
        });
        setShowMentionPopup(true);
      } else {
        setShowMentionPopup(false);
        setMentionSelection(null);
        setMentionQuery('');
      }
    },
    [onChange, parseMentionPosition, members.length],
  );

  // Handle key down for navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!showMentionPopup) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedMentionIndex((prev) => (prev < filteredMembers.length - 1 ? prev + 1 : 0));
          break;

        case 'ArrowUp':
          e.preventDefault();
          setSelectedMentionIndex((prev) => (prev > 0 ? prev - 1 : filteredMembers.length - 1));
          break;

        case 'Enter':
        case 'Tab':
          if (filteredMembers.length > 0) {
            e.preventDefault();
            selectAgent(filteredMembers[selectedMentionIndex]);
          }
          break;

        case 'Escape':
          e.preventDefault();
          setShowMentionPopup(false);
          setMentionSelection(null);
          break;
      }
    },
    [showMentionPopup, filteredMembers, selectedMentionIndex],
  );

  // Select an agent and insert into text
  const selectAgent = useCallback(
    (agent: AgentMember) => {
      if (!mentionSelection || !textareaRef.current) return;

      const textarea = textareaRef.current;
      const beforeText = value.substring(0, mentionSelection.startPos);
      const afterText = value.substring(mentionSelection.endPos);

      // Insert @AgentName format
      const mentionText = `@${agent.name} `;
      const newValue = beforeText + mentionText + afterText;

      onChange(newValue);

      // Update cursor position after the mention
      const newCursorPos = mentionSelection.startPos + mentionText.length;
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(newCursorPos, newCursorPos);
      }, 0);

      // Close popup
      setShowMentionPopup(false);
      setMentionSelection(null);
      setMentionQuery('');

      // Store the selected agent for send handler
      setMentionSelection({
        agentId: agent.id,
        agentName: agent.name,
        startPos: -1, // Mark as processed
        endPos: -1,
      });
    },
    [mentionSelection, value, onChange],
  );

  // Handle send with agent routing
  const handleSend = useCallback(() => {
    if (!value.trim()) return;

    // Check if there's a pending mention selection
    if (mentionSelection && mentionSelection.startPos === -1) {
      // Agent was selected via @ mention, send to that agent
      onSend(mentionSelection.agentId);
    } else {
      // No specific agent, send to leader by default
      onSend('leader');
    }
  }, [value, mentionSelection, onSend]);

  // Clear mention selection after sending
  const clearMentionSelection = useCallback(() => {
    setMentionSelection(null);
  }, []);

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled || isLoadingMembers}
        rows={1}
        className="w-full px-3 py-2 bg-secondary border border-border rounded-lg
          focus:outline-none focus:ring-1 focus:ring-primary resize-none
          disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ minHeight: '40px', maxHeight: '200px' }}
      />

      {/* Mention Popup */}
      {showMentionPopup && (
        <div
          ref={popupRef}
          className="absolute bottom-full left-0 mb-2 py-1 bg-popover border border-border
            rounded-lg shadow-lg min-w-[200px] max-h-[250px] overflow-y-auto z-50"
        >
          {isLoadingMembers ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">Loading agents...</div>
          ) : filteredMembers.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {mentionQuery ? 'No matching agents' : 'No agents available'}
            </div>
          ) : (
            filteredMembers.map((member, index) => (
              <button
                key={member.id}
                onClick={() => selectAgent(member)}
                className={`w-full px-3 py-2 flex items-center gap-2 text-sm
                  transition-colors ${
                    index === selectedMentionIndex
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground hover:bg-secondary'
                  }`}
              >
                {/* Role Icon */}
                {member.role === 'leader' ? (
                  <Crown className="w-4 h-4 text-purple-500 flex-shrink-0" />
                ) : (
                  <Wrench className="w-4 h-4 text-blue-500 flex-shrink-0" />
                )}

                {/* Type Icon */}
                {member.type === 'remote' ? (
                  <Cloud className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                ) : (
                  <Monitor className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                )}

                {/* Name */}
                <span className="flex-1 text-left">{member.name}</span>

                {/* Capabilities */}
                {member.capabilities && member.capabilities.length > 0 && (
                  <span className="text-xs text-muted-foreground truncate max-w-[100px]">
                    {member.capabilities.slice(0, 2).join(', ')}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
});

// Export a hook for using agent mention in parent components
export function useAgentMention(spaceId: string) {
  const [selectedAgent, setSelectedAgent] = useState<{ id: string; name: string } | null>(null);

  const handleSend = useCallback((agentIdOrRole: string) => {
    // This will be called from AgentMentionInput
    // The parent component should handle the actual sending logic
    console.log('[AgentMention] Sending to:', agentIdOrRole);
  }, []);

  return { selectedAgent, setSelectedAgent, handleSend };
}
