import { withTenant } from "@/lib/api-route";
import { loadFile } from "@/lib/folder-access-guards";
import { z, uuid } from "@/lib/validation";

/**
 * GET /api/files/[fileId]/revisions
 *
 * Returns the file's full version history joined with the ECO that
 * released each version (if any). Used by the file detail panel to
 * answer "this file is at revision C — which ECO bumped it from B?"
 *
 * Each row corresponds to one `file_versions` record. `eco` is null
 * for versions that were never linked to an ECO (initial uploads,
 * informal check-ins, pre-traceability rows).
 */

const ParamsSchema = z.object({ fileId: uuid });

export const GET = withTenant({ params: ParamsSchema }, async ({ db, tenantUser, params }) => {
  // file_versions has no tenantId of its own, so scope runs through the parent
  // file — resolved here on the scoped client before the child query.
  await loadFile(db, tenantUser, params.fileId, "view", "id, tenantId, folderId, deletedAt");

  // lint-conventions-allow: child-table-direct-query — keyed on the file
  // resolved immediately above, which 404s on another tenant's id.
  const { data: versions } = await db
    .from("file_versions")
    .select(
      `
        id,
        version,
        revision,
        fileSize,
        comment,
        createdAt,
        ecoId,
        uploadedBy:tenant_users!file_versions_uploadedById_fkey(fullName),
        eco:ecos!file_versions_ecoId_fkey(id, ecoNumber, title, status)
      `
    )
    .eq("fileId", params.fileId)
    .order("version", { ascending: false });

  return versions || [];
});
