import { withTenant, ApiFailure } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { z, nonEmptyString } from "@/lib/validation";
import { getFolderAccessScope } from "@/lib/folder-access";
import { planVaultZip } from "@/lib/vault-zip";

/**
 * POST /api/folders/[folderId]/download/prepare
 *
 * Checks a folder download before the browser commits to it, so a forbidden,
 * empty or oversized folder becomes a toast with a reason. The download itself
 * is a form POST to /api/folders/[folderId]/download/zip, which plans it again
 * under the caller's access at that moment.
 */

const ParamsSchema = z.object({ folderId: nonEmptyString });

export const POST = withTenant(
  { permission: PERMISSIONS.FILE_VIEW, params: ParamsSchema },
  async ({ db, tenantUser, params }) => {
    const plan = await planVaultZip(
      db.unscoped("planVaultZip scopes every query by the tenantId passed in"),
      tenantUser.tenantId,
      await getFolderAccessScope(tenantUser),
      { kind: "folder", folderId: params.folderId }
    );
    if (!plan.ok) throw new ApiFailure(plan.message, plan.status, plan.details);

    return {
      count: plan.entries.length,
      totalBytes: plan.totalBytes,
      rootName: plan.zipName,
    };
  }
);
