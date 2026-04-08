import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser } from "@/lib/auth";
import { AuditLogClient } from "./audit-log-client";

export default async function AuditLogPage() {
  const tenantUser = await getCurrentTenantUser();
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
