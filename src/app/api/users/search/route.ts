import { withTenant } from "@/lib/api-route";
import { z } from "@/lib/validation";

const QuerySchema = z.object({ q: z.string().optional() });

export const GET = withTenant({ query: QuerySchema }, async ({ db, tenantUser, query }) => {
  const q = query.q || "";

  // Empty q returns the first batch of active tenant members (used by the
  // folder-access picker to populate a dropdown). Non-empty q narrows by
  // name prefix like before.
  let usersQuery = db
    .from("tenant_users")
    .select("id, fullName, email")
    .eq("isActive", true)
    .neq("id", tenantUser.id)
    .limit(q.length > 0 ? 10 : 50);

  if (q.length > 0) {
    usersQuery = usersQuery.ilike("fullName", `%${q}%`);
  }

  const { data: users } = await usersQuery;
  return users || [];
});
