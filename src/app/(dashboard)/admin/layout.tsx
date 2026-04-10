import { getCurrentTenantUser } from "@/lib/auth";
import { ShieldAlert } from "lucide-react";

// Note: per-route permission gating is enforced server-side in each
// individual admin API route, not here. This layout only checks that the
// user has *some* admin permission so they can see the admin sidebar at all.

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const tenantUser = await getCurrentTenantUser();
  const permissions = tenantUser.role.permissions as string[];

  // Gate: user must have at least one admin.* permission
  const isAdmin =
    permissions.includes("*") ||
    permissions.some((p: string) => p.startsWith("admin."));

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <ShieldAlert className="w-12 h-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold mb-2">Access Denied</h2>
        <p className="text-muted-foreground max-w-md">
          You do not have permission to access admin pages. Contact your
          workspace administrator if you believe this is an error.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
