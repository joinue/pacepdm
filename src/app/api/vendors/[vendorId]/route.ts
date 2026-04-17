import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

function normalizeVendorName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ vendorId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { vendorId } = await params;
    const db = getServiceClient();

    const { data: vendor } = await db
      .from("vendors")
      .select("*")
      .eq("id", vendorId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!vendor) {
      return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
    }

    // Surface where this vendor is used so the detail view can show context
    const { data: links } = await db
      .from("part_vendors")
      .select("id, partId, vendorPartNumber, unitCost, currency, leadTimeDays, isPrimary, part:parts!part_vendors_partId_fkey(id, partNumber, name, tenantId)")
      .eq("vendorId", vendorId);

    // Filter to current tenant — defense in depth against cross-tenant joins
    const usedBy = (links || []).filter((row) => {
      const part = row.part as unknown as { tenantId: string } | null;
      return part && part.tenantId === tenantUser.tenantId;
    });

    return NextResponse.json({ ...vendor, usedBy });
  } catch (err) {
    console.error("GET /api/vendors/[vendorId] failed:", err);
    return NextResponse.json({ error: "Failed to fetch vendor" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ vendorId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { vendorId } = await params;
    const body = await request.json();
    const db = getServiceClient();

    const { data: existing } = await db
      .from("vendors")
      .select("name")
      .eq("id", vendorId)
      .eq("tenantId", tenantUser.tenantId)
      .single();
    if (!existing) {
      return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.name !== undefined) {
      const name = normalizeVendorName(body.name);
      if (!name) {
        return NextResponse.json({ error: "Vendor name cannot be empty" }, { status: 400 });
      }
      updates.name = name;
    }
    for (const field of ["website", "contactName", "contactEmail", "contactPhone", "notes"]) {
      if (body[field] !== undefined) {
        updates[field] = body[field]?.trim() || null;
      }
    }

    const { data: vendor, error } = await db
      .from("vendors")
      .update(updates)
      .eq("id", vendorId)
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "A vendor with this name already exists" }, { status: 409 });
      }
      throw error;
    }

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "vendor.update", entityType: "vendor", entityId: vendorId,
      details: { name: vendor.name },
    });

    return NextResponse.json(vendor);
  } catch (err) {
    console.error("PUT /api/vendors/[vendorId] failed:", err);
    return NextResponse.json({ error: "Failed to update vendor" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ vendorId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { vendorId } = await params;
    const db = getServiceClient();

    const { data: existing } = await db
      .from("vendors")
      .select("name")
      .eq("id", vendorId)
      .eq("tenantId", tenantUser.tenantId)
      .single();
    if (!existing) {
      return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
    }

    // Prevent orphaning part_vendors rows. The DB FK is ON DELETE RESTRICT
    // and will refuse the delete, but we check first to return a friendly
    // error message instead of a generic constraint violation.
    const { count } = await db
      .from("part_vendors")
      .select("*", { count: "exact", head: true })
      .eq("vendorId", vendorId);
    if (count && count > 0) {
      return NextResponse.json(
        { error: `Cannot delete — vendor is linked to ${count} part(s). Remove from all parts first.` },
        { status: 400 }
      );
    }

    const { error } = await db.from("vendors").delete().eq("id", vendorId);
    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "vendor.delete", entityType: "vendor", entityId: vendorId,
      details: { name: existing.name },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/vendors/[vendorId] failed:", err);
    return NextResponse.json({ error: "Failed to delete vendor" }, { status: 500 });
  }
}
