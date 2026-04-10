"use client";

import { useSyncExternalStore } from "react";

/**
 * Subscribe to a CSS media query and return whether it currently matches.
 *
 * Uses `useSyncExternalStore` so React 18+ concurrent rendering reads a
 * consistent value across renders, and so the effect rule against
 * synchronous setState doesn't apply (this hook stores nothing in state).
 *
 * Returns `false` during SSR to keep server and client output stable.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", notify);
      return () => mql.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false // SSR snapshot — assume "doesn't match"
  );
}
