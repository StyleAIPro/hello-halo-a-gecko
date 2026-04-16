/**
 * useSearchNavigation - Search result navigation and highlighting
 *
 * Listens for custom events from the search system:
 * - `search:navigate-to-message` — scrolls to a message and highlights the search term
 * - `search:clear-highlights` — removes all highlights
 *
 * Uses Virtuoso's scrollToIndex for virtual list navigation,
 * then applies DOM-based highlighting with retry logic.
 */

import { useEffect, useRef } from 'react'
import type { MessageListHandle } from '../components/chat/MessageList'

export function useSearchNavigation(
  messageListRef: React.RefObject<MessageListHandle | null>,
  displayMessagesRef: React.RefObject<{ id: string }[]>
): void {
  useEffect(() => {
    const handleNavigateToMessage = (event: Event) => {
      const customEvent = event as CustomEvent<{ messageId: string; query: string }>
      const { messageId, query } = customEvent.detail

      console.log(`[ChatView] Attempting to navigate to message: ${messageId}`)

      // Remove previous highlights from all messages
      document.querySelectorAll('.search-highlight').forEach(el => {
        el.classList.remove('search-highlight')
      })
      document.querySelectorAll('.search-term-highlight').forEach(el => {
        const textNode = document.createTextNode(el.textContent || '')
        el.replaceWith(textNode)
      })

      // Find message index in displayMessages
      const messageIndex = displayMessagesRef.current.findIndex(m => m.id === messageId)
      if (messageIndex === -1) {
        console.warn(`[ChatView] Message not found in displayMessages for ID: ${messageId}`)
        return
      }

      // Scroll to the message via Virtuoso
      messageListRef.current?.scrollToIndex(messageIndex, 'smooth')

      // Wait for Virtuoso to render the item, then apply DOM highlighting
      const applyHighlight = (retries = 0) => {
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`)
        if (!messageElement) {
          if (retries < 10) {
            setTimeout(() => applyHighlight(retries + 1), 100)
          } else {
            console.warn(`[ChatView] Message element not found after scrollToIndex for ID: ${messageId}`)
          }
          return
        }

        console.log(`[ChatView] Found message element, highlighting`)

        // Add highlight animation
        messageElement.classList.add('search-highlight')
        setTimeout(() => {
          messageElement.classList.remove('search-highlight')
        }, 2000)

        // Highlight search terms in the message
        const contentElement = messageElement.querySelector('[data-message-content]')
        if (contentElement && query) {
          try {
            const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
            const originalHTML = contentElement.innerHTML

            if (!originalHTML.includes('search-term-highlight')) {
              contentElement.innerHTML = originalHTML.replace(
                regex,
                '<mark class="search-term-highlight bg-yellow-400/30 font-semibold rounded px-0.5">$1</mark>'
              )
              console.log(`[ChatView] Highlighted search term: "${query}"`)
            }
          } catch (error) {
            console.error(`[ChatView] Error highlighting search term:`, error)
          }
        }
      }

      // Small delay to allow Virtuoso to scroll and render
      setTimeout(() => applyHighlight(), 150)
    }

    // Clear all search highlights when requested
    const handleClearHighlights = () => {
      console.log(`[ChatView] Clearing all search highlights`)
      document.querySelectorAll('.search-highlight').forEach(el => {
        el.classList.remove('search-highlight')
      })
      document.querySelectorAll('.search-term-highlight').forEach(el => {
        const textNode = document.createTextNode(el.textContent || '')
        el.replaceWith(textNode)
      })
    }

    window.addEventListener('search:navigate-to-message', handleNavigateToMessage)
    window.addEventListener('search:clear-highlights', handleClearHighlights)
    return () => {
      window.removeEventListener('search:navigate-to-message', handleNavigateToMessage)
      window.removeEventListener('search:clear-highlights', handleClearHighlights)
    }
  }, [messageListRef, displayMessagesRef])
}
