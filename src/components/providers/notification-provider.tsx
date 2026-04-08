"use client";

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { useTenantUser } from "./tenant-provider";

interface Notification {
  id: string;
  title: string;
  message: string;
  type: "approval" | "transition" | "checkout" | "eco" | "system";
  link: string | null;
  isRead: boolean;
  createdAt: string;
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
      const r = await fetch("/api/notifications");
      const data = await r.json();
      if (Array.isArray(data)) {
        setNotifications(data.slice(0, 20));
        setUnreadCount(data.filter((n: Notification) => !n.isRead).length);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchApprovalCount = useCallback(async () => {
    try {
      const r = await fetch("/api/approvals");
      if (r.ok) {
        const d = await r.json();
        setPendingApprovalCount(Array.isArray(d) ? d.length : 0);
      }
    } catch {
      // silent
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

  // Supabase realtime: re-fetch when notifications table changes for this user
  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("notifications-realtime")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
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
          event: "INSERT",
          schema: "public",
          table: "approval_decisions",
        },
        () => {
          fetchApprovalCount();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
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
      await fetch("/api/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationId }),
      });
      setNotifications((prev) =>
        prev.map((n) => (n.id === notificationId ? { ...n, isRead: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch {
      // silent
    }
  }, []);

  const markAllRead = useCallback(async () => {
    try {
      await fetch("/api/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markAllRead: true }),
      });
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      setUnreadCount(0);
    } catch {
      // silent
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
