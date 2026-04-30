import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser } from "@/lib/auth";
import { UsersClient } from "./users-client";

export default async function UsersPage() {
  const tenantUser = await getCurrentTenantUser();
  const db = getServiceClient();

  const [{ data: users }, { data: roles }] = await Promise.all([
    db.from("tenant_users")
      .select("*, role:roles!tenant_users_roleId_fkey(id, name)")
      .eq("tenantId", tenantUser.tenantId)
      .order("createdAt"),
    db.from("roles")
      .select("id, name")
      .eq("tenantId", tenantUser.tenantId)
      .order("name"),
  ]);

  return (
    <UsersClient
      users={users || []}
      roles={roles || []}
      currentUserId={tenantUser.id}
    />
  );
}
