import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser } from "@/lib/auth";
import { ApprovalGroupsClient } from "./approval-groups-client";

export default async function ApprovalGroupsPage() {
  const tenantUser = await getCurrentTenantUser();
  const db = getServiceClient();

  const [{ data: users }, { data: lifecycles }] = await Promise.all([
    db.from("tenant_users")
      .select("id, fullName, email")
      .eq("tenantId", tenantUser.tenantId)
      .eq("isActive", true)
      .order("fullName"),
    db.from("lifecycles")
      .select("id, name")
      .eq("tenantId", tenantUser.tenantId),
  ]);

  // Get transitions with their current approval rules
  const transitions = [];
  for (const lc of lifecycles || []) {
    const { data: trans } = await db
      .from("lifecycle_transitions")
      .select("id, name, requiresApproval, fromState:lifecycle_states!lifecycle_transitions_fromStateId_fkey(name), toState:lifecycle_states!lifecycle_transitions_toStateId_fkey(name)")
      .eq("lifecycleId", lc.id);

    for (const t of trans || []) {
      const { data: rules } = await db
        .from("transition_approval_rules")
        .select("id, groupId, isRequired, sortOrder")
        .eq("transitionId", t.id)
        .order("sortOrder");
      transitions.push({ ...t, lifecycleName: lc.name, rules: rules || [] });
    }
  }

  return (
    <ApprovalGroupsClient
      users={users || []}
      transitions={transitions}
    />
  );
}
