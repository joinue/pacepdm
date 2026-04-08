import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

const BOM_STATUS_FLOW: Record<string, string[]> = {
  DRAFT: ["IN_REVIEW"],
  IN_REVIEW: ["APPROVED", "DRAFT"],
  APPROVED: ["RELEASED", "DRAFT"],
  RELEASED: ["OBSOLETE"],
  OBSOLETE: [],
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ bomId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { bomId } = await params;
    const db = getServiceClient();

    const { data: bom } = await db
      .from("boms")
      .select("*")
      .eq("id", bomId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!bom) {
      return NextResponse.json({ error: "BOM not found" }, { status: 404 });
    }

    return NextResponse.json(bom);
  } catch {
    return NextResponse.json({ error: "Failed to fetch BOM" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ bomId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { bomId } = await params;
    const body = await request.json();
    const db = getServiceClient();

    // Verify ownership
    const { data: existing } = await db
      .from("boms")
      .select("status, name")
      .eq("id", bomId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!existing) {
      return NextResponse.json({ error: "BOM not found" }, { status: 404 });
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    const changes: Record<string, string | null> = {};

    // Name update
    if (body.name !== undefined && body.name.trim() !== existing.name) {
      updates.name = body.name.trim();
      changes.name = body.name.trim();
    }

    // Status transition
    if (body.status && body.status !== existing.status) {
      const allowed = BOM_STATUS_FLOW[existing.status] || [];
      if (!allowed.includes(body.status)) {
        return NextResponse.json(
          { error: `Cannot change status from ${existing.status} to ${body.status}. Allowed: ${allowed.join(", ") || "none"}` },
          { status: 400 }
        );
      }
      updates.status = body.status;
      changes.status = `${existing.status} → ${body.status}`;
    }

    // Revision update
    if (body.revision !== undefined) {
      updates.revision = body.revision;
      changes.revision = body.revision;
    }

    const { data: bom, error } = await db
      .from("boms")
      .update(updates)
      .eq("id", bomId)
      .select()
      .single();

    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "bom.update",
      entityType: "bom",
      entityId: bomId,
      details: changes,
    });

    return NextResponse.json(bom);
  } catch {
    return NextResponse.json({ error: "Failed to update BOM" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ bomId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { bomId } = await params;
    const db = getServiceClient();

    // Verify ownership and get name for audit
    const { data: existing } = await db
      .from("boms")
      .select("name, status")
      .eq("id", bomId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!existing) {
      return NextResponse.json({ error: "BOM not found" }, { status: 404 });
    }

    if (existing.status === "RELEASED") {
      return NextResponse.json(
        { error: "Cannot delete a released BOM. Obsolete it first." },
        { status: 400 }
      );
    }

    // CASCADE will delete bom_items
    const { error } = await db.from("boms").delete().eq("id", bomId);
    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "bom.delete",
      entityType: "bom",
      entityId: bomId,
      details: { name: existing.name },
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete BOM" }, { status: 500 });
  }
}
