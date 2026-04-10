import { NextRequest, NextResponse } from "next/server";
import { getApiTenantUser } from "@/lib/auth";
import { processDecision, rejectForRework } from "@/lib/approval-engine";
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
  } catch (error) {
    console.error("Approval decision error:", error);
    return NextResponse.json({ error: "Failed to record decision" }, { status: 500 });
  }
}
