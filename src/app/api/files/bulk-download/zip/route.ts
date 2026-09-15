import { withTenant, ApiFailure, badRequest, forbidden } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { z, nonEmptyString, formatZodError } from "@/lib/validation";
import { getFolderAccessScope } from "@/lib/folder-access";
import {
  buildStorageZipStream,
  isCrossSiteRequest,
  planVaultZip,
  safeZipFilename,
  zipResponse,
} from "@/lib/vault-zip";

/**
 * POST /api/files/bulk-download/zip
 *
 * Streams a zip of the selected files. The browser reaches it by submitting a
 * hidden form — one `fileId` field per file — so the selection travels in the
 * body and the URL never grows with it. `Content-Disposition: attachment`
 * turns the form navigation into a download, and the page stays where it is.
 *
 * Authorized here, at the moment the bytes go out: the session, the tenant and
 * the caller's folder access as of this request. Nothing from the prepare step
 * is trusted, so access revoked in between is honored.
 */

// Next reads segment config statically; keep in step with ZIP_MAX_DURATION_SECONDS.
export const maxDuration = 300;

const FormSchema = z.object({
  fileIds: z.array(nonEmptyString).min(1, "No files specified"),
});

export const POST = withTenant(
  { permission: PERMISSIONS.FILE_VIEW },
  async ({ request, db, tenantUser }) => {
    if (isCrossSiteRequest(request)) {
      throw forbidden("Downloads can only be started from within PACE PDM");
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw badRequest("Expected a form submission");
    }
    const parsed = FormSchema.safeParse({ fileIds: form.getAll("fileId") });
    if (!parsed.success) throw badRequest("Validation failed", formatZodError(parsed.error));

    const plan = await planVaultZip(
      db.unscoped("planVaultZip scopes every query by the tenantId passed in"),
      tenantUser.tenantId,
      await getFolderAccessScope(tenantUser),
      { kind: "files", fileIds: parsed.data.fileIds }
    );
    if (!plan.ok) throw new ApiFailure(plan.message, plan.status, plan.details);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.bulk_download",
      entityType: "file",
      entityId: parsed.data.fileIds.slice(0, 20).join(","),
      details: { count: plan.entries.length, totalBytes: plan.totalBytes },
    });

    const stream = buildStorageZipStream(db, {
      entries: plan.entries,
      logLabel: `bulk download by user ${tenantUser.id}`,
    });
    return zipResponse(stream, safeZipFilename(plan.zipName));
  }
);
