import { withTenant, notFound } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { z, uuid } from "@/lib/validation";
import { buildPartPackage } from "@/lib/part-package";

/**
 * GET /api/parts/[partId]/package
 *
 * What a supplier would receive if this part were shared right now.
 *
 * Exists so the share dialog can tell the internal user *before* they
 * send a link that, say, two of the four attached drawings are still WIP
 * and therefore not in the package. Without it the omission is silent,
 * and silent omission is the failure this whole feature exists to
 * replace — sourcing believing they sent a complete set.
 *
 * Storage keys and signed URLs are stripped: this is a summary for the
 * dialog, not a download. The zip route is what serves bytes.
 */

const ParamsSchema = z.object({ partId: uuid });

// The dialog previews both sides of the toggle, so it asks for whichever
// the user currently has selected. `z.coerce.boolean()` is wrong here — it
// treats the string "false" as true — so the check is explicit.
const QuerySchema = z.object({
  includeWip: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

export const GET = withTenant(
  { permission: PERMISSIONS.FILE_VIEW, params: ParamsSchema, query: QuerySchema },
  async ({ db, tenantUser, params, query }) => {
    const pkg = await buildPartPackage(
      db.unscoped("buildPartPackage takes a raw client and scopes by the tenantId passed in"),
      tenantUser.tenantId,
      params.partId,
      { includeWip: query.includeWip }
    );
    if (!pkg) throw notFound("Part not found");

    return {
      partNumber: pkg.partNumber,
      name: pkg.name,
      revision: pkg.revision,
      lifecycleState: pkg.lifecycleState,
      files: pkg.files.map((f) => ({
        fileName: f.fileName,
        fileType: f.fileType,
        role: f.role,
        isPrimary: f.isPrimary,
        revision: f.revision,
        version: f.version,
        isPreliminary: f.isPreliminary,
        lifecycleState: f.lifecycleState,
      })),
      boms: pkg.boms,
      filesWithheld: pkg.filesWithheld,
      preliminaryCount: pkg.preliminaryCount,
    };
  }
);
