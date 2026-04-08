"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useTenantUser } from "@/components/providers/tenant-provider";
import { Logo } from "./logo";
import {
  FolderOpen, Search, FileText, ClipboardList, Settings,
  Users, History, LayoutDashboard, Tag,
} from "lucide-react";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Vault", href: "/vault", icon: FolderOpen },
  { name: "Search", href: "/search", icon: Search },
  { name: "ECOs", href: "/ecos", icon: ClipboardList },
  { name: "Audit Log", href: "/audit-log", icon: History },
];

const adminNavigation = [
  { name: "Users", href: "/admin/users", icon: Users },
  { name: "Lifecycle", href: "/admin/lifecycle", icon: Tag },
  { name: "Metadata", href: "/admin/metadata", icon: FileText },
  { name: "Settings", href: "/admin/settings", icon: Settings },
];

export function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const user = useTenantUser();
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
                  ? "bg-foreground/8 text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/4"
              )}
            >
              <item.icon className="w-3.75 h-3.75 shrink-0" />
              {item.name}
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
