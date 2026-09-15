import { randomUUID } from "node:crypto";
import { badRequest, conflict } from "@/lib/api-route";
import { loadFile } from "@/lib/folder-access-guards";
import type { TenantUser } from "@/lib/api-route";
import type { ScopedDb } from "@/lib/tenant-db";
import { z } from "@/lib/validation";
import {
  MAX_UPLOAD_BYTES,
  assertCanAddVersion,
  confirmUploadedObject,
  createUploadTarget,
  discardUploadedObject,
  fileNameProblem,
  scheduleThumbnail,
  vaultObjectKey,
  type UploadGrant,
  type UploadTarget,
} from "@/lib/vault-uploads";

export const PrepareVersionBodySchema = z.object({
  fileName: z.string(),
  size: z.number().int().min(0).max(MAX_UPLOAD_BYTES, "Files can be at most 5 GB"),
});

/**
 * Step 1 of adding a version to an existing file, shared by check-in and
 * "upload as new version". The two differ only in the permission their route
 * declares and the checks `assertCanAddVersion` applies for the purpose.
 */
export async function prepareVersionUpload({
  db,
  tenantUser,
  permissions,
  fileId,
  body,
  purpose,
}: {
  db: ScopedDb;
  tenantUser: TenantUser;
  permissions: string[];
  fileId: string;
  body: z.infer<typeof PrepareVersionBodySchema>;
  purpose: "checkin" | "version";
}): Promise<UploadTarget> {
  const nameProblem = fileNameProblem(body.fileName);
  if (nameProblem) throw badRequest(nameProblem);

  const file = await loadFile(db, tenantUser, fileId, "edit");
  await assertCanAddVersion(file, { id: tenantUser.id, permissions }, purpose);

  return createUploadTarget(db.storage, {
    purpose,
    tenantId: tenantUser.tenantId,
    userId: tenantUser.id,
    fileId,
    folderId: null,
    key: vaultObjectKey(tenantUser.tenantId, fileId),
    name: body.fileName,
    size: body.size,
  });
}

interface VersionFile {
  id: string;
  tenantId: string;
  name: string;
  revision: string;
  currentVersion: number;
  isFrozen: boolean;
  isCheckedOut: boolean;
  checkedOutById: string | null;
}

/**
 * Step 3 of adding a version: record an uploaded object as the file's next
 * version, and release any checkout the caller held.
 *
 * Safe to retry. A commit that already landed is recognised by its storage key
 * and returns the version it created, rather than recording the same content
 * as a second version.
 *
 * The file row is only moved if it is still exactly as it was loaded — same
 * current version, same checkout. Otherwise a checkout someone took while the
 * upload ran was silently cleared, and their later check-in overwrote this
 * version (AUD-003 VLT-7). When the move does not happen, the version row just
 * written is removed again: leaving it would make every retry collide with it
 * on the unique version number, with only SQL to unstick the file.
 */
export async function commitVersionUpload({
  db,
  user,
  file,
  grant,
  purpose,
  comment,
}: {
  db: ScopedDb;
  user: { id: string; permissions: string[] };
  file: VersionFile;
  grant: UploadGrant;
  purpose: "checkin" | "version";
  comment: string | null;
}): Promise<{ version: number; alreadyRecorded: boolean }> {
  // lint-conventions-allow: child-table-direct-query — every `file_versions`
  // query in this function is by `file.id`, and the caller loaded `file`
  // through the scoped client (loadFile), so it is the caller's tenant's.
  const { data: recorded, error: recordedError } = await db
    .from("file_versions")
    .select("version")
    .eq("fileId", file.id)
    .eq("storageKey", grant.key)
    .maybeSingle();
  if (recordedError) throw new Error(recordedError.message);
  if (recorded) return { version: recorded.version as number, alreadyRecorded: true };

  try {
    await assertCanAddVersion(file, user, purpose);
    await confirmUploadedObject(db.storage, grant);
  } catch (err) {
    await discardUploadedObject(db.storage, grant.key);
    throw err;
  }

  const now = new Date().toISOString();
  const newVersion = file.currentVersion + 1;
  const versionId = randomUUID();

  const { error: versionError } = await db.from("file_versions").insert({
    id: versionId,
    fileId: file.id,
    version: newVersion,
    revision: file.revision,
    storageKey: grant.key,
    fileSize: grant.size,
    uploadedById: user.id,
    comment,
    createdAt: now,
  });
  if (versionError) {
    await discardUploadedObject(db.storage, grant.key);
    if (versionError.code === "23505") {
      throw conflict(
        `Version ${newVersion} of "${file.name}" was added by someone else while this one uploaded. Reload the file and try again.`
      );
    }
    throw new Error(`Could not record the new version: ${versionError.message}`);
  }

  let move = db
    .from("files")
    .update({
      currentVersion: newVersion,
      isCheckedOut: false,
      checkedOutById: null,
      checkedOutAt: null,
      updatedAt: now,
    })
    .eq("id", file.id)
    .eq("currentVersion", file.currentVersion)
    .eq("isCheckedOut", file.isCheckedOut);
  move = file.checkedOutById
    ? move.eq("checkedOutById", file.checkedOutById)
    : move.is("checkedOutById", null);
  const { data: moved, error: moveError } = await move.select("id");

  if (moveError || !moved || moved.length === 0) {
    const { error: undoError } = await db.from("file_versions").delete().eq("id", versionId);
    if (undoError) {
      console.error(
        `[uploads] version ${newVersion} of ${file.id} was recorded but the file did not move, and the version row could not be removed:`,
        undoError.message
      );
    } else {
      await discardUploadedObject(db.storage, grant.key);
    }
    if (moveError) throw new Error(`Could not update the file: ${moveError.message}`);
    throw conflict(
      `"${file.name}" changed while this version uploaded (it was checked out, checked in or given another version). Reload the file and try again.`
    );
  }

  scheduleThumbnail({
    tenantId: file.tenantId,
    fileId: file.id,
    version: newVersion,
    key: grant.key,
    fileName: file.name,
    size: grant.size,
  });

  return { version: newVersion, alreadyRecorded: false };
}
