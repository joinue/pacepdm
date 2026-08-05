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
 * BOM thumbnail. A dedicated endpoint rather than a field on `PUT /api/boms/[id]`
 * because the write is multipart and the storage object has its own lifecycle —
 * the same split the parts and files modules already use.
 *
 * Shared rules (size, mime, key layout, signing) live in `src/lib/thumbnails.ts`.
 */

const ParamsSchema = z.object({ bomId: uuid });

export const POST = withTenant(
  { permission: PERMISSIONS.FILE_EDIT, params: ParamsSchema },
  async ({ db, tenantUser, params, request }) => {
    const { data: bom } = await db
      .from("boms")
      .select("id, name, thumbnailKey")
      .eq("id", params.bomId)
      .is("deletedAt", null)
      .maybeSingle();
    if (!bom) throw notFound("BOM not found");

    // Validate before uploading: a rejected image should never reach storage.
    const file = await readThumbnailUpload(request);

    const key = await storeThumbnail({
      storage: db.storage,
      tenantId: tenantUser.tenantId,
      entity: "boms",
      entityId: bom.id,
      file,
      previousKey: bom.thumbnailKey,
    });

    const { error } = await db
      .from("boms")
      .update({ thumbnailKey: key, updatedAt: new Date().toISOString() })
      .eq("id", bom.id);
    if (error) {
      // The row still points at the old key, so the object we just wrote is
      // unreachable. Clean it up rather than leaving it to accumulate.
      await removeThumbnail(db.storage, key);
      throw new Error(error.message);
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "bom.thumbnail.update",
      entityType: "bom",
      entityId: bom.id,
      details: { name: bom.name },
    });

    return { thumbnailUrl: await signThumbnailUrl(db.storage, key) };
  }
);

export const DELETE = withTenant(
  { permission: PERMISSIONS.FILE_EDIT, params: ParamsSchema },
  async ({ db, tenantUser, params }) => {
    const { data: bom } = await db
      .from("boms")
      .select("id, name, thumbnailKey")
      .eq("id", params.bomId)
      .is("deletedAt", null)
      .maybeSingle();
    if (!bom) throw notFound("BOM not found");

    const { error } = await db
      .from("boms")
      .update({ thumbnailKey: null, updatedAt: new Date().toISOString() })
      .eq("id", bom.id);
    if (error) throw new Error(error.message);

    // Only after the row is clear: an object removed while the row still
    // referenced it would render as a broken image.
    await removeThumbnail(db.storage, bom.thumbnailKey);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "bom.thumbnail.delete",
      entityType: "bom",
      entityId: bom.id,
      details: { name: bom.name },
    });

    return { thumbnailUrl: null };
  }
);
