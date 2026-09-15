import { withTenant, ApiFailure } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { z, nonEmptyString } from "@/lib/validation";
import { getFolderAccessScope } from "@/lib/folder-access";
import { planVaultZip } from "@/lib/vault-zip";

/**
 * POST /api/files/bulk-download/prepare
 *
 * Checks a selection before the browser commits to downloading it, so an empty,
 * forbidden or oversized selection becomes a toast with a reason instead of a
 * failed download. Answers with what the zip will hold; the download itself is
 * a form POST of the same selection to /api/files/bulk-download/zip, which
 * plans it again under the caller's access at that moment.
 */

const PrepareSchema = z.object({
  fileIds: z.array(nonEmptyString).min(1, "No files specified"),
});

export const POST = withTenant(
  { permission: PERMISSIONS.FILE_VIEW, body: PrepareSchema },
  async ({ db, tenantUser, body }) => {
    const plan = await planVaultZip(
      db.unscoped("planVaultZip scopes every query by the tenantId passed in"),
      tenantUser.tenantId,
      await getFolderAccessScope(tenantUser),
      { kind: "files", fileIds: body.fileIds }
    );
    if (!plan.ok) throw new ApiFailure(plan.message, plan.status, plan.details);

    return { count: plan.entries.length, totalBytes: plan.totalBytes, skipped: plan.skipped };
  }
);
