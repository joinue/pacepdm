import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ partId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { partId } = await params;
    const body = await request.json();
    const db = getServiceClient();
    const now = new Date().toISOString();

    if (!body.vendorName?.trim()) {
      return NextResponse.json({ error: "Vendor name is required" }, { status: 400 });
    }

    // If setting as primary, unset others
    if (body.isPrimary) {
      await db.from("part_vendors").update({ isPrimary: false }).eq("partId", partId);
    }

    const { data: vendor, error } = await db.from("part_vendors").insert({
      id: uuid(),
      partId,
      vendorName: body.vendorName.trim(),
      vendorPartNumber: body.vendorPartNumber?.trim() || null,
      unitCost: body.unitCost || null,
      currency: body.currency || "USD",
      leadTimeDays: body.leadTimeDays || null,
      isPrimary: body.isPrimary || false,
      notes: body.notes?.trim() || null,
      createdAt: now,
      updatedAt: now,
    }).select().single();

    if (error) throw error;

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "part.vendor_add", entityType: "part", entityId: partId, details: { vendorName: body.vendorName.trim(), vendorId: vendor.id } });

    return NextResponse.json(vendor);
  } catch {
    return NextResponse.json({ error: "Failed to add vendor" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ partId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { partId } = await params;
    const { vendorId } = await request.json();
    const db = getServiceClient();

    await db.from("part_vendors").delete().eq("id", vendorId).eq("partId", partId);

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "part.vendor_remove", entityType: "part", entityId: partId, details: { vendorId } });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to remove vendor" }, { status: 500 });
  }
}
