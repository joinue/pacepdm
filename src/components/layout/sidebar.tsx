"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useTenantUser } from "@/components/providers/tenant-provider";
import { useNotifications } from "@/components/providers/notification-provider";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Logo } from "./logo";
import {
  FolderOpen,
  FileText,
  ClipboardList,
  Settings,
  Users,
  History,
  LayoutDashboard,
  Tag,
  CheckCircle,
  ShieldCheck,
  Package,
  KeyRound,
  Cpu,
  Building2,
  Workflow,
  Palette,
  type LucideIcon,
} from "lucide-react";

type BadgeKind = "approvals" | "vault" | "boms" | "ecos";

type NavItem = {
  name: string;
  href: string;
  icon: LucideIcon;
  badge?: BadgeKind;
  /** If set, item is only shown when user has this permission. */
  permission?: string;
};

type NavGroup = {
  label?: string;
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  {
    items: [{ name: "Dashboard", href: "/", icon: LayoutDashboard }],
  },
  {
    label: "Library",
    items: [
      { name: "Vault", href: "/vault", icon: FolderOpen, badge: "vault" },
      { name: "Parts", href: "/parts", icon: Cpu },
      { name: "Vendors", href: "/vendors", icon: Building2 },
      { name: "BOMs", href: "/boms", icon: Package, badge: "boms" },
    ],
  },
  {
    label: "Change",
    items: [
      { name: "ECOs", href: "/ecos", icon: ClipboardList, badge: "ecos" },
      { name: "Approvals", href: "/approvals", icon: CheckCircle, badge: "approvals" },
    ],
  },
  // Every item here declares the permission its own page and API require.
  //
  // The group used to be gated as a whole on "holds any admin.* permission",
  // with per-item permissions the exception. That had two failure modes once
  // roles stopped being just Admin/Engineer/Viewer: a role holding audit.view
  // and no admin.* permission could not reach the audit log at all (the only
  // link to it lived inside a group they never saw), and a role holding one
  // admin.* permission saw links to all eight admin pages, seven of which
  // 403 on save. Gating each item and hiding the group when nothing in it
  // survives fixes both.
  {
    label: "Admin",
    items: [
      { name: "Users", href: "/admin/users", icon: Users, permission: PERMISSIONS.ADMIN_USERS },
      { name: "Roles", href: "/admin/roles", icon: KeyRound, permission: PERMISSIONS.ADMIN_ROLES },
      {
        name: "Workflows",
        href: "/admin/workflows",
        icon: Workflow,
        permission: PERMISSIONS.ADMIN_SETTINGS,
      },
      {
        name: "Approval Groups",
        href: "/admin/approval-groups",
        icon: ShieldCheck,
        permission: PERMISSIONS.ADMIN_SETTINGS,
      },
      { name: "SSO", href: "/admin/sso", icon: KeyRound, permission: PERMISSIONS.ADMIN_SETTINGS },
      {
        name: "Lifecycle",
        href: "/admin/lifecycle",
        icon: Tag,
        permission: PERMISSIONS.ADMIN_LIFECYCLE,
      },
      {
        name: "Metadata",
        href: "/admin/metadata",
        icon: FileText,
        permission: PERMISSIONS.ADMIN_METADATA,
      },
      { name: "Audit Log", href: "/audit-log", icon: History, permission: PERMISSIONS.AUDIT_VIEW },
      {
        name: "Settings",
        href: "/admin/settings",
        icon: Settings,
        permission: PERMISSIONS.ADMIN_SETTINGS,
      },
      // Development aid, not a product surface: the primitive gallery. Hidden
      // in production so it does not read as a feature.
      ...(process.env.NODE_ENV === "development"
        ? [
            {
              name: "Kitchen sink",
              href: "/admin/kitchen-sink",
              icon: Palette,
              permission: PERMISSIONS.ADMIN_SETTINGS,
            },
          ]
        : []),
    ],
  },
];

function isItemActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export function Sidebar({
  onNavigate,
  collapsed = false,
}: {
  onNavigate: () => void;
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const user = useTenantUser();
  const { pendingApprovalCount, counts } = useNotifications();

  // Map a nav item's badge kind to its live count. Approvals is a
  // task count (pending approval_decisions assigned to me), everything
  // else is an unread-notification count scoped by link prefix.
  function badgeCountFor(kind: BadgeKind | undefined): number {
    if (!kind) return 0;
    if (kind === "approvals") return pendingApprovalCount;
    return counts.byCategory[kind] ?? 0;
  }
  function badgeLabelFor(kind: BadgeKind, n: number): string {
    if (kind === "approvals") return `${n} pending approval${n === 1 ? "" : "s"}`;
    return `${n} unread notification${n === 1 ? "" : "s"}`;
  }
  // A group appears only if something in it survived the per-item permission
  // filter, so the Admin heading no longer renders above an empty list.
  const visibleGroups = navGroups
    .map((g) => ({
      ...g,
      items: g.items.filter(
        (item) => !item.permission || hasPermission(user.permissions, item.permission)
      ),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <TooltipProvider delay={300}>
      <div className={cn("flex flex-col h-full", collapsed ? "w-12" : "w-52")}>
        {/* Logo */}
        <div
          className={cn("flex items-center h-12", collapsed ? "justify-center" : "gap-2.5 px-5")}
        >
          <Logo size={20} />
          {!collapsed && (
            <h1 className="font-semibold text-sm tracking-tight leading-none">PACE PDM</h1>
          )}
        </div>

        {/* Navigation */}
        <nav
          aria-label="Main"
          className={cn(
            "flex-1 py-1 overflow-y-auto overflow-x-hidden",
            collapsed ? "px-1.5" : "px-3"
          )}
        >
          {visibleGroups.map((group, groupIdx) => {
            const headingId = group.label
              ? `nav-section-${group.label.toLowerCase().replace(/\s+/g, "-")}`
              : undefined;
            return (
              <div
                key={group.label ?? `group-${groupIdx}`}
                role="group"
                aria-labelledby={headingId}
                className={cn(
                  "space-y-0.5",
                  groupIdx > 0 &&
                    (collapsed
                      ? "mt-2 pt-2 border-t border-border/50"
                      : group.label
                        ? "mt-4"
                        : "mt-3 pt-3 border-t border-border/50")
                )}
              >
                {group.label && !collapsed && (
                  <p
                    id={headingId}
                    className="px-2.5 pb-1 text-3xs font-medium text-muted-foreground/60 uppercase tracking-[0.15em]"
                  >
                    {group.label}
                  </p>
                )}
                {group.items.map((item) => {
                  const active = isItemActive(pathname, item.href);
                  const badgeCount = badgeCountFor(item.badge);
                  const showBadge = !!item.badge && badgeCount > 0;
                  const badgeLabel = item.badge ? badgeLabelFor(item.badge, badgeCount) : "";

                  const link = (
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      aria-label={collapsed ? item.name : undefined}
                      className={cn(
                        "relative flex items-center rounded-lg text-sm transition-all duration-150",
                        collapsed ? "h-9 w-9 justify-center" : "gap-2.5 px-2.5 py-1.5",
                        active
                          ? "bg-foreground/12 text-foreground font-medium"
                          : "text-muted-foreground hover:text-foreground hover:bg-foreground/6"
                      )}
                    >
                      <item.icon className="w-3.75 h-3.75 shrink-0" aria-hidden="true" />
                      {!collapsed && <span className="truncate">{item.name}</span>}
                      {showBadge && !collapsed && (
                        <span
                          aria-label={badgeLabel}
                          className="ml-auto bg-primary text-primary-foreground text-4xs font-bold rounded-full min-w-4.5 h-4.5 flex items-center justify-center px-1"
                        >
                          {badgeCount > 9 ? "9+" : badgeCount}
                        </span>
                      )}
                      {showBadge && collapsed && (
                        <span
                          aria-label={badgeLabel}
                          className="absolute top-1 right-1 w-2 h-2 rounded-full bg-primary ring-2 ring-background"
                        />
                      )}
                    </Link>
                  );

                  return collapsed ? (
                    <Tooltip key={item.href}>
                      <TooltipTrigger render={link} />
                      <TooltipContent side="right" sideOffset={8}>
                        {item.name}
                        {showBadge ? ` (${badgeCount})` : ""}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <div key={item.href}>{link}</div>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {!collapsed && (
          <div className="px-5 py-3">
            <p className="text-3xs text-muted-foreground/40 tracking-wide">v0.1.0</p>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
