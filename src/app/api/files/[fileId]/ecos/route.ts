import { withTenant, notFound } from "@/lib/api-route";
import { requireFileAccess } from "@/lib/folder-access-guards";
import { z, uuid } from "@/lib/validation";

const ParamsSchema = z.object({ fileId: uuid });

/** ECOs that have touched this file, via eco_items. */
export const GET = withTenant({ params: ParamsSchema }, async ({ db, tenantUser, params }) => {
  const { data: file } = await db
    .from("files")
    .select("id, tenantId, folderId, deletedAt")
    .eq("id", params.fileId)
    .is("deletedAt", null)
    .maybeSingle();
  if (!file) throw notFound("File not found");

  // Folder ACLs are a second gate, independent of role permissions.
  const access = await requireFileAccess(tenantUser, file, "view");
  if (!access.ok) return access.response;

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
