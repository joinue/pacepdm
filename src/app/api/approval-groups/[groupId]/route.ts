import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { groupId } = await params;
    const db = getServiceClient();

    const { data: group } = await db.from("approval_groups").select("tenantId").eq("id", groupId).single();
    if (!group || group.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await db.from("approval_group_members").delete().eq("groupId", groupId);
    await db.from("transition_approval_rules").delete().eq("groupId", groupId);
    await db.from("approval_groups").delete().eq("id", groupId);

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "approval_group.delete", entityType: "approval_group", entityId: groupId });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete group";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
