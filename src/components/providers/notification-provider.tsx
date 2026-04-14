"use client";

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { useTenantUser } from "./tenant-provider";

interface NotificationActor {
  id: string;
  fullName: string;
}

interface Notification {
  id: string;
  title: string;
  message: string;
  type: "approval" | "transition" | "checkout" | "eco" | "system";
  link: string | null;
  isRead: boolean;
  createdAt: string;
  actor: NotificationActor | null;
}

interface NotificationListResponse {
  items: Notification[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface NotificationCounts {
  total: number;
  byType: Record<"approval" | "transition" | "checkout" | "eco" | "system", number>;
  byCategory: Record<"vault" | "boms" | "ecos" | "parts" | "vendors", number>;
}

const emptyCounts: NotificationCounts = {
  total: 0,
  byType: { approval: 0, transition: 0, checkout: 0, eco: 0, system: 0 },
  byCategory: { vault: 0, boms: 0, ecos: 0, parts: 0, vendors: 0 },
};

interface NotificationContextValue {
  unreadCount: number;
  notifications: Notification[];
  pendingApprovalCount: number;
  counts: NotificationCounts;
  loading: boolean;
  /** True when the realtime channel has fallen back to polling. UI can surface a quiet indicator. */
  degraded: boolean;
  refresh: () => void;
  markRead: (notificationId: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  /** Mark every unread notification referencing the given entity id as read. */
  clearRef: (refId: string) => Promise<void>;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

// Safety poll cadence when realtime is healthy. Cheap enough that a
// missed postgres_changes event (network blip, tab backgrounded past
// heartbeat) is corrected within a minute.
const HEALTHY_POLL_MS = 60_000;
// Faster fallback when the channel has errored — we want the badge to
// still feel live-ish even without websockets.
const DEGRADED_POLL_MS = 15_000;

export function NotificationProvider({ children }: { children: ReactNode }) {
  const user = useTenantUser();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [counts, setCounts] = useState<NotificationCounts>(emptyCounts);
  const [loading, setLoading] = useState(false);
  const [degraded, setDegraded] = useState(false);

  const fetchNotifications = useCallback(async () => {
    try {
      setLoading(true);
      const r = await fetch("/api/notifications?limit=20");
      if (!r.ok) throw new Error(`GET /api/notifications ${r.status}`);
      const data = (await r.json()) as NotificationListResponse;
      setNotifications(data.items || []);
    } catch (err) {
      console.error("[notifications] fetch failed", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCounts = useCallback(async () => {
    try {
      const r = await fetch("/api/notifications/counts");
      if (!r.ok) throw new Error(`GET /api/notifications/counts ${r.status}`);
      const data = (await r.json()) as NotificationCounts;
      setCounts(data);
      setUnreadCount(data.total);
    } catch (err) {
      console.error("[notifications] counts fetch failed", err);
    }
  }, []);

  const fetchApprovalCount = useCallback(async () => {
    try {
      const r = await fetch("/api/approvals");
      if (!r.ok) throw new Error(`GET /api/approvals ${r.status}`);
      const d = await r.json();
      setPendingApprovalCount(Array.isArray(d) ? d.length : 0);
    } catch (err) {
      console.error("[notifications] approval count failed", err);
    }
  }, []);

  const refresh = useCallback(() => {
    fetchNotifications();
    fetchCounts();
    fetchApprovalCount();
  }, [fetchNotifications, fetchCounts, fetchApprovalCount]);

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Supabase realtime. We listen to the user's own notification rows
  // (any event) and to approval_decisions (any tenant — filtering by
  // tenantId at the channel level isn't straightforward and the cost
  // of a debounced refetch is small).
  //
  // If the channel errors or times out, we flip `degraded` and fall
  // back to a faster poll. We never throw — the badge should always
  // keep working even if websockets are blocked by a proxy.
  const degradedRef = useRef(false);
  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("notifications-realtime")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "notifications",
          filter: `userId=eq.${user.id}`,
        },
        () => {
          fetchNotifications();
          fetchCounts();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "approval_decisions",
        },
        () => {
          fetchApprovalCount();
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (degradedRef.current) {
            degradedRef.current = false;
            setDegraded(false);
          }
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          if (!degradedRef.current) {
            degradedRef.current = true;
            setDegraded(true);
            console.warn("[notifications] realtime channel degraded:", status);
          }
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user.id, fetchNotifications, fetchCounts, fetchApprovalCount]);

  // Safety poll — catches dropped events and also serves as the sole
  // refresh mechanism while `degraded`. The effect re-runs when the
  // degraded flag flips, so the cadence adjusts automatically.
  useEffect(() => {
    const interval = degraded ? DEGRADED_POLL_MS : HEALTHY_POLL_MS;
    const id = window.setInterval(() => {
      fetchCounts();
      fetchApprovalCount();
    }, interval);
    return () => window.clearInterval(id);
  }, [degraded, fetchCounts, fetchApprovalCount]);

  // Refetch when the tab regains focus or becomes visible. Browsers
  // throttle background websockets aggressively, so a user returning
  // to a stale tab should see fresh counts immediately rather than
  // waiting for the next poll tick.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") {
        fetchCounts();
        fetchApprovalCount();
      }
    }
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fetchCounts, fetchApprovalCount]);

  const markRead = useCallback(async (notificationId: string) => {
    try {
      const r = await fetch("/api/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationId }),
      });
      if (!r.ok) throw new Error(`PUT /api/notifications ${r.status}`);
      setNotifications((prev) =>
        prev.map((n) => (n.id === notificationId ? { ...n, isRead: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
      // Optimistically decrement the matching category/type bucket so
      // the sidebar badge updates without waiting for a refetch.
      setCounts((prev) => {
        const notif = notifications.find((n) => n.id === notificationId);
        if (!notif || notif.isRead) return prev;
        const nextByType = { ...prev.byType };
        if (notif.type in nextByType) {
          nextByType[notif.type] = Math.max(0, nextByType[notif.type] - 1);
        }
        const nextByCategory = { ...prev.byCategory };
        const link = notif.link || "";
        if (link.startsWith("/vault")) nextByCategory.vault = Math.max(0, nextByCategory.vault - 1);
        else if (link.startsWith("/boms")) nextByCategory.boms = Math.max(0, nextByCategory.boms - 1);
        else if (link.startsWith("/ecos")) nextByCategory.ecos = Math.max(0, nextByCategory.ecos - 1);
        else if (link.startsWith("/parts")) nextByCategory.parts = Math.max(0, nextByCategory.parts - 1);
        else if (link.startsWith("/vendors")) nextByCategory.vendors = Math.max(0, nextByCategory.vendors - 1);
        return {
          total: Math.max(0, prev.total - 1),
          byType: nextByType,
          byCategory: nextByCategory,
        };
      });
    } catch (err) {
      console.error("[notifications] mark read failed", err);
    }
  }, [notifications]);

  const clearRef = useCallback(async (refId: string) => {
    try {
      const r = await fetch("/api/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearRef: refId }),
      });
      if (!r.ok) throw new Error(`PUT /api/notifications ${r.status}`);
      // Refetch counts + list rather than trying to patch optimistically —
      // we don't know how many rows the server updated, and getting the
      // per-category bucket math wrong would leave a stale badge.
      fetchCounts();
      fetchNotifications();
    } catch (err) {
      console.error("[notifications] clearRef failed", err);
    }
  }, [fetchCounts, fetchNotifications]);

  const markAllRead = useCallback(async () => {
    try {
      const r = await fetch("/api/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markAllRead: true }),
      });
      if (!r.ok) throw new Error(`PUT /api/notifications ${r.status}`);
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      setUnreadCount(0);
      setCounts(emptyCounts);
    } catch (err) {
      console.error("[notifications] mark all read failed", err);
    }
  }, []);

  return (
    <NotificationContext.Provider
      value={{
        unreadCount,
        notifications,
        pendingApprovalCount,
        counts,
        loading,
        degraded,
        refresh,
        markRead,
        markAllRead,
        clearRef,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error("useNotifications must be used within a NotificationProvider");
  }
  return context;
}
