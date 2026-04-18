import React from 'react';
import { Crown, Wrench } from 'lucide-react';

// ============================================
// Types
// ============================================

interface AgentMessageBadgeProps {
  agentId: string;
  agentName?: string;
  agentRole?: 'leader' | 'worker';
  isOnline?: boolean;
  size?: 'sm' | 'md';
}

// ============================================
// Color Generation
// ============================================

/**
 * Generate a consistent color from an agent ID string.
 * Uses a simple hash to pick from a predefined palette.
 */
function getAgentColor(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = agentId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const palette = [
    '#3B82F6', // blue
    '#10B981', // emerald
    '#F59E0B', // amber
    '#8B5CF6', // violet
    '#EC4899', // pink
    '#06B6D4', // cyan
    '#F97316', // orange
    '#6366F1', // indigo
    '#14B8A6', // teal
    '#E11D48', // rose
  ];
  return palette[Math.abs(hash) % palette.length];
}

// ============================================
// Component
// ============================================

/**
 * Colored avatar badge for agent messages in group chat.
 * Shows agent initial, role icon, and online status indicator.
 */
export function AgentMessageBadge({
  agentId,
  agentName,
  agentRole,
  isOnline = true,
  size = 'sm',
}: AgentMessageBadgeProps) {
  const color = getAgentColor(agentId);
  const initial = (agentName || agentId || '?')[0].toUpperCase();
  const isSm = size === 'sm';

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative">
        <div
          className="flex items-center justify-center rounded-full text-white font-medium"
          style={{
            backgroundColor: color,
            width: isSm ? 22 : 28,
            height: isSm ? 22 : 28,
            fontSize: isSm ? 10 : 13,
          }}
        >
          {initial}
        </div>
        {/* Online status dot */}
        <div
          className={`absolute -bottom-0.5 -right-0.5 rounded-full border border-background ${
            isOnline ? 'bg-green-400' : 'bg-gray-400'
          }`}
          style={{ width: 8, height: 8 }}
        />
      </div>
      <div className="flex flex-col">
        <span className={`text-muted-foreground leading-none ${isSm ? 'text-[11px]' : 'text-xs'}`}>
          {agentName || agentId}
        </span>
        {agentRole && (
          <span className="flex items-center gap-0.5 leading-none">
            {agentRole === 'leader' ? (
              <Crown size={9} className="text-purple-500" />
            ) : (
              <Wrench size={9} className="text-blue-500" />
            )}
            <span className="text-[9px] text-muted-foreground/60">
              {agentRole === 'leader' ? 'Leader' : 'Worker'}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
