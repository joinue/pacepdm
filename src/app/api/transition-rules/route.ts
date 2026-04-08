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

    const { transitionId, groupId } = await request.json();
    const db = getServiceClient();

    const { data: rule, error } = await db.from("transition_approval_rules").insert({
      id: uuid(),
      transitionId,
      groupId,
      isRequired: true,
      sortOrder: 0,
    }).select().single();

    if (error) {
      if (error.code === "23505") return NextResponse.json({ error: "Already assigned" }, { status: 409 });
      throw error;
    }

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "transition_rule.create", entityType: "transition_rule", entityId: rule.id, details: { transitionId, groupId } });

    return NextResponse.json(rule);
  } catch {
    return NextResponse.json({ error: "Failed to create rule" }, { status: 500 });
  }
}
