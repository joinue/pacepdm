import { withTenant, ApiFailure, forbidden } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { z, nonEmptyString } from "@/lib/validation";
import { getFolderAccessScope } from "@/lib/folder-access";
import {
  buildStorageZipStream,
  isCrossSiteRequest,
  planVaultZip,
  safeZipFilename,
  zipResponse,
} from "@/lib/vault-zip";

/**
 * POST /api/folders/[folderId]/download/zip
 *
 * Streams a zip of the folder and everything below it that the caller can see.
 * The browser reaches it by submitting a hidden form, so the response's
 * `Content-Disposition: attachment` becomes a download and the page stays put.
 *
 * Authorized here, at the moment the bytes go out — session, tenant and the
 * caller's folder access as of this request — and the folder's contents are
 * resolved now, not when prepare ran.
 */

// Next reads segment config statically; keep in step with ZIP_MAX_DURATION_SECONDS.
export const maxDuration = 300;

const ParamsSchema = z.object({ folderId: nonEmptyString });

export const POST = withTenant(
  { permission: PERMISSIONS.FILE_VIEW, params: ParamsSchema },
  async ({ request, db, tenantUser, params }) => {
    if (isCrossSiteRequest(request)) {
      throw forbidden("Downloads can only be started from within PACE PDM");
    }

    const plan = await planVaultZip(
      db.unscoped("planVaultZip scopes every query by the tenantId passed in"),
      tenantUser.tenantId,
      await getFolderAccessScope(tenantUser),
      { kind: "folder", folderId: params.folderId }
    );
    if (!plan.ok) throw new ApiFailure(plan.message, plan.status, plan.details);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "folder.download",
      entityType: "folder",
      entityId: params.folderId,
      details: {
        count: plan.entries.length,
        totalBytes: plan.totalBytes,
        rootName: plan.zipName,
      },
    });

    const stream = buildStorageZipStream(db, {
      entries: plan.entries,
      logLabel: `folder ${params.folderId}`,
    });
    return zipResponse(stream, safeZipFilename(plan.zipName));
  }
);
