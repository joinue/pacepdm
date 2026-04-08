import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { v4 as uuid } from "uuid";

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getCurrentTenantUser();
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

    return NextResponse.json(rule);
  } catch {
    return NextResponse.json({ error: "Failed to create rule" }, { status: 500 });
  }
}
