/**
 * useIsMobile - Shared hook for detecting mobile viewport
 *
 * Uses Tailwind's sm breakpoint (640px) as the threshold.
 * Components using this hook will re-render when crossing the breakpoint.
 *
 * Usage:
 *   const isMobile = useIsMobile()
 *   // isMobile is true when viewport width < 640px
 */

import { useState, useEffect } from 'react';

/** Mobile breakpoint matching Tailwind's sm: 640px */
export const MOBILE_BREAKPOINT = 640;

/**
 * Hook to detect if viewport is mobile-sized
 * @returns true if viewport width is less than 640px
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < MOBILE_BREAKPOINT;
  });

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return isMobile;
}
