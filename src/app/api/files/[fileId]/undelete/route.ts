import { withTenant, conflict } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { loadDeletedFile } from "@/lib/folder-access-guards";
import { z, uuid } from "@/lib/validation";

/**
 * POST /api/files/[fileId]/undelete
 *
 * Restores a soft-deleted file. Delete has always been soft (migration 036
 * added `deletedAt`; the delete route stamps it and leaves the storage blob
 * and every `file_versions` row untouched), so this is a metadata-only
 * update — there is nothing to re-upload.
 *
 * Not to be confused with `POST /api/files/[fileId]/restore`, which rolls a
 * live file back to an earlier *version* and explicitly 404s on a deleted
 * file. Two different operations that both mean "restore" in English; this
 * is the one that brings a file back from the trash.
 *
 * Gated on FILE_DELETE rather than a new permission: whoever can move a file
 * to the trash can take it back out, and a role that can delete but not
 * undelete would be strictly worse for the user and no safer.
 */

const ParamsSchema = z.object({ fileId: uuid });

export const POST = withTenant(
  { permission: PERMISSIONS.FILE_DELETE, params: ParamsSchema },
  async ({ db, tenantUser, params }) => {
    const file = await loadDeletedFile(db, tenantUser, params.fileId);

    // The unique index on (tenantId, folderId, name) became partial on
    // `deletedAt IS NULL` in migration 042, so a name freed by deletion can
    // be taken by a new file. When it has been, refuse with a message that
    // names the blocker: silently restoring under `bracket (restored).sldprt`
    // would produce a file whose name no longer matches the drawing, the BOM
    // line, or what the engineer is looking for.
    const { data: nameHolder } = await db
      .from("files")
      .select("id, name")
      .eq("folderId", file.folderId)
      .eq("name", file.name)
      .is("deletedAt", null)
      .maybeSingle();

    if (nameHolder) {
      throw conflict(
        `Another file named "${file.name}" now exists in this folder. ` +
          `Rename or move it, then restore this file again.`,
        { blockingFileId: nameHolder.id }
      );
    }

    const now = new Date().toISOString();
    const { data: restored, error } = await db
      .from("files")
      .update({ deletedAt: null, deletedById: null, updatedAt: now })
      .eq("id", params.fileId)
      .select()
      .single();

    // A 23505 here means another restore of a same-named sibling won the race
    // between the check above and this update. Same user-facing answer.
    if (error) {
      if (error.code === "23505") {
        throw conflict(
          `Another file named "${file.name}" now exists in this folder. ` +
            `Rename or move it, then restore this file again.`
        );
      }
      throw new Error(error.message);
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.undelete",
      entityType: "file",
      entityId: params.fileId,
      details: { name: file.name, deletedAt: file.deletedAt },
    });

    return restored;
  }
);
