"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { fetchJson, errorMessage, isAbortError, ApiError } from "@/lib/api-client";

interface UseFetchOptions {
  /** If false, the request is not made until `refetch()` is called manually. */
  enabled?: boolean;
  /** Called once on successful mount fetch. Useful for syncing derived state. */
  onSuccess?: (data: unknown) => void;
}

interface UseFetchResult<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | Error | null;
  /** Re-run the fetch. Aborts any in-flight request first. */
  refetch: () => Promise<void>;
  /** Manually patch the local data without re-fetching (for optimistic updates). */
  setData: (updater: T | ((prev: T | null) => T | null)) => void;
}

/**
 * Standard client-side data fetching hook.
 *
 * - Uses `fetchJson` (centralized error handling, safe JSON parsing)
 * - Aborts in-flight requests on unmount or URL change
 * - Surfaces errors as `Error` instances instead of swallowing them
 * - Returns a `refetch` function for explicit refresh after mutations
 *
 * Use this in client components instead of writing your own
 * `useState + useCallback + useEffect + fetch` boilerplate.
 *
 * Example:
 *   const { data: boms, loading, refetch } = useFetch<BOM[]>("/api/boms");
 *   if (loading) return <Skeleton />;
 *   if (!boms) return null;
 *   return <BomList boms={boms} onChange={refetch} />;
 *
 * For server components, prefer fetching directly via Supabase in
 * the async page component — this hook is only for the client side.
 */
export function useFetch<T>(url: string | null, options: UseFetchOptions = {}): UseFetchResult<T> {
  const { enabled = true, onSuccess } = options;
  const [data, setDataState] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled && url !== null);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Stash callbacks in refs so the effect doesn't re-run when consumers
  // pass new function identities each render.
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const performFetch = useCallback(async () => {
    if (!url) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const result = await fetchJson<T>(url, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setDataState(result);
      onSuccessRef.current?.(result);
    } catch (err) {
      if (isAbortError(err)) return;
      const e = err instanceof Error ? err : new Error(errorMessage(err));
      setError(e);
    } finally {
      if (abortRef.current === controller) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    if (!enabled || !url) {
      setLoading(false);
      return;
    }
    performFetch();
    return () => abortRef.current?.abort();
  }, [enabled, url, performFetch]);

  const setData = useCallback(
    (updater: T | ((prev: T | null) => T | null)) => {
      setDataState((prev) =>
        typeof updater === "function" ? (updater as (prev: T | null) => T | null)(prev) : updater
      );
    },
    []
  );

  return { data, loading, error, refetch: performFetch, setData };
}
