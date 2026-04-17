"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";

type RealtimeEvent = "INSERT" | "UPDATE" | "DELETE" | "*";

interface Options {
  /** Supabase table name in the `public` schema (e.g. "files"). */
  table: string;
  /** Events to listen for. Defaults to all. */
  event?: RealtimeEvent;
  /**
   * Postgres-changes filter string, e.g. `tenantId=eq.${tenantId}`.
   * Always scope by tenantId so one tenant's writes don't wake another
   * tenant's clients. Pass `undefined` only for truly global tables.
   */
  filter?: string;
  /**
   * Called when any matching row changes. Keep this cheap — the hook
   * debounces bursts (e.g. bulk transitions) but the callback still
   * fires once per quiet period.
   */
  onChange: () => void;
  /**
   * Milliseconds to coalesce bursts of changes before firing onChange.
   * Defaults to 250ms — enough to absorb a bulk-transition storm
   * without making single updates feel laggy.
   */
  debounceMs?: number;
  /**
   * Optional — when false, the subscription is torn down. Lets a
   * caller pause realtime (e.g. while a modal is open) without
   * unmounting the component.
   */
  enabled?: boolean;
}

/**
 * Subscribe a page-scoped component to Supabase `postgres_changes` on a
 * single table and invoke `onChange` whenever a matching row is
 * inserted, updated, or deleted.
 *
 * The channel is created on mount and removed on unmount, so the
 * websocket lives only as long as the page that needs it — unlike the
 * global notification subscription which lives for the whole session.
 *
 * Pattern for new realtime surfaces:
 *
 *   useRealtimeTable({
 *     table: "files",
 *     filter: `tenantId=eq.${tenantId}`,
 *     onChange: refresh,
 *   });
 *
 * Remember that every table you subscribe to must also be added to the
 * Supabase `supabase_realtime` publication (Database → Replication in
 * the dashboard, or `ALTER PUBLICATION supabase_realtime ADD TABLE
 * public.<table>;`). Otherwise the channel will connect silently and
 * never receive events.
 */
export function useRealtimeTable({
  table,
  event = "*",
  filter,
  onChange,
  debounceMs = 250,
  enabled = true,
}: Options) {
  // Stash the latest callback in a ref so the effect doesn't re-subscribe
  // every render just because the caller passed a new inline function.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    if (!enabled) return;

    const supabase = createClient();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const fire = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        onChangeRef.current();
      }, debounceMs);
    };

    // Unique channel name per (table, filter) so two hooks on the same
    // page don't clobber each other. Randomness avoids collisions when
    // the same component mounts twice (Strict Mode dev double-mount).
    const channelName = `rt:${table}:${filter ?? "all"}:${Math.random().toString(36).slice(2, 8)}`;

    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        // Supabase's types for this payload are loose; the cast keeps
        // the hook generic without leaking `any` to callers.
        { event, schema: "public", table, ...(filter ? { filter } : {}) } as never,
        fire
      )
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, [table, event, filter, debounceMs, enabled]);
}
