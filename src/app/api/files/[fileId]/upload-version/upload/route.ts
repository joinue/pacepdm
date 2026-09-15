import { withTenant } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { z, uuid } from "@/lib/validation";
import { PrepareVersionBodySchema, prepareVersionUpload } from "@/lib/vault-version-upload";

/**
 * Step 1 of "upload as new version": refuse early if the new version would be
 * refused, then hand back a signed storage URL. Commit with
 * POST /api/files/[fileId]/upload-version. See lib/vault-uploads.ts.
 */
export const POST = withTenant(
  {
    permission: PERMISSIONS.FILE_UPLOAD,
    params: z.object({ fileId: uuid }),
    body: PrepareVersionBodySchema,
  },
  async ({ db, tenantUser, permissions, params, body }) =>
    prepareVersionUpload({
      db,
      tenantUser,
      permissions,
      fileId: params.fileId,
      body,
      purpose: "version",
    })
);
