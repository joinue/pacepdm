import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser } from "@/lib/auth";
import { ApprovalGroupsClient } from "./approval-groups-client";

export default async function ApprovalGroupsPage() {
  const tenantUser = await getCurrentTenantUser();
  const db = getServiceClient();

  const { data: users } = await db
    .from("tenant_users")
    .select("id, fullName, email")
    .eq("tenantId", tenantUser.tenantId)
    .eq("isActive", true)
    .order("fullName");

  return <ApprovalGroupsClient users={users || []} />;
}
