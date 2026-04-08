import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function PUT(
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

    const { workflowId } = await params;
    const body = await request.json();
    const db = getServiceClient();

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.description !== undefined) updates.description = body.description?.trim() || null;
    if (body.isActive !== undefined) updates.isActive = body.isActive;

    const { data, error } = await db.from("approval_workflows").update(updates)
      .eq("id", workflowId).eq("tenantId", tenantUser.tenantId).select().single();

    if (error) {
      if (error.code === "23505") return NextResponse.json({ error: "Name already exists" }, { status: 409 });
      throw error;
    }
    if (!data) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "workflow.update", entityType: "workflow", entityId: workflowId, details: { name: data.name } });

    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to update workflow" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { workflowId } = await params;
    const db = getServiceClient();

    // Check for active approval requests using this workflow
    const { count } = await db.from("approval_requests").select("*", { count: "exact", head: true })
      .eq("workflowId", workflowId).eq("status", "PENDING");

    if (count && count > 0) {
      return NextResponse.json({ error: `Cannot delete — ${count} pending approval request(s) use this workflow` }, { status: 400 });
    }

    await db.from("approval_workflows").delete().eq("id", workflowId).eq("tenantId", tenantUser.tenantId);

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "workflow.delete", entityType: "workflow", entityId: workflowId });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete workflow" }, { status: 500 });
  }
}
