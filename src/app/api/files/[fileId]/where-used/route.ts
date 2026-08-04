import { withTenant } from "@/lib/api-route";
import { loadFile } from "@/lib/folder-access-guards";
import { getFileWhereUsed } from "@/lib/where-used";
import { z, uuid } from "@/lib/validation";

/**
 * GET /api/files/[fileId]/where-used
 *
 * Returns a unified where-used payload for a file:
 *
 *   - `boms`           — BOMs that reference this file as a line item
 *   - `representsBoms` — BOMs where boms.fileId = this file (i.e. this
 *                        file IS the assembly drawing/document the BOM
 *                        is attached to)
 *   - `linkedParts`    — parts that have this file attached via part_files
 *   - `ecos`           — ECOs that have touched this file via eco_items
 *
 * `loadFile` applies the tenant filter, the soft-delete exclusion, and the
 * folder ACL check. Role permission alone is not enough: folder ACLs are an
 * independent second gate. The heavy lifting lives in `lib/where-used.ts`.
 */

const ParamsSchema = z.object({ fileId: uuid });

export const GET = withTenant({ params: ParamsSchema }, async ({ db, tenantUser, params }) => {
  await loadFile(db, tenantUser, params.fileId, "view", "id, tenantId, folderId, deletedAt");

  return getFileWhereUsed(
    db.unscoped("where-used takes a raw client and filters every joined row by the tenantId given"),
    tenantUser.tenantId,
    params.fileId
  );
});
