import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

const CreateAssignmentSchema = z.object({
  workflowId: nonEmptyString,
  transitionId: z.string().nullable().optional(),
  ecoTrigger: z.string().nullable().optional(),
});

const DeleteAssignmentSchema = z.object({ assignmentId: nonEmptyString });

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, CreateAssignmentSchema);
    if (!parsed.ok) return parsed.response;
    const { workflowId, transitionId, ecoTrigger } = parsed.data;

    const db = getServiceClient();

    const { data, error } = await db.from("approval_workflow_assignments").insert({
      id: uuid(),
      tenantId: tenantUser.tenantId,
      workflowId,
      transitionId: transitionId || null,
      ecoTrigger: ecoTrigger || null,
      createdAt: new Date().toISOString(),
    }).select().single();

    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "workflow_assignment.create", entityType: "workflow_assignment",
      entityId: data.id,
      details: { workflowId, transitionId: transitionId ?? null, ecoTrigger: ecoTrigger ?? null },
    });

    return NextResponse.json(data);
  } catch (err) {
    console.error("Failed to create assignment:", err);
    const message = err instanceof Error ? err.message : "Failed to create assignment";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, DeleteAssignmentSchema);
    if (!parsed.ok) return parsed.response;
    const { assignmentId } = parsed.data;

    const db = getServiceClient();

    await db.from("approval_workflow_assignments").delete().eq("id", assignmentId).eq("tenantId", tenantUser.tenantId);

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "workflow_assignment.delete", entityType: "workflow_assignment", entityId: assignmentId });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to delete assignment:", err);
    const message = err instanceof Error ? err.message : "Failed to delete assignment";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
