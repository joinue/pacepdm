import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

const MemberSchema = z.object({ userId: nonEmptyString });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, MemberSchema);
    if (!parsed.ok) return parsed.response;
    const { userId } = parsed.data;

    const { groupId } = await params;
    const db = getServiceClient();

    const { error } = await db.from("approval_group_members").insert({
      id: uuid(),
      groupId,
      userId,
      createdAt: new Date().toISOString(),
    });

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "User already in group" }, { status: 409 });
      }
      throw error;
    }

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "approval_group.member_add", entityType: "approval_group",
      entityId: groupId, details: { memberId: userId },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to add member:", err);
    const message = err instanceof Error ? err.message : "Failed to add member";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, MemberSchema);
    if (!parsed.ok) return parsed.response;
    const { userId } = parsed.data;

    const { groupId } = await params;
    const db = getServiceClient();

    await db.from("approval_group_members").delete().eq("groupId", groupId).eq("userId", userId);

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "approval_group.member_remove", entityType: "approval_group",
      entityId: groupId, details: { memberId: userId },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to remove member:", err);
    const message = err instanceof Error ? err.message : "Failed to remove member";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
