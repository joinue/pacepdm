import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z, parseBody, optionalString } from "@/lib/validation";

// Update is partial — any of these fields can be supplied. The schema
// keeps the route from blindly trusting arbitrary keys.
const UpdatePartSchema = z.object({
  partNumber: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  description: optionalString,
  category: z.string().optional(),
  revision: z.string().optional(),
  lifecycleState: z.string().optional(),
  material: optionalString,
  weight: z.number().nullable().optional(),
  weightUnit: z.string().optional(),
  unitCost: z.number().nullable().optional(),
  currency: z.string().optional(),
  unit: z.string().optional(),
  thumbnailUrl: z.string().nullable().optional(),
  notes: optionalString,
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ partId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { partId } = await params;
    const db = getServiceClient();

    const { data: part } = await db
      .from("parts")
      .select("*")
      .eq("id", partId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!part) {
      return NextResponse.json({ error: "Part not found" }, { status: 404 });
    }

    // Fetch vendors, files, and where-used in parallel
    const [{ data: vendors }, { data: partFiles }, { data: bomItems }] = await Promise.all([
      // Join the canonical vendors row so we get a stable name even if the
      // legacy `vendorName` text column is later dropped. Order by isPrimary
      // first so the primary vendor lands at index 0.
      db.from("part_vendors")
        .select("*, vendor:vendors!part_vendors_vendorId_fkey(id, name, website, contactName, contactEmail, contactPhone)")
        .eq("partId", partId)
        .order("isPrimary", { ascending: false }),
      db.from("part_files").select("*, file:files!part_files_fileId_fkey(id, name, partNumber, revision, lifecycleState, fileType)").eq("partId", partId),
      db.from("bom_items").select("id, itemNumber, name, quantity, unit, bomId, bom:boms!bom_items_bomId_fkey(id, name, revision, status, tenantId)").eq("partId", partId),
    ]);

    // Filter where-used to current tenant
    const whereUsed = (bomItems || [])
      .filter((item) => {
        const bom = item.bom as unknown as { tenantId: string } | null;
        return bom && bom.tenantId === tenantUser.tenantId;
      })
      .map((item) => {
        const bom = item.bom as unknown as { id: string; name: string; revision: string; status: string };
        return { bomId: bom.id, bomName: bom.name, bomRevision: bom.revision, bomStatus: bom.status, quantity: item.quantity, unit: item.unit };
      });

    return NextResponse.json({
      ...part,
      vendors: vendors || [],
      files: (partFiles || []).map((pf) => ({ ...pf, file: pf.file as unknown })),
      whereUsed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch part";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(
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

    const parsed = await parseBody(request, UpdatePartSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const { partId } = await params;
    const db = getServiceClient();

    const { data: existing } = await db.from("parts")
      .select("partNumber")
      .eq("id", partId)
      .eq("tenantId", tenantUser.tenantId)
      .single();
    if (!existing) {
      return NextResponse.json({ error: "Part not found" }, { status: 404 });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) updates[key] = value;
    }

    const { data: part, error } = await db.from("parts").update(updates).eq("id", partId).select().single();
    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "A part with this number already exists" }, { status: 409 });
      }
      throw error;
    }

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "part.update", entityType: "part", entityId: partId,
      details: { partNumber: part.partNumber },
    });

    return NextResponse.json(part);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update part";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
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
    const db = getServiceClient();

    const { data: existing } = await db.from("parts").select("partNumber, name").eq("id", partId).eq("tenantId", tenantUser.tenantId).single();
    if (!existing) {
      return NextResponse.json({ error: "Part not found" }, { status: 404 });
    }

    // Check if used in any BOMs
    const { count } = await db.from("bom_items").select("*", { count: "exact", head: true }).eq("partId", partId);
    if (count && count > 0) {
      return NextResponse.json({ error: `Cannot delete — part is used in ${count} BOM item(s). Remove it from all BOMs first.` }, { status: 400 });
    }

    const { error } = await db.from("parts").delete().eq("id", partId);
    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "part.delete", entityType: "part", entityId: partId,
      details: { partNumber: existing.partNumber, name: existing.name },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete part";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
