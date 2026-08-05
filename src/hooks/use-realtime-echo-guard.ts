"use client";

import { useCallback, useRef } from "react";

/**
 * Suppresses the realtime echo of the current tab's own writes.
 *
 * A surface that both refreshes after its own mutation *and* subscribes to
 * realtime on the same table fetches twice for one user action: once
 * explicitly, then again when Postgres replays the write the tab just made.
 *
 * Mark a local write before the request goes out; `isEcho()` then reports
 * true for a short window afterwards, and the realtime handler skips its
 * refresh. The explicit post-mutation refresh already has the fresh rows, so
 * nothing is lost.
 *
 * The trade-off is deliberate: a teammate's write landing inside the same
 * window is also skipped. That costs at most `windowMs` of staleness, since
 * any later event refreshes normally — and the window is sized just wide
 * enough to cover `useRealtimeTable`'s 250ms debounce plus replication lag.
 */
export function useRealtimeEchoGuard(windowMs = 1500) {
  const suppressUntilRef = useRef(0);

  const markLocalWrite = useCallback(() => {
    suppressUntilRef.current = Date.now() + windowMs;
  }, [windowMs]);

  const isEcho = useCallback(() => Date.now() < suppressUntilRef.current, []);

  return { markLocalWrite, isEcho };
}
