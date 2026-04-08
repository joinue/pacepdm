import { getCurrentTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { ShieldAlert } from "lucide-react";

/** Permission required by each admin sub-route */
const ADMIN_ROUTE_PERMISSIONS: Record<string, string> = {
  users: PERMISSIONS.ADMIN_USERS,
  roles: PERMISSIONS.ADMIN_ROLES,
  workflows: PERMISSIONS.ADMIN_SETTINGS,
  "approval-groups": PERMISSIONS.ADMIN_SETTINGS,
  lifecycle: PERMISSIONS.ADMIN_LIFECYCLE,
  metadata: PERMISSIONS.ADMIN_METADATA,
  settings: PERMISSIONS.ADMIN_SETTINGS,
};

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
