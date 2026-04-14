"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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

type NotificationType = "approval" | "transition" | "checkout" | "eco" | "system";

interface Notification {
  id: string;
  title: string;
  message: string;
  type: NotificationType;
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

type FilterKey = "all" | NotificationType | "unread";

const FILTER_LABELS: Record<FilterKey, string> = {
  all: "All",
  unread: "Unread",
  approval: "Approvals",
  transition: "Transitions",
  eco: "ECOs",
  checkout: "Checkouts",
  system: "Mentions",
};

const typeBadgeVariant: Record<NotificationType, "info" | "purple" | "orange" | "warning" | "muted"> = {
  approval: "purple",
  transition: "info",
  eco: "orange",
  checkout: "warning",
  system: "muted",
};

// Bucket a notification into a coarse date group. We compare against
// midnight-local so "Today" / "Yesterday" don't flicker across TZs.
function dateBucket(iso: string): string {
  const then = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfLastWeek = startOfToday - 6 * 86_400_000;
  const ts = then.getTime();
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfYesterday) return "Yesterday";
  if (ts >= startOfLastWeek) return "Earlier this week";
  // Older than 7 days: group by month for readability.
  return then.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

const BUCKET_ORDER = ["Today", "Yesterday", "Earlier this week"];

export default function NotificationsPage() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("all");

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

  // Counts per filter — computed once per render over the full list so
  // the tab badges update live as items are marked read or cleared.
  const countsByFilter = useMemo(() => {
    const c: Record<FilterKey, number> = {
      all: notifications.length,
      unread: 0,
      approval: 0,
      transition: 0,
      eco: 0,
      checkout: 0,
      system: 0,
    };
    for (const n of notifications) {
      if (!n.isRead) c.unread += 1;
      c[n.type] += 1;
    }
    return c;
  }, [notifications]);

  // Filter + group. Group order is fixed for the named buckets and
  // then chronological descending for month buckets.
  const grouped = useMemo(() => {
    const filtered = notifications.filter((n) => {
      if (filter === "all") return true;
      if (filter === "unread") return !n.isRead;
      return n.type === filter;
    });
    const buckets = new Map<string, Notification[]>();
    for (const n of filtered) {
      const key = dateBucket(n.createdAt);
      const arr = buckets.get(key);
      if (arr) arr.push(n);
      else buckets.set(key, [n]);
    }
    // Ordered: named buckets first (in fixed order), then month buckets
    // in the order they first appeared (which is newest→oldest because
    // `notifications` is already sorted newest-first by the API).
    const ordered: Array<[string, Notification[]]> = [];
    for (const key of BUCKET_ORDER) {
      const arr = buckets.get(key);
      if (arr && arr.length > 0) ordered.push([key, arr]);
    }
    for (const [key, arr] of buckets) {
      if (BUCKET_ORDER.includes(key)) continue;
      ordered.push([key, arr]);
    }
    return ordered;
  }, [notifications, filter]);

  const unread = countsByFilter.unread;
  const readCount = notifications.length - unread;
  const filteredTotal = grouped.reduce((sum, [, arr]) => sum + arr.length, 0);

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between flex-wrap gap-2">
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
        <Tabs value={filter} onValueChange={(v) => v && setFilter(v as FilterKey)}>
          <TabsList variant="line" className="w-full justify-start flex-wrap h-auto">
            {(Object.keys(FILTER_LABELS) as FilterKey[]).map((key) => {
              const n = countsByFilter[key];
              return (
                <TabsTrigger key={key} value={key}>
                  {FILTER_LABELS[key]}
                  {n > 0 && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">
                      {n}
                    </Badge>
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>

          <TabsContent value={filter} className="mt-4 space-y-6">
            {filteredTotal === 0 ? (
              <Card>
                <CardContent className="py-0">
                  <EmptyState
                    icon={Bell}
                    title="Nothing here"
                    description={`No ${filter === "all" ? "" : FILTER_LABELS[filter].toLowerCase() + " "}notifications in this view.`}
                  />
                </CardContent>
              </Card>
            ) : (
              grouped.map(([bucket, items]) => (
                <section key={bucket} aria-labelledby={`bucket-${bucket}`}>
                  <h3
                    id={`bucket-${bucket}`}
                    className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-[0.15em] mb-2 px-1"
                  >
                    {bucket}
                    <span className="ml-2 text-muted-foreground/40 font-normal normal-case tracking-normal">
                      {items.length}
                    </span>
                  </h3>
                  <div className="space-y-2">
                    {items.map((notif) => (
                      <Card
                        key={notif.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`${notif.isRead ? "" : "Unread: "}${notif.title}. ${notif.message}`}
                        className={`cursor-pointer transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none ${!notif.isRead ? "border-primary/30 bg-primary/2" : ""}`}
                        onClick={() => handleClick(notif)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleClick(notif);
                          }
                        }}
                      >
                        <CardContent className="p-4">
                          <div className="flex items-start gap-3">
                            <div
                              aria-hidden="true"
                              className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${!notif.isRead ? "bg-primary" : "bg-transparent"}`}
                            />
                            <Avatar className="w-8 h-8 shrink-0">
                              <AvatarFallback className="text-[11px] bg-foreground/8 text-foreground font-medium">
                                {notif.actor ? initialsOf(notif.actor.fullName) : <Bell className="w-4 h-4" />}
                              </AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium">{notif.title}</span>
                                <Badge variant={typeBadgeVariant[notif.type] || "muted"} className="text-[10px] px-1.5">
                                  {notif.type}
                                </Badge>
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
                </section>
              ))
            )}
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
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
