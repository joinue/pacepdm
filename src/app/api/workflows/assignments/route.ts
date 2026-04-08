import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { workflowId, transitionId, ecoTrigger } = await request.json();
    if (!workflowId) {
      return NextResponse.json({ error: "workflowId is required" }, { status: 400 });
    }

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

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "workflow_assignment.create", entityType: "workflow_assignment", entityId: data.id, details: { workflowId, transitionId: transitionId || null, ecoTrigger: ecoTrigger || null } });

    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to create assignment" }, { status: 500 });
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

    const { assignmentId } = await request.json();
    const db = getServiceClient();

    await db.from("approval_workflow_assignments").delete().eq("id", assignmentId).eq("tenantId", tenantUser.tenantId);

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "workflow_assignment.delete", entityType: "workflow_assignment", entityId: assignmentId });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete assignment" }, { status: 500 });
  }
}
