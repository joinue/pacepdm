import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { getRequestTimeline } from "@/lib/approval-engine";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ ecoId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { ecoId } = await params;
    const db = getServiceClient();

    // Find the most recent approval request for this ECO
    const { data: requests } = await db
      .from("approval_requests")
      .select(`
        *,
        requestedBy:tenant_users!approval_requests_requestedById_fkey(fullName, email),
        workflow:approval_workflows!approval_requests_workflowId_fkey(name),
        decisions:approval_decisions(
          id, groupId, stepId, status, comment, decidedAt, signatureLabel, approvalMode, deadlineAt,
          group:approval_groups!approval_decisions_groupId_fkey(name),
          decider:tenant_users!approval_decisions_deciderId_fkey(fullName),
          step:approval_workflow_steps!approval_decisions_stepId_fkey(stepOrder, signatureLabel)
        )
      `)
      .eq("tenantId", tenantUser.tenantId)
      .eq("entityType", "eco")
      .eq("entityId", ecoId)
      .order("createdAt", { ascending: false })
      .limit(1);

    if (!requests || requests.length === 0) {
      return NextResponse.json(null);
    }

    const request = requests[0];
    const timeline = await getRequestTimeline(request.id);

    return NextResponse.json({ ...request, timeline });
  } catch (err) {
    console.error("GET /api/ecos/[ecoId]/approval failed:", err);
    return NextResponse.json({ error: "Failed to fetch approval status" }, { status: 500 });
  }
}
