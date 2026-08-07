import { withTenant, badRequest, conflict, notFound } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { z, optionalString, uuid } from "@/lib/validation";
import { attachThumbnailUrl } from "@/lib/thumbnails";
import { normalizeVendorName } from "@/lib/vendors";

const UpdateVendorSchema = z
  .object({
    name: z.string().optional(),
    website: optionalString,
    contactName: optionalString,
    contactEmail: optionalString,
    contactPhone: optionalString,
    notes: optionalString,
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No changes specified" });

const ParamsSchema = z.object({ vendorId: uuid });

export const GET = withTenant({ params: ParamsSchema }, async ({ db, tenantUser, params }) => {
  const { data: vendor } = await db
    .from("vendors")
    .select("*")
    .eq("id", params.vendorId)
    .maybeSingle();

  if (!vendor) throw notFound("Vendor not found");

  // Surface where this vendor is used so the detail view can show context.
  // part_vendors has no tenantId of its own; it is reached here only after
  // the vendor above resolved through the scoped client, and the joined
  // part's tenant is re-checked below as defense in depth.
  const { data: links } = await db
    .from("part_vendors")
    .select(
      "id, partId, vendorPartNumber, unitCost, currency, leadTimeDays, isPrimary, part:parts!part_vendors_partId_fkey(id, partNumber, name, tenantId)"
    )
    .eq("vendorId", params.vendorId);

  const usedBy = (links || []).filter((row: { part: unknown }) => {
    const part = row.part as { tenantId: string } | null;
    return part && part.tenantId === tenantUser.tenantId;
  });

  return { ...(await attachThumbnailUrl(db.storage, vendor)), usedBy };
});

export const PUT = withTenant(
  { permission: PERMISSIONS.FILE_EDIT, body: UpdateVendorSchema, params: ParamsSchema },
  async ({ db, tenantUser, params, body }) => {
    const { data: existing } = await db
      .from("vendors")
      .select("name")
      .eq("id", params.vendorId)
      .maybeSingle();
    if (!existing) throw notFound("Vendor not found");

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };

    if (body.name !== undefined) {
      const name = normalizeVendorName(body.name);
      if (!name) throw badRequest("Vendor name cannot be empty");
      updates.name = name;
    }
    for (const field of [
      "website",
      "contactName",
      "contactEmail",
      "contactPhone",
      "notes",
    ] as const) {
      if (body[field] !== undefined) updates[field] = body[field] ?? null;
    }

    const { data: vendor, error } = await db
      .from("vendors")
      .update(updates)
      .eq("id", params.vendorId)
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        throw conflict("A vendor with this name already exists");
      }
      throw new Error(error.message);
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "vendor.update",
      entityType: "vendor",
      entityId: params.vendorId,
      details: { name: vendor.name },
    });

    return vendor;
  }
);

export const DELETE = withTenant(
  { permission: PERMISSIONS.FILE_EDIT, params: ParamsSchema },
  async ({ db, tenantUser, params }) => {
    const { data: existing } = await db
      .from("vendors")
      .select("name")
      .eq("id", params.vendorId)
      .maybeSingle();
    if (!existing) throw notFound("Vendor not found");

    // Prevent orphaning part_vendors rows. The DB FK is ON DELETE RESTRICT
    // and will refuse the delete, but we check first to return a friendly
    // error message instead of a generic constraint violation.
    const { count } = await db
      .from("part_vendors")
      .select("*", { count: "exact", head: true })
      .eq("vendorId", params.vendorId);
    if (count && count > 0) {
      throw badRequest(
        `Cannot delete — vendor is linked to ${count} part(s). Remove from all parts first.`
      );
    }

    const { error } = await db.from("vendors").delete().eq("id", params.vendorId);
    if (error) throw new Error(error.message);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "vendor.delete",
      entityType: "vendor",
      entityId: params.vendorId,
      details: { name: existing.name },
    });

    return { success: true };
  }
);
