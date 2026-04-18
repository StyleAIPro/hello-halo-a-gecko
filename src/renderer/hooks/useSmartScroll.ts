/**
 * Smart Auto-Scroll Hook
 *
 * Implements ChatGPT-style intelligent scrolling:
 * - Auto-scrolls when user is at bottom
 * - Stops auto-scroll when user scrolls up to read history
 * - Shows "scroll to bottom" button when user is not at bottom
 * - Resumes auto-scroll when user returns to bottom
 */

import { useState, useCallback, useEffect, useRef } from 'react';

interface UseSmartScrollOptions {
  /** Scrollable container ref (required) */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Threshold in pixels to consider "at bottom" (default: 100) */
  threshold?: number;
  /** Dependencies that trigger scroll check (e.g., messages, streaming content) */
  deps?: unknown[];
  /** Scroll behavior for auto-scroll (default: 'smooth') */
  behavior?: ScrollBehavior;
}

interface UseSmartScrollReturn {
  /** Whether to show the "scroll to bottom" button */
  showScrollButton: boolean;
  /** Programmatically scroll to bottom */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** Call this on scroll event */
  handleScroll: () => void;
}

export function useSmartScroll(options: UseSmartScrollOptions): UseSmartScrollReturn {
  const { containerRef, threshold = 100, deps = [], behavior = 'smooth' } = options;

  // Track if user has scrolled away from bottom
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Track if scroll was triggered programmatically (to avoid false "user scrolled" detection)
  const isProgrammaticScroll = useRef(false);

  // Last scroll position to detect scroll direction
  const lastScrollTop = useRef(0);

  /**
   * Check if container is scrolled to bottom (within threshold)
   */
  const checkIsAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    return distanceFromBottom <= threshold;
  }, [containerRef, threshold]);

  /**
   * Handle scroll events - detect user scroll vs programmatic scroll
   */
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop } = container;
    const currentIsAtBottom = checkIsAtBottom();

    // If this was a programmatic scroll, just update state and return
    if (isProgrammaticScroll.current) {
      isProgrammaticScroll.current = false;
      setIsAtBottom(currentIsAtBottom);
      setShowScrollButton(!currentIsAtBottom);
      lastScrollTop.current = scrollTop;
      return;
    }

    // User scrolled up (away from bottom)
    if (scrollTop < lastScrollTop.current && !currentIsAtBottom) {
      setIsAtBottom(false);
      setShowScrollButton(true);
    }

    // User scrolled back to bottom
    if (currentIsAtBottom) {
      setIsAtBottom(true);
      setShowScrollButton(false);
    }

    lastScrollTop.current = scrollTop;
  }, [containerRef, checkIsAtBottom]);

  /**
   * Programmatically scroll to bottom
   */
  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const container = containerRef.current;
      if (!container) return;

      isProgrammaticScroll.current = true;
      container.scrollTo({
        top: container.scrollHeight,
        behavior,
      });

      // Update state after scroll
      setIsAtBottom(true);
      setShowScrollButton(false);
    },
    [containerRef],
  );

  /**
   * Auto-scroll when dependencies change, but only if user is at bottom
   */
  useEffect(() => {
    // Only auto-scroll if user hasn't scrolled away
    if (isAtBottom) {
      scrollToBottom(behavior);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, behavior]);

  return {
    showScrollButton,
    scrollToBottom,
    handleScroll,
  };
}
