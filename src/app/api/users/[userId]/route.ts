import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];

    if (!hasPermission(permissions, PERMISSIONS.ADMIN_USERS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { userId } = await params;
    const body = await request.json();

    if (typeof body.isActive !== "boolean") {
      return NextResponse.json({ error: "isActive (boolean) is required" }, { status: 400 });
    }

    // Prevent self-deactivation
    if (userId === tenantUser.id && !body.isActive) {
      return NextResponse.json({ error: "You cannot deactivate yourself" }, { status: 400 });
    }

    const db = getServiceClient();

    const { data: targetUser } = await db
      .from("tenant_users")
      .select("id, fullName, tenantId")
      .eq("id", userId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!targetUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const { error } = await db
      .from("tenant_users")
      .update({ isActive: body.isActive })
      .eq("id", userId)
      .eq("tenantId", tenantUser.tenantId);

    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: body.isActive ? "user.activate" : "user.deactivate",
      entityType: "user",
      entityId: userId,
      details: { targetUser: targetUser.fullName },
    });

    return NextResponse.json({ success: true, isActive: body.isActive });
  } catch (error) {
    console.error("User update error:", error);
    return NextResponse.json({ error: "Failed to update user" }, { status: 500 });
  }
}
