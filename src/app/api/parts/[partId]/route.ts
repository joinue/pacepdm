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

    // Fetch vendors, files, where-used, and ECO history in parallel.
    // ECO history comes from `eco_items` rows linked to this part (added in
    // migration-017) joined to the parent ECO — one row per time the part
    // was touched by an ECO, in reverse chronological order.
    const [{ data: vendors }, { data: partFiles }, { data: bomItems }, { data: ecoItems }] = await Promise.all([
      // Join the canonical vendors row so we get a stable name even if the
      // legacy `vendorName` text column is later dropped. Order by isPrimary
      // first so the primary vendor lands at index 0.
      db.from("part_vendors")
        .select("*, vendor:vendors!part_vendors_vendorId_fkey(id, name, website, contactName, contactEmail, contactPhone)")
        .eq("partId", partId)
        .order("isPrimary", { ascending: false }),
      db.from("part_files").select("*, file:files!part_files_fileId_fkey(id, name, partNumber, revision, lifecycleState, fileType)").eq("partId", partId),
      db.from("bom_items").select("id, itemNumber, name, quantity, unit, bomId, bom:boms!bom_items_bomId_fkey(id, name, revision, status, tenantId)").eq("partId", partId),
      db.from("eco_items")
        .select("id, fromRevision, toRevision, eco:ecos!eco_items_ecoId_fkey(id, ecoNumber, title, status, implementedAt, createdAt, tenantId)")
        .eq("partId", partId),
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

    // Shape ECO history. Filter cross-tenant rows defensively even though
    // eco_items is already tenant-scoped via its parent ECO. Sort by
    // implementedAt desc (nulls last) so in-flight ECOs float to the top.
    const ecoHistory = (ecoItems || [])
      .map((row) => {
        const eco = row.eco as unknown as {
          id: string; ecoNumber: string; title: string; status: string;
          implementedAt: string | null; createdAt: string; tenantId: string;
        } | null;
        if (!eco || eco.tenantId !== tenantUser.tenantId) return null;
        return {
          ecoId: eco.id,
          ecoNumber: eco.ecoNumber,
          title: eco.title,
          status: eco.status,
          implementedAt: eco.implementedAt,
          createdAt: eco.createdAt,
          fromRevision: row.fromRevision as string | null,
          toRevision: row.toRevision as string | null,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => {
        const aT = a.implementedAt ?? a.createdAt;
        const bT = b.implementedAt ?? b.createdAt;
        return bT.localeCompare(aT);
      });

    // Resolve the storage key into a short-lived signed URL so the
    // frontend can continue to read `thumbnailUrl` directly. Mirrors
    // the files module's pattern.
    let thumbnailUrl: string | null = null;
    const thumbKey = (part as { thumbnailKey: string | null }).thumbnailKey;
    if (thumbKey) {
      const { data: signed } = await db.storage.from("vault").createSignedUrl(thumbKey, 300);
      thumbnailUrl = signed?.signedUrl || null;
    }

    return NextResponse.json({
      ...part,
      thumbnailUrl,
      vendors: vendors || [],
      files: (partFiles || []).map((pf) => ({ ...pf, file: pf.file as unknown })),
      whereUsed,
      ecoHistory,
    });
  } catch (err) {
    console.error("Failed to fetch part:", err);
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
    console.error("Failed to update part:", err);
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
    console.error("Failed to delete part:", err);
    const message = err instanceof Error ? err.message : "Failed to delete part";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
