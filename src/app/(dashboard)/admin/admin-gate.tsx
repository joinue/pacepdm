import { getCurrentTenantUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { ShieldAlert } from "lucide-react";

/**
 * Per-segment permission gate for the admin section.
 *
 * The parent `admin/layout.tsx` admits anyone holding *some* `admin.*`
 * permission, which is the right coarse fence for the section as a whole but
 * says nothing about the page being asked for. That approximation was
 * harmless while Admin was the only role with any `admin.*` permission — the
 * check was effectively "is Admin". It stopped being harmless the moment a
 * role could hold exactly one of them (see docs/decisions/system-roles.md):
 * a Manager holds `admin.users`, and would otherwise have reached the
 * lifecycle editor, the workflow builder, and the roles screen by URL, each
 * rendering fully and then 403-ing on save.
 *
 * So every admin segment declares its own requirement in a `layout.tsx`:
 *
 *   export default function Layout({ children }: { children: React.ReactNode }) {
 *     return <AdminGate permission={PERMISSIONS.ADMIN_LIFECYCLE}>{children}</AdminGate>;
 *   }
 *
 * The permission must be the same one the segment's write routes declare, and
 * the same one its sidebar entry is gated on. Three places, one answer — a
 * new admin page needs all three.
 *
 * This is defence in depth, not the boundary. The boundary is still the
 * permission declared on each route handler; this only stops the UI offering
 * a page whose every action would be refused. `getCurrentTenantUser` is
 * memoised per request, so the extra call costs nothing.
 */
export async function AdminGate({
  permission,
  children,
}: {
  permission: string;
  children: React.ReactNode;
}) {
  const tenantUser = await getCurrentTenantUser();
  const permissions = tenantUser.role.permissions as string[];

  if (!hasPermission(permissions, permission)) return <AccessDenied />;

  return <>{children}</>;
}

export function AccessDenied() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <ShieldAlert className="w-12 h-12 text-destructive mb-4" />
      <h2 className="text-xl font-semibold mb-2">Access Denied</h2>
      <p className="text-muted-foreground max-w-md">
        You do not have permission to access this page. Contact your workspace administrator if you
        believe this is an error.
      </p>
    </div>
  );
}
