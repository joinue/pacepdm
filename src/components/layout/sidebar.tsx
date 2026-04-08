"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useTenantUser } from "@/components/providers/tenant-provider";
import {
  FolderOpen,
  Search,
  FileText,
  ClipboardList,
  Settings,
  Users,
  History,
  LayoutDashboard,
  Tag,
  Box,
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

export function Sidebar() {
  const pathname = usePathname();
  const user = useTenantUser();
  const isAdmin =
    user.permissions.includes("*") ||
    user.permissions.some((p) => p.startsWith("admin."));

  return (
    <div className="flex flex-col w-56 border-r bg-sidebar">
      {/* Logo */}
      <div className="flex items-center gap-2.5 h-12 px-4 border-b">
        <div className="w-7 h-7 bg-primary rounded flex items-center justify-center">
          <Box className="w-4 h-4 text-primary-foreground" />
        </div>
        <div className="min-w-0">
          <h1 className="font-semibold text-sm tracking-tight leading-none">PACE PDM</h1>
          <p className="text-[10px] text-muted-foreground truncate mt-0.5">
            {user.tenantName}
          </p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navigation.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              <item.icon className="w-4 h-4 shrink-0" />
              {item.name}
            </Link>
          );
        })}

        {isAdmin && (
          <>
            <div className="pt-5 pb-1.5">
              <p className="px-2.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
                Admin
              </p>
            </div>
            {adminNavigation.map((item) => {
              const isActive = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <item.icon className="w-4 h-4 shrink-0" />
                  {item.name}
                </Link>
              );
            })}
          </>
        )}
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t">
        <p className="text-[10px] text-muted-foreground/60 text-center tracking-wide">
          PACE PDM v0.1
        </p>
      </div>
    </div>
  );
}
