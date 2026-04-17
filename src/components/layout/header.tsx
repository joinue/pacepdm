"use client";

import { useState, useEffect, useMemo } from "react";
import { useTenantUser } from "@/components/providers/tenant-provider";
import { useNotifications } from "@/components/providers/notification-provider";
import { createClient } from "@/lib/supabase/client";
import { useRouter, usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LogOut, User, Sun, Moon, Menu, PanelLeft, Bell, ChevronRight, CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { useHasMounted } from "@/hooks/use-has-mounted";
import Link from "next/link";
import { GlobalSearch } from "@/components/layout/global-search";

const breadcrumbLabels: Record<string, string> = {
  vault: "Vault",
  search: "Search",
  parts: "Parts",
  vendors: "Vendors",
  approvals: "Approvals",
  ecos: "ECOs",
  boms: "BOMs",
  "audit-log": "Audit Log",
  profile: "Profile",
  notifications: "Notifications",
  admin: "Admin",
  users: "Users",
  roles: "Roles",
  workflows: "Workflows",
  "approval-groups": "Approval Groups",
  lifecycle: "Lifecycle",
  metadata: "Metadata",
  settings: "Settings",
  sso: "SSO",
};

const typeBadgeVariant: Record<string, "info" | "purple" | "orange" | "warning" | "muted"> = {
  approval: "purple",
  transition: "info",
  eco: "orange",
  checkout: "warning",
  system: "muted",
};

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  const diffYear = Math.floor(diffMonth / 12);
  return `${diffYear}y ago`;
}

export function Header({
  onMenuClick,
  desktopSidebarOpen = true,
}: {
  onMenuClick: () => void;
  desktopSidebarOpen?: boolean;
}) {
  const user = useTenantUser();
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();
  const { resolvedTheme, setTheme } = useTheme();
  const { unreadCount, notifications, loading: loadingNotifs, refresh, markRead, markAllRead } = useNotifications();
  const mounted = useHasMounted();

  const segments = pathname.split("/").filter(Boolean);

  // Some routes embed an entity id as the last segment (e.g. /boms/<uuid>).
  // Resolve that id to a human-friendly name so the breadcrumb shows
  // "BOMs > Widget Frame" instead of "BOMs > 3f2a...". Keyed by the parent
  // segment so we only fetch for routes we know how to resolve.
  const dynamicSegment = useMemo(() => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const segs = pathname.split("/").filter(Boolean);
    if (segs.length < 2) return null;
    const last = segs[segs.length - 1];
    const parent = segs[segs.length - 2];
    if (!UUID_RE.test(last)) return null;
    if (parent === "boms") return { id: last, endpoint: `/api/boms/${last}` };
    if (parent === "ecos") return { id: last, endpoint: `/api/ecos/${last}` };
    return null;
  }, [pathname]);

  const [dynamicLabel, setDynamicLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!dynamicSegment) {
      queueMicrotask(() => setDynamicLabel(null));
      return;
    }
    let cancelled = false;
    queueMicrotask(() => setDynamicLabel(null));
    fetch(dynamicSegment.endpoint)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const name = data.name || data.title || data.ecoNumber || null;
        if (name) setDynamicLabel(name);
      })
      .catch(() => { /* leave the uuid as-is on failure */ });
    return () => { cancelled = true; };
  }, [dynamicSegment]);

  const crumbs = segments.map((seg, i) => {
    const isLast = i === segments.length - 1;
    const label = isLast && dynamicSegment?.id === seg && dynamicLabel
      ? dynamicLabel
      : breadcrumbLabels[seg] || seg;
    return {
      label,
      href: "/" + segments.slice(0, i + 1).join("/"),
    };
  });

  const [notifOpen, setNotifOpen] = useState(false);

  // Refresh notifications when popover opens
  useEffect(() => {
    if (notifOpen) {
      refresh();
    }
  }, [notifOpen, refresh]);

  async function handleMarkAllRead() {
    try {
      await markAllRead();
      toast.success("All notifications marked as read");
    } catch {
      toast.error("Failed to mark notifications as read");
    }
  }

  async function handleClickNotification(notif: { id: string; isRead: boolean; link: string | null }) {
    if (!notif.isRead) {
      await markRead(notif.id);
    }
    if (notif.link) {
      setNotifOpen(false);
      router.push(notif.link);
    }
  }

  const initials = user.fullName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  async function handleSignOut() {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        toast.error("Failed to sign out: " + error.message);
        return;
      }
      router.refresh();
      router.push("/login");
    } catch {
      toast.error("Failed to sign out");
    }
  }

  return (
    <header className="h-12 flex items-center justify-between px-4 md:px-5">
      <div className="flex items-center gap-1.5 min-w-0">
        {/* Mobile menu button */}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 md:hidden shrink-0"
          onClick={onMenuClick}
          aria-label="Open navigation menu"
        >
          <Menu className="w-4 h-4" />
        </Button>
        {/* Desktop sidebar toggle */}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 hidden md:inline-flex shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onMenuClick}
          aria-label={desktopSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          aria-expanded={desktopSidebarOpen}
          title={`${desktopSidebarOpen ? "Collapse" : "Expand"} sidebar (\u2318\\)`}
        >
          <PanelLeft className="w-4 h-4" />
        </Button>
        {/* Breadcrumbs */}
        <nav className="flex items-center gap-1 text-xs text-muted-foreground/60 min-w-0 overflow-hidden">
          <Link href="/" className="hover:text-foreground transition-colors shrink-0">
            {user.tenantName}
          </Link>
          {crumbs.map((crumb, i) => (
            <span key={crumb.href} className="flex items-center gap-1 shrink-0">
              <ChevronRight className="w-3 h-3" />
              {i === crumbs.length - 1 ? (
                <span className="text-foreground font-medium">{crumb.label}</span>
              ) : (
                <Link href={crumb.href} className="hover:text-foreground transition-colors">
                  {crumb.label}
                </Link>
              )}
            </span>
          ))}
        </nav>
      </div>
      <div className="flex items-center gap-1">
        {/* Global Search */}
        <GlobalSearch />
        {/* Notifications Popover */}
        <Popover open={notifOpen} onOpenChange={setNotifOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                aria-label={
                  unreadCount > 0
                    ? `Notifications, ${unreadCount} unread`
                    : "Notifications"
                }
                aria-haspopup="dialog"
                aria-expanded={notifOpen}
                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground relative"
              >
                <Bell className="w-3.5 h-3.5" aria-hidden="true" />
                {unreadCount > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-primary text-primary-foreground text-[9px] font-bold rounded-full flex items-center justify-center"
                  >
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                )}
                {/* Screen-reader live region so assistive tech hears the
                    count change without having to re-enter the button. */}
                <span className="sr-only" aria-live="polite">
                  {unreadCount > 0 ? `${unreadCount} unread notifications` : "No unread notifications"}
                </span>
              </Button>
            }
          />
          <PopoverContent
            align="end"
            sideOffset={8}
            aria-label="Notifications"
            className="w-[min(22rem,calc(100vw-1.5rem))] p-0 gap-0"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2.5">
              <span className="text-sm font-semibold">Notifications</span>
              {unreadCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground gap-1"
                  onClick={handleMarkAllRead}
                >
                  <CheckCheck className="w-3 h-3" />
                  Mark all read
                </Button>
              )}
            </div>
            <Separator />
            {/* Notification list */}
            <ScrollArea className="max-h-100 overflow-auto">
              {loadingNotifs && notifications.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
                  Loading...
                </div>
              ) : notifications.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
                  No notifications
                </div>
              ) : (
                <div className="flex flex-col" role="list">
                  {notifications.map((notif) => {
                    const actorInitials = notif.actor?.fullName
                      ? notif.actor.fullName
                          .split(" ")
                          .map((n) => n[0])
                          .join("")
                          .toUpperCase()
                          .slice(0, 2)
                      : null;
                    return (
                      <button
                        key={notif.id}
                        role="listitem"
                        aria-label={`${notif.isRead ? "" : "Unread: "}${notif.title}. ${notif.message}`}
                        className="flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none transition-colors w-full border-b border-border/50 last:border-b-0"
                        onClick={() => handleClickNotification(notif)}
                      >
                        {/* Unread dot (hidden from AT — state is in the aria-label) */}
                        <div className="mt-1.5 shrink-0" aria-hidden="true">
                          {!notif.isRead ? (
                            <span className="block w-2 h-2 rounded-full bg-primary" />
                          ) : (
                            <span className="block w-2 h-2" />
                          )}
                        </div>
                        {/* Actor avatar (falls back to a Bell icon for system events) */}
                        <Avatar className="w-6 h-6 mt-0.5 shrink-0">
                          <AvatarFallback className="text-[9px] bg-foreground/8 text-foreground font-medium">
                            {actorInitials ?? <Bell className="w-3 h-3" />}
                          </AvatarFallback>
                        </Avatar>
                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-sm font-medium truncate">{notif.title}</span>
                            <Badge
                              variant={typeBadgeVariant[notif.type] || "muted"}
                              className="text-[10px] h-4 px-1.5 shrink-0"
                            >
                              {notif.type}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground line-clamp-2">{notif.message}</p>
                          <span className="text-[10px] text-muted-foreground/60 mt-0.5 block">
                            {formatRelativeTime(notif.createdAt)}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
            <Separator />
            {/* Footer */}
            <div className="px-3 py-2">
              <Link
                href="/notifications"
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setNotifOpen(false)}
              >
                View all
              </Link>
            </div>
          </PopoverContent>
        </Popover>

        {mounted && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          >
            {resolvedTheme === "dark" ? (
              <Sun className="w-3.5 h-3.5" />
            ) : (
              <Moon className="w-3.5 h-3.5" />
            )}
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" className="flex items-center gap-2 h-8 px-2">
                <Avatar className="w-6 h-6">
                  <AvatarFallback className="text-[10px] bg-foreground/8 text-foreground font-medium">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <span className="text-[13px] hidden sm:inline">{user.fullName}</span>
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{user.fullName}</span>
                  <span className="text-xs text-muted-foreground font-normal">{user.email}</span>
                  <span className="text-[11px] text-muted-foreground/60 font-normal mt-0.5">
                    {user.role}
                  </span>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push("/profile")}>
              <User className="w-4 h-4 mr-2" />
              Profile
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleSignOut}>
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
