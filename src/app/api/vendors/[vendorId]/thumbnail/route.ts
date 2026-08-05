import { withTenant, notFound } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { z, uuid } from "@/lib/validation";
import {
  readThumbnailUpload,
  removeThumbnail,
  signThumbnailUrl,
  storeThumbnail,
} from "@/lib/thumbnails";

/**
 * Vendor logo. Same contract as the BOM and part thumbnail endpoints — see
 * `src/lib/thumbnails.ts` for the shared rules.
 */

const ParamsSchema = z.object({ vendorId: uuid });

export const POST = withTenant(
  { permission: PERMISSIONS.FILE_EDIT, params: ParamsSchema },
  async ({ db, tenantUser, params, request }) => {
    const { data: vendor } = await db
      .from("vendors")
      .select("id, name, thumbnailKey")
      .eq("id", params.vendorId)
      .maybeSingle();
    if (!vendor) throw notFound("Vendor not found");

    const file = await readThumbnailUpload(request);

    const key = await storeThumbnail({
      storage: db.storage,
      tenantId: tenantUser.tenantId,
      entity: "vendors",
      entityId: vendor.id,
      file,
      previousKey: vendor.thumbnailKey,
    });

    const { error } = await db
      .from("vendors")
      .update({ thumbnailKey: key, updatedAt: new Date().toISOString() })
      .eq("id", vendor.id);
    if (error) {
      await removeThumbnail(db.storage, key);
      throw new Error(error.message);
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "vendor.thumbnail.update",
      entityType: "vendor",
      entityId: vendor.id,
      details: { name: vendor.name },
    });

    return { thumbnailUrl: await signThumbnailUrl(db.storage, key) };
  }
);

export const DELETE = withTenant(
  { permission: PERMISSIONS.FILE_EDIT, params: ParamsSchema },
  async ({ db, tenantUser, params }) => {
    const { data: vendor } = await db
      .from("vendors")
      .select("id, name, thumbnailKey")
      .eq("id", params.vendorId)
      .maybeSingle();
    if (!vendor) throw notFound("Vendor not found");

    const { error } = await db
      .from("vendors")
      .update({ thumbnailKey: null, updatedAt: new Date().toISOString() })
      .eq("id", vendor.id);
    if (error) throw new Error(error.message);

    await removeThumbnail(db.storage, vendor.thumbnailKey);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "vendor.thumbnail.delete",
      entityType: "vendor",
      entityId: vendor.id,
      details: { name: vendor.name },
    });

    return { thumbnailUrl: null };
  }
);
