"use client";

import { useSyncExternalStore } from "react";

/**
 * Returns `false` during SSR and `true` after the first client render.
 *
 * Use this to gate browser-only reads (theme, locale, window dimensions)
 * behind a hydration-safe boundary without violating the react-hooks rule
 * against synchronous setState in `useEffect`.
 *
 * Implemented with `useSyncExternalStore` so React's concurrent renderer
 * always reads a consistent snapshot.
 *
 * Example:
 *   const mounted = useHasMounted();
 *   if (!mounted) return <Skeleton />;
 *   return <div>{window.matchMedia(...)}</div>;
 */
export function useHasMounted(): boolean {
  return useSyncExternalStore(
    () => () => {}, // no subscription needed — there's nothing to listen to
    () => true,     // client snapshot
    () => false     // server snapshot
  );
}
