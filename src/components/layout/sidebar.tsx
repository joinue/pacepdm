"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useTenantUser } from "@/components/providers/tenant-provider";
import { useNotifications } from "@/components/providers/notification-provider";
import { Logo } from "./logo";
import {
  FolderOpen, Search, FileText, ClipboardList, Settings,
  Users, History, LayoutDashboard, Tag, CheckCircle, Shield, Package, KeyRound, Cpu,
} from "lucide-react";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Vault", href: "/vault", icon: FolderOpen },
  { name: "Parts", href: "/parts", icon: Cpu },
  { name: "BOMs", href: "/boms", icon: Package },
  { name: "Search", href: "/search", icon: Search },
  { name: "ECOs", href: "/ecos", icon: ClipboardList },
  { name: "Approvals", href: "/approvals", icon: CheckCircle },
  { name: "Audit Log", href: "/audit-log", icon: History },
];

const adminNavigation = [
  { name: "Users", href: "/admin/users", icon: Users },
  { name: "Roles", href: "/admin/roles", icon: KeyRound },
  { name: "Workflows", href: "/admin/workflows", icon: ClipboardList },
  { name: "Approval Groups", href: "/admin/approval-groups", icon: Shield },
  { name: "Lifecycle", href: "/admin/lifecycle", icon: Tag },
  { name: "Metadata", href: "/admin/metadata", icon: FileText },
  { name: "Settings", href: "/admin/settings", icon: Settings },
];

export function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const user = useTenantUser();
  const { pendingApprovalCount } = useNotifications();
  const isAdmin =
    user.permissions.includes("*") ||
    user.permissions.some((p) => p.startsWith("admin."));

  return (
    <div className="flex flex-col w-52 h-full">
      {/* Logo */}
      <div className="flex items-center gap-2.5 h-12 px-5">
        <Logo size={20} />
        <h1 className="font-semibold text-[13px] tracking-tight leading-none">PACE PDM</h1>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-1 space-y-0.5 overflow-y-auto">
        {navigation.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.name}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[13px] transition-all duration-150",
                isActive
                  ? "bg-foreground/12 text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/6"
              )}
            >
              <item.icon className="w-3.75 h-3.75 shrink-0" />
              {item.name}
              {item.name === "Approvals" && pendingApprovalCount > 0 && (
                <span className="ml-auto bg-primary text-primary-foreground text-[9px] font-bold rounded-full min-w-4.5 h-4.5 flex items-center justify-center px-1">
                  {pendingApprovalCount > 9 ? "9+" : pendingApprovalCount}
                </span>
              )}
            </Link>
          );
        })}

        {isAdmin && (
          <>
            <div className="pt-5 pb-1">
              <p className="px-2.5 text-[10px] font-medium text-muted-foreground/60 uppercase tracking-[0.15em]">
                Admin
              </p>
            </div>
            {adminNavigation.map((item) => {
              const isActive = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[13px] transition-all duration-150",
                    isActive
                      ? "bg-foreground/8 text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-foreground/4"
                  )}
                >
                  <item.icon className="w-3.75 h-3.75 shrink-0" />
                  {item.name}
                </Link>
              );
            })}
          </>
        )}
      </nav>

      <div className="px-5 py-3">
        <p className="text-[10px] text-muted-foreground/40 tracking-wide">v0.1.0</p>
      </div>
    </div>
  );
}
