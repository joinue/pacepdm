import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ ecoId: string }> }
) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const permissions = tenantUser.role.permissions as string[];
    const { ecoId } = await params;

    if (!hasPermission(permissions, PERMISSIONS.ECO_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const db = getServiceClient();
    const { status } = await request.json();

    const { data: eco } = await db.from("ecos").select("*").eq("id", ecoId).single();
    if (!eco || eco.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "ECO not found" }, { status: 404 });
    }

    const { error } = await db.from("ecos")
      .update({ status, updatedAt: new Date().toISOString() })
      .eq("id", ecoId);

    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "eco.status_change",
      entityType: "eco",
      entityId: ecoId,
      details: { ecoNumber: eco.ecoNumber, from: eco.status, to: status },
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to update ECO" }, { status: 500 });
  }
}
