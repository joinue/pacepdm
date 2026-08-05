import { withTenant } from "@/lib/api-route";

/**
 * How many approvals are waiting on the current user.
 *
 * This exists because `NotificationProvider` needs a number, and it was
 * getting it by fetching `GET /api/approvals` — full decision rows with three
 * nested joins (group, request, requestedBy) — and calling `.length` on the
 * result. That ran on mount, on every tab focus, on a 60s interval, and on
 * every `approval_decisions` change, so the heaviest read in the app was also
 * its most frequent, to render a badge.
 *
 * The filter matches `/api/approvals` exactly, including the parent-request
 * check: a decision row can outlive its request when a sibling step rejects or
 * recalls it, and counting those would show a badge for work that no longer
 * exists. `!inner` pushes that check into the join so this stays a count
 * rather than a fetch-then-filter.
 *
 * Scoping runs through group membership rather than a tenantId column — see
 * `/api/approvals` for why that is sufficient.
 */
export const GET = withTenant({}, async ({ db, tenantUser }) => {
  // lint-conventions-allow: child-table-direct-query — filtered by the caller's
  // own tenant_users.id, which the wrapper resolved from the session.
  const { data: memberships } = await db
    .from("approval_group_members")
    .select("groupId")
    .eq("userId", tenantUser.id);

  const groupIds = (memberships || []).map((m: { groupId: string }) => m.groupId);
  if (groupIds.length === 0) return { count: 0 };

  // lint-conventions-allow: child-table-direct-query — `groupIds` comes from the
  // membership query above, never from the request, so it cannot name a group
  // outside the caller's tenant.
  const { count, error } = await db
    .from("approval_decisions")
    .select("id, request:approval_requests!approval_decisions_requestId_fkey!inner(status)", {
      count: "exact",
      head: true,
    })
    .in("groupId", groupIds)
    .eq("status", "PENDING")
    .eq("request.status", "PENDING");

  if (error) throw new Error(error.message);

  return { count: count ?? 0 };
});
