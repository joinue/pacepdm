import { withTenant, notFound } from "@/lib/api-route";
import { requireFileAccess } from "@/lib/folder-access-guards";
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
 * Role permissions are not enough here: folder ACLs are a second, independent
 * gate, so the file is re-checked through `requireFileAccess`. The heavy
 * lifting lives in `lib/where-used.ts`.
 */

const ParamsSchema = z.object({ fileId: uuid });

export const GET = withTenant({ params: ParamsSchema }, async ({ db, tenantUser, params }) => {
  const { data: file } = await db
    .from("files")
    .select("id, tenantId, folderId, deletedAt")
    .eq("id", params.fileId)
    .is("deletedAt", null)
    .maybeSingle();
  if (!file) throw notFound("File not found");

  const access = await requireFileAccess(tenantUser, file, "view");
  if (!access.ok) return access.response;

  return getFileWhereUsed(
    db.unscoped("where-used takes a raw client and filters every joined row by the tenantId given"),
    tenantUser.tenantId,
    params.fileId
  );
});
