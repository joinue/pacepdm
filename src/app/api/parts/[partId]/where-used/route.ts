import { withTenant, notFound } from "@/lib/api-route";
import { getPartWhereUsed } from "@/lib/where-used";
import { z, uuid } from "@/lib/validation";

/**
 * GET /api/parts/[partId]/where-used
 *
 * Returns a unified where-used payload for a part:
 *
 *   - `boms`          — BOMs that list this part as a line item
 *   - `parentParts`   — transitive assembly parents, discovered by
 *                       walking bom_items → boms.fileId → part_files
 *   - `linkedFiles`   — files attached to the part (part_files)
 *   - `ecos`          — ECOs that have touched the part (eco_items)
 *
 * Read-only. The part lookup exists to return a clean 404 rather than
 * leaking a tenant mismatch as a confusingly empty result.
 */

const ParamsSchema = z.object({ partId: uuid });

export const GET = withTenant({ params: ParamsSchema }, async ({ db, tenantUser, params }) => {
  const { data: part } = await db
    .from("parts")
    .select("id")
    .eq("id", params.partId)
    .is("deletedAt", null)
    .maybeSingle();
  if (!part) throw notFound("Part not found");

  return getPartWhereUsed(
    db.unscoped("where-used takes a raw client and filters every joined row by the tenantId given"),
    tenantUser.tenantId,
    params.partId
  );
});
