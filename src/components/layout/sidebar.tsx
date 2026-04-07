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
  { name: "Metadata Fields", href: "/admin/metadata", icon: FileText },
  { name: "Settings", href: "/admin/settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const user = useTenantUser();
  const isAdmin =
    user.permissions.includes("*") ||
    user.permissions.some((p) => p.startsWith("admin."));

  return (
    <div className="flex flex-col w-64 border-r bg-background">
      {/* Logo */}
      <div className="flex items-center gap-2 h-14 px-4 border-b">
        <div className="w-8 h-8 bg-primary rounded-md flex items-center justify-center">
          <span className="text-primary-foreground font-bold text-sm">P</span>
        </div>
        <div>
          <h1 className="font-semibold text-sm">PACE PDM</h1>
          <p className="text-xs text-muted-foreground truncate max-w-[160px]">
            {user.tenantName}
          </p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
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
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <item.icon className="w-4 h-4" />
              {item.name}
            </Link>
          );
        })}

        {isAdmin && (
          <>
            <div className="pt-4 pb-2">
              <p className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Administration
              </p>
            </div>
            {adminNavigation.map((item) => {
              const isActive = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <item.icon className="w-4 h-4" />
                  {item.name}
                </Link>
              );
            })}
          </>
        )}
      </nav>
    </div>
  );
}
