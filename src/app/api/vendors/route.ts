import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";

// Canonicalize vendor names so "Digi-Key", "digi-key", "Digi  Key " all
// resolve to the same vendor. The DB unique index is exact-match on `name`,
// so we MUST normalize before insert/lookup or we'll create duplicates.
function normalizeVendorName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = getServiceClient();
    const { searchParams } = new URL(request.url);

    const q = searchParams.get("q");
    const withCounts = searchParams.get("withCounts") === "1";

    let query = db
      .from("vendors")
      .select("*")
      .eq("tenantId", tenantUser.tenantId)
      .order("name");

    if (q) {
      // ilike handles case-insensitive partial match — picker uses this
      query = query.ilike("name", `%${q}%`);
    }

    const { data: vendors } = await query.limit(200);

    // For the vendors list page we want a "used by N parts" badge. Doing this
    // as a second query (one in() call) is cheaper than a join because the
    // vendors page rarely has thousands of rows.
    if (withCounts && vendors && vendors.length > 0) {
      const ids = vendors.map((v) => v.id);
      const { data: links } = await db
        .from("part_vendors")
        .select("vendorId")
        .in("vendorId", ids);
      const counts = new Map<string, number>();
      for (const row of links || []) {
        counts.set(row.vendorId, (counts.get(row.vendorId) || 0) + 1);
      }
      return NextResponse.json(
        vendors.map((v) => ({ ...v, partCount: counts.get(v.id) || 0 }))
      );
    }

    return NextResponse.json(vendors || []);
  } catch (err) {
    console.error("GET /api/vendors failed:", err);
    return NextResponse.json({ error: "Failed to fetch vendors" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    if (!body.name?.trim()) {
      return NextResponse.json({ error: "Vendor name is required" }, { status: 400 });
    }

    const name = normalizeVendorName(body.name);
    const db = getServiceClient();
    const now = new Date().toISOString();

    // Idempotent create: if a vendor with this canonical name already exists
    // for the tenant, return it instead of erroring. This makes the inline
    // "create new vendor" flow on the part-detail picker safe to retry.
    const { data: existing } = await db
      .from("vendors")
      .select("*")
      .eq("tenantId", tenantUser.tenantId)
      .ilike("name", name)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(existing);
    }

    const { data: vendor, error } = await db
      .from("vendors")
      .insert({
        id: uuid(),
        tenantId: tenantUser.tenantId,
        name,
        website: body.website?.trim() || null,
        contactName: body.contactName?.trim() || null,
        contactEmail: body.contactEmail?.trim() || null,
        contactPhone: body.contactPhone?.trim() || null,
        notes: body.notes?.trim() || null,
        createdAt: now,
        updatedAt: now,
      })
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
      action: "vendor.create", entityType: "vendor", entityId: vendor.id,
      details: { name: vendor.name },
    });

    return NextResponse.json(vendor);
  } catch (err) {
    console.error("POST /api/vendors failed:", err);
    return NextResponse.json({ error: "Failed to create vendor" }, { status: 500 });
  }
}
