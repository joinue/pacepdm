import { withTenant, conflict } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";
import { z, optionalString } from "@/lib/validation";
import { signThumbnailUrls, withThumbnailUrl } from "@/lib/thumbnails";
import { normalizeVendorName } from "@/lib/vendors";

const ListQuerySchema = z.object({
  q: z.string().optional(),
  withCounts: z.string().optional(),
});

const CreateVendorSchema = z.object({
  name: z.string().trim().min(1, "Vendor name is required"),
  website: optionalString,
  contactName: optionalString,
  contactEmail: optionalString,
  contactPhone: optionalString,
  notes: optionalString,
});

export const GET = withTenant({ query: ListQuerySchema }, async ({ db, query }) => {
  let vendorQuery = db.from("vendors").select("*").order("name");

  if (query.q) {
    // ilike handles case-insensitive partial match — picker uses this
    vendorQuery = vendorQuery.ilike("name", `%${query.q}%`);
  }

  const { data: vendorRows } = await vendorQuery.limit(200);
  const rows = (vendorRows || []) as Array<{ id: string; thumbnailKey?: string | null }>;

  // Logos are signed for the whole page in one pass — the list renders one per
  // row and the picker shows them inline.
  const thumbUrls = await signThumbnailUrls(
    db.storage,
    rows.map((v) => v.thumbnailKey)
  );
  const vendors = rows.map((v) => withThumbnailUrl(v, thumbUrls));

  // For the vendors list page we want a "used by N parts" badge. Doing this
  // as a second query (one in() call) is cheaper than a join because the
  // vendors page rarely has thousands of rows.
  if (query.withCounts === "1" && vendors.length > 0) {
    const ids = vendors.map((v) => v.id);
    // lint-conventions-allow: child-table-direct-query — `ids` come from the scoped
    // vendor query above, never from the request, so this cannot reach another tenant.
    const { data: links } = await db.from("part_vendors").select("vendorId").in("vendorId", ids);
    const counts = new Map<string, number>();
    for (const row of links || []) {
      counts.set(row.vendorId, (counts.get(row.vendorId) || 0) + 1);
    }
    return vendors.map((v) => ({ ...v, partCount: counts.get(v.id) || 0 }));
  }

  return vendors;
});

export const POST = withTenant(
  { permission: PERMISSIONS.FILE_EDIT, body: CreateVendorSchema },
  async ({ db, tenantUser, body }) => {
    const name = normalizeVendorName(body.name);
    const now = new Date().toISOString();

    // Idempotent create: if a vendor with this canonical name already exists
    // for the tenant, return it instead of erroring. This makes the inline
    // "create new vendor" flow on the part-detail picker safe to retry.
    const { data: existing } = await db
      .from("vendors")
      .select("*")
      .ilike("name", name)
      .maybeSingle();

    if (existing) return existing;

    const { data: vendor, error } = await db
      .from("vendors")
      .insert({
        id: uuid(),
        name,
        website: body.website ?? null,
        contactName: body.contactName ?? null,
        contactEmail: body.contactEmail ?? null,
        contactPhone: body.contactPhone ?? null,
        notes: body.notes ?? null,
        createdAt: now,
        updatedAt: now,
      })
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
      action: "vendor.create",
      entityType: "vendor",
      entityId: vendor.id,
      details: { name: vendor.name },
    });

    return vendor;
  }
);
