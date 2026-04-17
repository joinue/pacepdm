import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

const AddStepSchema = z.object({
  groupId: nonEmptyString,
  stepOrder: z.number().int().positive().optional(),
  approvalMode: z.enum(["ANY", "ALL", "MAJORITY"]).optional(),
  signatureLabel: z.string().optional(),
  deadlineHours: z.number().positive().nullable().optional(),
});

const RemoveStepSchema = z.object({ stepId: nonEmptyString });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, AddStepSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const { workflowId } = await params;
    const db = getServiceClient();

    // Get next step order
    const { data: existing } = await db.from("approval_workflow_steps")
      .select("stepOrder").eq("workflowId", workflowId).order("stepOrder", { ascending: false }).limit(1);

    const nextOrder = (existing && existing.length > 0 ? existing[0].stepOrder : 0) + 1;

    const { data: step, error } = await db.from("approval_workflow_steps").insert({
      id: uuid(),
      workflowId,
      groupId: body.groupId,
      stepOrder: body.stepOrder ?? nextOrder,
      approvalMode: body.approvalMode || "ANY",
      signatureLabel: body.signatureLabel?.trim() || "Approved",
      deadlineHours: body.deadlineHours ?? null,
      createdAt: new Date().toISOString(),
    }).select("*, group:approval_groups!approval_workflow_steps_groupId_fkey(id, name)").single();

    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "workflow_step.create", entityType: "workflow_step",
      entityId: step.id, details: { workflowId, groupId: body.groupId },
    });

    return NextResponse.json(step);
  } catch (err) {
    console.error("Failed to add step:", err);
    const message = err instanceof Error ? err.message : "Failed to add step";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, RemoveStepSchema);
    if (!parsed.ok) return parsed.response;
    const { stepId } = parsed.data;

    const { workflowId } = await params;
    const db = getServiceClient();

    await db.from("approval_workflow_steps").delete().eq("id", stepId).eq("workflowId", workflowId);

    // Re-order remaining steps
    const { data: remaining } = await db.from("approval_workflow_steps")
      .select("id").eq("workflowId", workflowId).order("stepOrder");

    if (remaining) {
      for (let i = 0; i < remaining.length; i++) {
        await db.from("approval_workflow_steps").update({ stepOrder: i + 1 }).eq("id", remaining[i].id);
      }
    }

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "workflow_step.delete", entityType: "workflow_step", entityId: stepId, details: { workflowId } });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to remove step:", err);
    const message = err instanceof Error ? err.message : "Failed to remove step";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
