import { randomUUID } from "node:crypto";
import { withTenant, badRequest, conflict, forbidden, notFound } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { canEditFolder, canViewFolder, getFolderAccessScope } from "@/lib/folder-access";
import { z, nonEmptyString } from "@/lib/validation";
import {
  MAX_UPLOAD_BYTES,
  createUploadTarget,
  fileNameProblem,
  vaultObjectKey,
} from "@/lib/vault-uploads";

const BodySchema = z.object({
  folderId: nonEmptyString,
  fileName: z.string(),
  size: z.number().int().min(0).max(MAX_UPLOAD_BYTES, "Files can be at most 5 GB"),
});

/**
 * Step 1 of uploading a new file: check everything that can be checked before
 * any bytes move, then hand back a signed storage URL and an upload grant.
 * The browser uploads to storage directly and commits with POST /api/files.
 * See lib/vault-uploads.ts.
 *
 * The duplicate-name check happens here, so the "upload as a new version?"
 * prompt appears before a large file has been sent anywhere.
 */
export const POST = withTenant(
  { permission: PERMISSIONS.FILE_UPLOAD, body: BodySchema },
  async ({ db, tenantUser, body }) => {
    const nameProblem = fileNameProblem(body.fileName);
    if (nameProblem) throw badRequest(nameProblem);

    const { data: folder } = await db
      .from("folders")
      .select("id")
      .eq("id", body.folderId)
      .maybeSingle();
    if (!folder) throw notFound("Folder not found");

    // "Can't see it" and "can see but can't write" are told apart: a user who
    // navigated into the folder already knows it exists.
    const scope = await getFolderAccessScope(tenantUser);
    if (!canViewFolder(scope, body.folderId)) throw notFound("Folder not found");
    if (!canEditFolder(scope, body.folderId)) throw forbidden();

    const { data: existingFile } = await db
      .from("files")
      .select("id, name, currentVersion, isCheckedOut, checkedOutById, isFrozen, lifecycleState")
      .is("deletedAt", null)
      .eq("folderId", body.folderId)
      .eq("name", body.fileName)
      .maybeSingle();
    if (existingFile) {
      throw conflict("A file with this name already exists in this folder", {
        code: "DUPLICATE_FILE",
        existingFile,
      });
    }

    const fileId = randomUUID();
    return createUploadTarget(db.storage, {
      purpose: "new",
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      fileId,
      folderId: body.folderId,
      key: vaultObjectKey(tenantUser.tenantId, fileId),
      name: body.fileName,
      size: body.size,
    });
  }
);
