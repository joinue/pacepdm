"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bell, CheckCheck, Clock } from "lucide-react";
import { FormattedDate } from "@/components/ui/formatted-date";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useFetch } from "@/hooks/use-fetch";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { toast } from "sonner";

interface Notification {
  id: string;
  title: string;
  message: string;
  type: string;
  link: string | null;
  isRead: boolean;
  createdAt: string;
}

export default function NotificationsPage() {
  const router = useRouter();
  const { data, loading, setData } = useFetch<Notification[]>("/api/notifications");
  const notifications = data || [];

  async function markAllRead() {
    try {
      await fetchJson("/api/notifications", {
        method: "PUT",
        body: { markAllRead: true },
      });
      // Optimistic local update — server is the source of truth on next refetch
      setData((prev) => (prev || []).map((n) => ({ ...n, isRead: true })));
      toast.success("All marked as read");
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
        setData((prev) =>
          (prev || []).map((n) => (n.id === notif.id ? { ...n, isRead: true } : n))
        );
      } catch (err) {
        toast.error(errorMessage(err));
        return;
      }
    }
    if (notif.link) router.push(notif.link);
  }

  const unread = notifications.filter((n) => !n.isRead).length;

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Notifications</h2>
          <p className="text-sm text-muted-foreground mt-1">{unread} unread</p>
        </div>
        {unread > 0 && (
          <Button variant="outline" size="sm" onClick={markAllRead}>
            <CheckCheck className="w-4 h-4 mr-2" />
            Mark All Read
          </Button>
        )}
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
        <div className="space-y-2">
          {notifications.map((notif) => (
            <Card
              key={notif.id}
              className={`cursor-pointer transition-colors ${!notif.isRead ? "border-primary/30 bg-primary/[0.02]" : ""}`}
              onClick={() => handleClick(notif)}
            >
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${!notif.isRead ? "bg-primary" : "bg-transparent"}`} />
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
      )}
    </div>
  );
}
