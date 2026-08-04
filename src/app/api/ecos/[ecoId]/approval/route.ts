import { withTenant } from "@/lib/api-route";
import { getRequestTimeline } from "@/lib/approval-engine";
import { z, uuid } from "@/lib/validation";

const ParamsSchema = z.object({ ecoId: uuid });

/** The most recent approval request for this ECO, with its decision timeline. */
export const GET = withTenant({ params: ParamsSchema }, async ({ db, params }) => {
  const { data: requests } = await db
    .from("approval_requests")
    .select(
      `
        *,
        requestedBy:tenant_users!approval_requests_requestedById_fkey(fullName, email),
        workflow:approval_workflows!approval_requests_workflowId_fkey(name),
        decisions:approval_decisions(
          id, groupId, stepId, status, comment, decidedAt, signatureLabel, approvalMode, deadlineAt,
          group:approval_groups!approval_decisions_groupId_fkey(name),
          decider:tenant_users!approval_decisions_deciderId_fkey(fullName),
          step:approval_workflow_steps!approval_decisions_stepId_fkey(stepOrder, signatureLabel)
        )
      `
    )
    .eq("entityType", "eco")
    .eq("entityId", params.ecoId)
    .order("createdAt", { ascending: false })
    .limit(1);

  if (!requests || requests.length === 0) return null;

  const request = requests[0];
  const timeline = await getRequestTimeline(request.id);

  return { ...request, timeline };
});
