"use client";

import { useCallback, useEffect, useRef } from "react";

/** Long enough to tell "about to click this" from "passing over it". */
export const HOVER_INTENT_MS = 80;

/**
 * Call `onIntent` once the pointer has rested on something briefly, or the
 * moment it presses down. Used to start a folder's listing before the click
 * that opens it lands, so the navigation renders from a request that is
 * already in flight.
 *
 * One timer serves a whole list: entering the next row cancels the previous
 * row's timer, so sweeping the pointer down a list fires nothing until it
 * stops. Cancelled on leave and on unmount.
 */
export function useHoverIntent<T>(onIntent: (target: T) => void, delayMs = HOVER_INTENT_MS) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => cancel, [cancel]);

  /** The pointer arrived; fire after the rest period unless it leaves first. */
  const begin = useCallback(
    (target: T) => {
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        onIntent(target);
      }, delayMs);
    },
    [cancel, onIntent, delayMs]
  );

  /**
   * The pointer pressed down, so a click is coming: fire now. Touch has no
   * hover, so for it this is the only path.
   */
  const now = useCallback(
    (target: T) => {
      cancel();
      onIntent(target);
    },
    [cancel, onIntent]
  );

  return { begin, cancel, now };
}
