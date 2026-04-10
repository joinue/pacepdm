import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { AuditLogClient } from "./audit-log-client";
import { ShieldAlert } from "lucide-react";

export default async function AuditLogPage() {
  const tenantUser = await getCurrentTenantUser();
  const permissions = tenantUser.role.permissions as string[];

  // Tenant-wide audit data is sensitive — gate it. Per-object history
  // (e.g. a single part's events) should be exposed on detail pages and
  // is intentionally NOT covered by this permission.
  if (!hasPermission(permissions, PERMISSIONS.AUDIT_VIEW)) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <ShieldAlert className="w-12 h-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold mb-2">Access Denied</h2>
        <p className="text-muted-foreground max-w-md">
          You do not have permission to view the audit log. Contact your
          workspace administrator if you believe this is an error.
        </p>
      </div>
    );
  }

  const db = getServiceClient();

  const { data: logs } = await db
    .from("audit_logs")
    .select("*, user:tenant_users!audit_logs_userId_fkey(fullName, email)")
    .eq("tenantId", tenantUser.tenantId)
    .order("createdAt", { ascending: false })
    .limit(200);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Audit Log</h2>
      <AuditLogClient logs={logs || []} />
    </div>
  );
}
