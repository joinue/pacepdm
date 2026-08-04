import { withTenant } from "@/lib/api-route";

/**
 * Pending approvals assigned to the current user.
 *
 * Scoping here runs through group membership rather than a tenantId column:
 * a user only belongs to groups in their own tenant, so the `groupIds` derived
 * below cannot reach another tenant's decisions. Both tables are child tables
 * with no tenantId of their own.
 */
export const GET = withTenant({}, async ({ db, tenantUser }) => {
  // lint-conventions-allow: child-table-direct-query — filtered by the caller's
  // own tenant_users.id, which the wrapper resolved from the session.
  const { data: memberships } = await db
    .from("approval_group_members")
    .select("groupId")
    .eq("userId", tenantUser.id);

  const groupIds = (memberships || []).map((m: { groupId: string }) => m.groupId);
  if (groupIds.length === 0) return [];

  // lint-conventions-allow: child-table-direct-query — `groupIds` comes from the
  // membership query above, never from the request, so it cannot name a group
  // outside the caller's tenant.
  const { data: decisions } = await db
    .from("approval_decisions")
    .select(
      `
        *,
        group:approval_groups!approval_decisions_groupId_fkey(name),
        request:approval_requests!approval_decisions_requestId_fkey(
          id, type, entityType, entityId, title, description, status, createdAt,
          requestedBy:tenant_users!approval_requests_requestedById_fkey(fullName, email)
        )
      `
    )
    .in("groupId", groupIds)
    .eq("status", "PENDING")
    .order("createdAt", { ascending: false });

  // Only surface decisions whose parent request is still open.
  return (decisions || []).filter(
    (d: { request?: { status?: string } }) => d.request?.status === "PENDING"
  );
});
