import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ decisionId: string }> }
) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const { decisionId } = await params;
    const { status, comment } = await request.json();

    if (!["APPROVED", "REJECTED"].includes(status)) {
      return NextResponse.json({ error: "Status must be APPROVED or REJECTED" }, { status: 400 });
    }

    const db = getServiceClient();

    // Get the decision and verify the user is in the approval group
    const { data: decision } = await db
      .from("approval_decisions")
      .select("*, request:approval_requests!approval_decisions_requestId_fkey(*)")
      .eq("id", decisionId)
      .single();

    if (!decision) {
      return NextResponse.json({ error: "Decision not found" }, { status: 404 });
    }

    // Verify user is a member of the approval group
    const { data: membership } = await db
      .from("approval_group_members")
      .select("id")
      .eq("groupId", decision.groupId)
      .eq("userId", tenantUser.id)
      .single();

    if (!membership) {
      return NextResponse.json({ error: "You are not a member of this approval group" }, { status: 403 });
    }

    const now = new Date().toISOString();

    // Record the decision
    await db.from("approval_decisions").update({
      status,
      deciderId: tenantUser.id,
      comment: comment || null,
      decidedAt: now,
    }).eq("id", decisionId);

    const requestId = decision.requestId;

    // Check if all decisions for this request are resolved
    const { data: allDecisions } = await db
      .from("approval_decisions")
      .select("status")
      .eq("requestId", requestId);

    const allResolved = (allDecisions || []).every((d) => d.status !== "PENDING");
    const anyRejected = (allDecisions || []).some((d) => d.status === "REJECTED");

    if (allResolved) {
      const requestStatus = anyRejected ? "REJECTED" : "APPROVED";

      await db.from("approval_requests").update({
        status: requestStatus,
        updatedAt: now,
        completedAt: now,
      }).eq("id", requestId);

      // If approved and it's a file transition, execute the transition
      if (requestStatus === "APPROVED" && decision.request.entityType === "file" && decision.request.transitionId) {
        const { data: transition } = await db
          .from("lifecycle_transitions")
          .select("*, toState:lifecycle_states!lifecycle_transitions_toStateId_fkey(name)")
          .eq("id", decision.request.transitionId)
          .single();

        if (transition) {
          await db.from("files").update({
            lifecycleState: transition.toState.name,
            updatedAt: now,
          }).eq("id", decision.request.entityId);

          await logAudit({
            tenantId: tenantUser.tenantId,
            userId: tenantUser.id,
            action: "file.transition.approved",
            entityType: "file",
            entityId: decision.request.entityId,
            details: { newState: transition.toState.name, transition: transition.name },
          });
        }
      }

      // If approved and it's an ECO, update ECO status
      if (requestStatus === "APPROVED" && decision.request.entityType === "eco") {
        await db.from("ecos").update({
          status: "APPROVED",
          updatedAt: now,
        }).eq("id", decision.request.entityId);
      }

      if (requestStatus === "REJECTED" && decision.request.entityType === "eco") {
        await db.from("ecos").update({
          status: "REJECTED",
          updatedAt: now,
        }).eq("id", decision.request.entityId);
      }
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: `approval.${status.toLowerCase()}`,
      entityType: decision.request.entityType,
      entityId: decision.request.entityId,
      details: { title: decision.request.title, comment },
    });

    return NextResponse.json({
      success: true,
      requestComplete: allResolved,
      requestStatus: anyRejected ? "REJECTED" : allResolved ? "APPROVED" : "PENDING",
    });
  } catch (error) {
    console.error("Approval decision error:", error);
    return NextResponse.json({ error: "Failed to record decision" }, { status: 500 });
  }
}
