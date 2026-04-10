"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bell, CheckCheck, Clock, Trash2 } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { FormattedDate } from "@/components/ui/formatted-date";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { toast } from "sonner";

function initialsOf(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

interface NotificationActor {
  id: string;
  fullName: string;
}

interface Notification {
  id: string;
  title: string;
  message: string;
  type: string;
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

const PAGE_SIZE = 50;

export default function NotificationsPage() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadPage = useCallback(async (before: string | null, append: boolean) => {
    try {
      if (append) setLoadingMore(true);
      else setLoading(true);
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (before) qs.set("before", before);
      const data = await fetchJson<NotificationListResponse>(`/api/notifications?${qs}`);
      setNotifications((prev) => (append ? [...prev, ...data.items] : data.items));
      setCursor(data.nextCursor);
      setHasMore(data.hasMore);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    loadPage(null, false);
  }, [loadPage]);

  async function markAllRead() {
    try {
      await fetchJson("/api/notifications", {
        method: "PUT",
        body: { markAllRead: true },
      });
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      toast.success("All marked as read");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function clearRead() {
    try {
      await fetchJson("/api/notifications?clearRead=true", { method: "DELETE" });
      setNotifications((prev) => prev.filter((n) => !n.isRead));
      toast.success("Read notifications cleared");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function handleClick(notif: Notification) {
    if (!notif.isRead) {
      try {
        await fetchJson("/api/notifications", {
          method: "PUT",
          body: { notificationId: notif.id },
        });
        setNotifications((prev) =>
          prev.map((n) => (n.id === notif.id ? { ...n, isRead: true } : n))
        );
      } catch (err) {
        toast.error(errorMessage(err));
        return;
      }
    }
    if (notif.link) router.push(notif.link);
  }

  const unread = notifications.filter((n) => !n.isRead).length;
  const readCount = notifications.length - unread;

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Notifications</h2>
          <p className="text-sm text-muted-foreground mt-1">{unread} unread</p>
        </div>
        <div className="flex items-center gap-2">
          {readCount > 0 && (
            <Button variant="outline" size="sm" onClick={clearRead}>
              <Trash2 className="w-4 h-4 mr-2" />
              Clear read
            </Button>
          )}
          {unread > 0 && (
            <Button variant="outline" size="sm" onClick={markAllRead}>
              <CheckCheck className="w-4 h-4 mr-2" />
              Mark all read
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : notifications.length === 0 ? (
        <Card>
          <CardContent className="py-0">
            <EmptyState
              icon={Bell}
              title="No notifications yet"
              description="When something happens that needs your attention, it'll show up here."
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="space-y-2">
            {notifications.map((notif) => (
              <Card
                key={notif.id}
                className={`cursor-pointer transition-colors ${!notif.isRead ? "border-primary/30 bg-primary/2" : ""}`}
                onClick={() => handleClick(notif)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${!notif.isRead ? "bg-primary" : "bg-transparent"}`} />
                    <Avatar className="w-8 h-8 shrink-0">
                      <AvatarFallback className="text-[11px] bg-foreground/8 text-foreground font-medium">
                        {notif.actor ? initialsOf(notif.actor.fullName) : <Bell className="w-4 h-4" />}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{notif.title}</span>
                        <Badge variant="outline" className="text-[10px] px-1.5">{notif.type}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground mt-0.5">{notif.message}</p>
                      <div className="flex items-center gap-1 mt-1.5 text-xs text-muted-foreground/60">
                        <Clock className="w-3 h-3" />
                        <FormattedDate date={notif.createdAt} />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          {hasMore && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => loadPage(cursor, true)}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading..." : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
