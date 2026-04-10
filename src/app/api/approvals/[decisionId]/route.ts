import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { processDecision, rejectForRework } from "@/lib/approval-engine";
import { logAudit } from "@/lib/audit";
import { processMentions } from "@/lib/mentions";
import { sideEffect } from "@/lib/notifications";
import { z, parseBody } from "@/lib/validation";

// A single decision body covers three flows:
//   - rework: true                 → reject-and-request-rework path
//   - status: "APPROVED"|"REJECTED" → normal decide path
// status is enforced after parse since the rework flow ignores it.
const DecisionSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]).optional(),
  comment: z.string().optional(),
  rework: z.boolean().optional(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ decisionId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const parsed = await parseBody(request, DecisionSchema);
    if (!parsed.ok) return parsed.response;
    const { status, comment, rework } = parsed.data;

    const { decisionId } = await params;

    if (rework) {
      // Reject-and-rework flow requires a non-empty comment
      if (!comment?.trim()) {
        return NextResponse.json({ error: "Comment is required for rework requests" }, { status: 400 });
      }

      const result = await rejectForRework({
        decisionId,
        tenantId: tenantUser.tenantId,
        userId: tenantUser.id,
        userFullName: tenantUser.fullName,
        comment: comment.trim(),
      });

      if ("error" in result) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }

      await sideEffect(
        processMentions({
          tenantId: tenantUser.tenantId,
          mentionedById: tenantUser.id,
          mentionedByName: tenantUser.fullName,
          entityType: "approval_decision",
          entityId: decisionId,
          comment: comment.trim(),
          link: "/approvals",
        }),
        `process mentions for approval decision ${decisionId}`
      );

      return NextResponse.json({ success: true, requestStatus: "REWORK" });
    }

    if (!status) {
      return NextResponse.json({ error: "Status must be APPROVED or REJECTED" }, { status: 400 });
    }

    // Check if this decision has a stepId (workflow-based) or not (legacy)
    const db = getServiceClient();
    const { data: decision } = await db.from("approval_decisions").select("stepId").eq("id", decisionId).single();

    if (decision?.stepId) {
      // Workflow-based approval — use the engine
      const result = await processDecision({
        decisionId,
        tenantId: tenantUser.tenantId,
        userId: tenantUser.id,
        userFullName: tenantUser.fullName,
        status,
        comment,
      });

      if ("error" in result) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }

      if (comment?.trim()) {
        await sideEffect(
          processMentions({
            tenantId: tenantUser.tenantId,
            mentionedById: tenantUser.id,
            mentionedByName: tenantUser.fullName,
            entityType: "approval_decision",
            entityId: decisionId,
            comment: comment.trim(),
            link: "/approvals",
          }),
          `process mentions for approval decision ${decisionId}`
        );
      }

      return NextResponse.json(result);
    }

    // Legacy approval flow (no workflow) — original logic
    const { data: fullDecision } = await db
      .from("approval_decisions")
      .select("*, request:approval_requests!approval_decisions_requestId_fkey(*)")
      .eq("id", decisionId)
      .single();

    if (!fullDecision) {
      return NextResponse.json({ error: "Decision not found" }, { status: 404 });
    }

    // Verify user is in the group
    const { data: membership } = await db
      .from("approval_group_members")
      .select("id")
      .eq("groupId", fullDecision.groupId)
      .eq("userId", tenantUser.id)
      .single();

    if (!membership) {
      return NextResponse.json({ error: "You are not a member of this approval group" }, { status: 403 });
    }

    const now = new Date().toISOString();

    await db.from("approval_decisions").update({
      status,
      deciderId: tenantUser.id,
      comment: comment || null,
      decidedAt: now,
    }).eq("id", decisionId);

    const requestId = fullDecision.requestId;

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

      if (requestStatus === "APPROVED" && fullDecision.request.entityType === "file" && fullDecision.request.transitionId) {
        const { data: transition } = await db
          .from("lifecycle_transitions")
          .select("*, toState:lifecycle_states!lifecycle_transitions_toStateId_fkey(name)")
          .eq("id", fullDecision.request.transitionId)
          .single();

        if (transition) {
          await db.from("files").update({
            lifecycleState: transition.toState.name,
            updatedAt: now,
          }).eq("id", fullDecision.request.entityId);

          await logAudit({
            tenantId: tenantUser.tenantId,
            userId: tenantUser.id,
            action: "file.transition.approved",
            entityType: "file",
            entityId: fullDecision.request.entityId,
            details: { newState: transition.toState.name, transition: transition.name },
          });
        }
      }

      if (fullDecision.request.entityType === "eco") {
        await db.from("ecos").update({
          status: requestStatus === "APPROVED" ? "APPROVED" : "REJECTED",
          updatedAt: now,
        }).eq("id", fullDecision.request.entityId);
      }
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: `approval.${status.toLowerCase()}`,
      entityType: fullDecision.request.entityType,
      entityId: fullDecision.request.entityId,
      details: { title: fullDecision.request.title, comment: comment ?? null },
    });

    if (comment?.trim()) {
      await sideEffect(
        processMentions({
          tenantId: tenantUser.tenantId,
          mentionedById: tenantUser.id,
          mentionedByName: tenantUser.fullName,
          entityType: "approval_decision",
          entityId: decisionId,
          comment: comment.trim(),
          link: "/approvals",
        }),
        `process mentions for approval decision ${decisionId}`
      );
    }

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
