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

    if (!body.vendorId) {
      return NextResponse.json({ error: "vendorId is required" }, { status: 400 });
    }

    // Verify part belongs to this tenant before mutating part_vendors —
    // missing tenant check was a latent cross-tenant write risk.
    const { data: part } = await db
      .from("parts")
      .select("id, tenantId")
      .eq("id", partId)
      .eq("tenantId", tenantUser.tenantId)
      .single();
    if (!part) {
      return NextResponse.json({ error: "Part not found" }, { status: 404 });
    }

    // Verify the vendor belongs to the same tenant — prevents linking a part
    // to another tenant's vendor by guessing IDs
    const { data: vendorRecord } = await db
      .from("vendors")
      .select("id, name")
      .eq("id", body.vendorId)
      .eq("tenantId", tenantUser.tenantId)
      .single();
    if (!vendorRecord) {
      return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
    }

    // If setting as primary, unset others on this part
    if (body.isPrimary) {
      await db.from("part_vendors").update({ isPrimary: false }).eq("partId", partId);
    }

    const { data: link, error } = await db.from("part_vendors").insert({
      id: uuid(),
      partId,
      vendorId: body.vendorId,
      // vendorName is the legacy text column, kept in sync until migration 010
      // drops it. Populating it from the canonical vendor record keeps old
      // code paths and any external SQL queries working during the transition.
      vendorName: vendorRecord.name,
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

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "part.vendor_add", entityType: "part", entityId: partId, details: { vendorId: body.vendorId, vendorName: vendorRecord.name, linkId: link.id } });

    return NextResponse.json(link);
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
