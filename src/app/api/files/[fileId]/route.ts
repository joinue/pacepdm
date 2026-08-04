import { withTenant } from "@/lib/api-route";
import { loadFile } from "@/lib/folder-access-guards";
import { z, uuid } from "@/lib/validation";

const ParamsSchema = z.object({ fileId: uuid });

export const GET = withTenant({ params: ParamsSchema }, async ({ db, tenantUser, params }) => {
  const file = await loadFile(
    db,
    tenantUser,
    params.fileId,
    "view",
    `
      *,
      folder:folders!files_folderId_fkey(name, path),
      checkedOutBy:tenant_users!files_checkedOutById_fkey(fullName, email)
    `
  );

  // lint-conventions-allow: child-table-direct-query — both are keyed on the
  // file resolved through the scoped client above, which 404s on another
  // tenant's id before we get here.
  const [{ data: versions }, { data: metadata }] = await Promise.all([
    db
      .from("file_versions")
      .select("*, uploadedBy:tenant_users!file_versions_uploadedById_fkey(fullName)")
      .eq("fileId", params.fileId)
      .order("version", { ascending: false }),
    db
      .from("metadata_values")
      .select("*, field:metadata_fields!metadata_values_fieldId_fkey(*)")
      .eq("fileId", params.fileId),
  ]);

  return { ...file, versions: versions || [], metadata: metadata || [] };
});
