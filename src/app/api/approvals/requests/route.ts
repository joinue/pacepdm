import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { recallRequest, resubmitAfterRework, getRequestTimeline } from "@/lib/approval-engine";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

const RequestActionSchema = z.object({
  requestId: nonEmptyString,
  action: z.enum(["recall", "resubmit"]),
});

// Get my approval requests (as requester) + timeline for a specific request
export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = getServiceClient();
    const { searchParams } = new URL(request.url);
    const requestId = searchParams.get("requestId");

    if (requestId) {
      // Get timeline for a specific request
      const timeline = await getRequestTimeline(requestId);

      // Also get the full request with decisions
      const { data: req } = await db.from("approval_requests").select(`
        *,
        requestedBy:tenant_users!approval_requests_requestedById_fkey(fullName, email),
        decisions:approval_decisions(
          id, groupId, stepId, status, comment, decidedAt, signatureLabel, approvalMode, deadlineAt,
          group:approval_groups!approval_decisions_groupId_fkey(name),
          decider:tenant_users!approval_decisions_deciderId_fkey(fullName),
          step:approval_workflow_steps!approval_decisions_stepId_fkey(stepOrder, signatureLabel)
        ),
        workflow:approval_workflows!approval_requests_workflowId_fkey(name)
      `).eq("id", requestId).eq("tenantId", tenantUser.tenantId).single();

      if (!req) return NextResponse.json({ error: "Request not found" }, { status: 404 });

      return NextResponse.json({ ...req, timeline });
    }

    // Get all my requests (submitted by me)
    const { data: myRequests } = await db
      .from("approval_requests")
      .select(`
        id, type, entityType, entityId, title, status, currentStepOrder, createdAt, updatedAt, completedAt,
        workflow:approval_workflows!approval_requests_workflowId_fkey(name),
        decisions:approval_decisions(id, status, signatureLabel, group:approval_groups!approval_decisions_groupId_fkey(name))
      `)
      .eq("tenantId", tenantUser.tenantId)
      .eq("requestedById", tenantUser.id)
      .order("createdAt", { ascending: false })
      .limit(50);

    return NextResponse.json(myRequests || []);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch requests";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Recall or resubmit a request
export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const parsed = await parseBody(request, RequestActionSchema);
    if (!parsed.ok) return parsed.response;
    const { requestId, action } = parsed.data;

    if (action === "recall") {
      const result = await recallRequest({
        requestId,
        tenantId: tenantUser.tenantId,
        userId: tenantUser.id,
        userFullName: tenantUser.fullName,
      });
      if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });
      return NextResponse.json(result);
    }

    // resubmit (the only other allowed value via the enum)
    const result = await resubmitAfterRework({
      requestId,
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      userFullName: tenantUser.fullName,
    });
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to process request";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
