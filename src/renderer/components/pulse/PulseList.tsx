/**
 * PulseList - Shared presentational component for rendering pulse task items
 *
 * Pure list rendering of active tasks, unseen completions, and pinned conversations.
 * Used by PulseSidebarSection in the conversation list sidebar.
 *
 * Responsibilities:
 * - Renders grouped items (active first, then pinned idle)
 * - Uses TaskCard for rich progress display
 * - Cross-space navigation on click
 * - Empty state
 *
 * Does NOT handle: positioning, open/close, collapse/expand, or responsive logic.
 */

import { useCallback, useMemo } from 'react'
import { usePulseItems, useChatStore } from '../../stores/chat.store'
import { useSpaceStore } from '../../stores/space.store'
import { useAppStore } from '../../stores/app.store'
import { useTranslation } from '../../i18n'
import { TaskCard } from './TaskCard'
import type { PulseItem } from '../../types'

/**
 * Navigate to a conversation, handling cross-space switching.
 * Extracted as a standalone function so it can be called from any context.
 */
export function navigateToConversation(spaceId: string, conversationId: string) {
  const chatStore = useChatStore.getState()
  const currentSpaceId = chatStore.currentSpaceId

  if (currentSpaceId === spaceId) {
    chatStore.selectConversation(conversationId)
    return
  }

  // Different space - switch space first
  const spaceStore = useSpaceStore.getState()
  const targetSpace = spaceStore.haloSpace?.id === spaceId
    ? spaceStore.haloSpace
    : spaceStore.spaces.find(s => s.id === spaceId)

  if (!targetSpace) return

  // Set flag for SpacePage to consume after it finishes loading conversations
  useChatStore.setState({ pendingPulseNavigation: conversationId })

  // Switch space — SpacePage's initSpace will pick up the flag and call selectConversation
  spaceStore.setCurrentSpace(targetSpace)
  useAppStore.getState().setView('space')
}

interface PulseListProps {
  /** Max height for the scrollable area (CSS value) */
  maxHeight?: string
  /** Callback after an item is clicked (e.g. to close a panel) */
  onItemClick?: () => void
  /** Whether to show compact items (smaller padding) */
  compact?: boolean
}

export function PulseList({ maxHeight = '360px', onItemClick, compact = false }: PulseListProps) {
  const { t } = useTranslation()
  const rawItems = usePulseItems()
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const spaces = useSpaceStore(state => state.spaces)

  // Enrich items with proper space names from space store
  const items = useMemo(() => {
    return rawItems.map(item => {
      if (item.spaceName !== item.spaceId) return item
      const space = haloSpace?.id === item.spaceId
        ? haloSpace
        : spaces.find(s => s.id === item.spaceId)
      return space ? { ...item, spaceName: space.isTemp ? 'Halo' : space.name } : item
    })
  }, [rawItems, haloSpace, spaces])

  const activeItems = items.filter(i => i.status !== 'idle')
  const pinnedIdleItems = items.filter(i => i.status === 'idle')

  if (items.length === 0) {
    return (
      <div className="px-4 py-6 text-center">
        <p className="text-sm text-muted-foreground">{t('No active tasks')}</p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          {t('Tasks and pinned conversations appear here')}
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-auto scrollbar-thin" style={{ maxHeight }}>
      {/* Active items — rendered as TaskCards */}
      {activeItems.length > 0 && (
        <div className="py-1">
          {activeItems.map(item => (
            <TaskCard
              key={item.conversationId}
              item={item}
              onItemClick={onItemClick}
              compact={compact}
            />
          ))}
        </div>
      )}

      {/* Divider */}
      {activeItems.length > 0 && pinnedIdleItems.length > 0 && (
        <div className="mx-4 border-t border-border/30" />
      )}

      {/* Pinned idle items — rendered as TaskCards */}
      {pinnedIdleItems.length > 0 && (
        <div className="py-1">
          {pinnedIdleItems.map(item => (
            <TaskCard
              key={item.conversationId}
              item={item}
              onItemClick={onItemClick}
              compact={compact}
            />
          ))}
        </div>
      )}
    </div>
  )
}
