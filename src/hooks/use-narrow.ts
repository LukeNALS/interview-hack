"use client";

import { useCallback, useSyncExternalStore } from "react";

export const NARROW_BREAKPOINT_PX = 1100;

/**
 * true khi viewport < breakpoint (mặc định 1100px — breakpoint DUY NHẤT của
 * màn live: 3 cột → 1 cột + tab pill). SSR trả false (mặc định 3 cột).
 */
export function useNarrow(breakpoint: number = NARROW_BREAKPOINT_PX): boolean {
  // max-width (breakpoint − 0.02): 1099px = narrow, 1100px = 3 cột.
  const query = `(max-width: ${breakpoint - 0.02}px)`;

  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
