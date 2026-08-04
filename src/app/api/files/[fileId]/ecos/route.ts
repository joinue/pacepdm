import { withTenant } from "@/lib/api-route";
import { loadFile } from "@/lib/folder-access-guards";
import { z, uuid } from "@/lib/validation";

const ParamsSchema = z.object({ fileId: uuid });

/**
 * ECOs that have touched this file, via eco_items.
 *
 * `loadFile` carries both guards origin/main added here: the soft-delete
 * exclusion (a deleted file must not be readable through any route except
 * `restore`) and the folder ACL check, on top of the tenant filter the
 * scoped client applies.
 */
export const GET = withTenant({ params: ParamsSchema }, async ({ db, tenantUser, params }) => {
  await loadFile(db, tenantUser, params.fileId, "view", "id, tenantId, folderId, deletedAt");

  // lint-conventions-allow: child-table-direct-query — keyed on the file
  // resolved through the scoped client above, so it cannot reach another
  // tenant's eco_items.
  const { data: ecoItems } = await db
    .from("eco_items")
    .select(
      "id, changeType, reason, eco:ecos!eco_items_ecoId_fkey(id, ecoNumber, title, status, priority)"
    )
    .eq("fileId", params.fileId);

  // A null `eco` means the joined row resolved to nothing — drop those rather
  // than rendering an empty linkage.
  return (ecoItems || []).filter((item: { eco: unknown }) => item.eco !== null);
});
