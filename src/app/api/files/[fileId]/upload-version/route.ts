import { withTenant } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { loadFile } from "@/lib/folder-access-guards";
import { z, uuid, nonEmptyString } from "@/lib/validation";
import { readUploadGrant } from "@/lib/vault-uploads";
import { commitVersionUpload } from "@/lib/vault-version-upload";

const BodySchema = z.object({
  /** From POST /api/files/[fileId]/upload-version/upload. */
  uploadToken: nonEmptyString,
  comment: z.string().max(5000).nullable().optional(),
});

/**
 * "Upload as new version" — checkout and check-in in one step, so the file is
 * never left checked out. Used by the upload dialog when a file of the same
 * name already exists.
 */
export const POST = withTenant(
  { permission: PERMISSIONS.FILE_UPLOAD, params: z.object({ fileId: uuid }), body: BodySchema },
  async ({ db, tenantUser, permissions, params, body }) => {
    const file = await loadFile(db, tenantUser, params.fileId, "edit");
    const grant = readUploadGrant(body.uploadToken, {
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      purpose: "version",
      fileId: params.fileId,
    });

    const result = await commitVersionUpload({
      db,
      user: { id: tenantUser.id, permissions },
      file,
      grant,
      purpose: "version",
      comment: body.comment?.trim() || "New version uploaded (replaced duplicate)",
    });

    if (!result.alreadyRecorded) {
      await logAudit({
        tenantId: tenantUser.tenantId,
        userId: tenantUser.id,
        action: "file.upload_version",
        entityType: "file",
        entityId: params.fileId,
        details: { name: file.name, version: result.version, size: grant.size },
      });
    }

    return { success: true, version: result.version };
  }
);
