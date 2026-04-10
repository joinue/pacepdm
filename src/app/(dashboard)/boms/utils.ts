"use client";

import { useCallback, useRef } from "react";
import type { BOMItem } from "./types";

/**
 * Debounce a function call. Returns a stable callback that resets its
 * timer on every call and only fires `delay` ms after the last invocation.
 *
 * Used by the part/file search inputs in the Add Item dialog.
 */
export function useDebounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  delay: number
): T {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return useCallback((...args: Parameters<T>) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(...args), delay);
  }, [fn, delay]) as T;
}

/**
 * Flatten a list of BOM items into a depth-first traversal order, using
 * `parentItemId` as the tree edge. Each returned item carries an updated
 * `level` reflecting its depth in the tree (root items get level 0).
 *
 * The result preserves the input order of siblings — useful for stable
 * UI rendering when the user reorders items via sortOrder.
 */
export function buildTree(items: BOMItem[]): BOMItem[] {
  const map = new Map<string | null, BOMItem[]>();
  for (const item of items) {
    const key = item.parentItemId || null;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }

  function flatten(parentId: string | null, depth: number): BOMItem[] {
    const children = map.get(parentId) || [];
    const result: BOMItem[] = [];
    for (const child of children) {
      result.push({ ...child, level: depth });
      result.push(...flatten(child.id, depth + 1));
    }
    return result;
  }

  return flatten(null, 0);
}
