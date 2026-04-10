"use client";

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
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

interface NotificationContextValue {
  unreadCount: number;
  notifications: Notification[];
  pendingApprovalCount: number;
  loading: boolean;
  refresh: () => void;
  markRead: (notificationId: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const user = useTenantUser();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const fetchNotifications = useCallback(async () => {
    try {
      setLoading(true);
      const r = await fetch("/api/notifications?limit=20");
      if (!r.ok) throw new Error(`GET /api/notifications ${r.status}`);
      const data = (await r.json()) as NotificationListResponse;
      setNotifications(data.items || []);
      setUnreadCount((data.items || []).filter((n) => !n.isRead).length);
    } catch (err) {
      console.error("[notifications] fetch failed", err);
    } finally {
      setLoading(false);
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
    fetchApprovalCount();
  }, [fetchNotifications, fetchApprovalCount]);

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Supabase realtime: any change (insert/update/delete) to this user's
  // notifications should refresh the bell. We listen to all events so that
  // server-side mark-read (e.g. auto-dismiss when an approval is handled)
  // and cross-tab mark-read both clear the badge without a page reload.
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
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user.id, fetchNotifications, fetchApprovalCount]);

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
    } catch (err) {
      console.error("[notifications] mark read failed", err);
    }
  }, []);

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
        loading,
        refresh,
        markRead,
        markAllRead,
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
