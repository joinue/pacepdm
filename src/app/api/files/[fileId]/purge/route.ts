import { withTenant, conflict } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { loadDeletedFile } from "@/lib/folder-access-guards";
import { z, uuid } from "@/lib/validation";

/**
 * DELETE /api/files/[fileId]/purge
 *
 * Destroys a file in the trash for good: every `file_versions` row, every
 * stored blob, and the `files` row itself. There is no undo, and nothing else
 * in this application is as destructive.
 *
 * It exists because the trash is never emptied on a timer
 * (docs/decisions/retention-and-formats.md). Nothing purges automatically and
 * nothing ever will, so the only way storage is ever reclaimed is somebody
 * deciding, about one named file, that it should not exist. That is the shape
 * this route enforces: one file, by id, by a holder of FILE_PURGE.
 *
 * ## Why a separate permission
 *
 * `FILE_DELETE` moves a file to the trash and is reversible; Manager holds it
 * so a team lead can clear out an obsolete drawing. This is not that. Only
 * Admin holds `FILE_PURGE`, through `"*"` — it is deliberately absent from
 * `DEFAULT_ROLES`, so no seeded role below Admin acquires it and no backfill
 * migration is needed.
 *
 * ## Order of operations
 *
 * Storage first, then version rows, then the file row. If storage removal
 * fails we stop and the file stays in the trash intact — the alternative,
 * deleting the rows first, orphans the blobs with nothing left pointing at
 * them, which is the one outcome that is genuinely unrecoverable *and*
 * invisible. A failure here is a file that is still there, which the user can
 * see and retry.
 */

const ParamsSchema = z.object({ fileId: uuid });

export const DELETE = withTenant(
  { permission: PERMISSIONS.FILE_PURGE, params: ParamsSchema },
  async ({ db, tenantUser, params }) => {
    // Resolves only files that are actually in the trash, applies the tenant
    // filter and requires edit on the containing folder. A live file cannot be
    // purged: it has to be deleted first, so the act is always two decisions.
    const file = await loadDeletedFile(db, tenantUser, params.fileId, "id, name, folderId");

    // lint-conventions-allow: child-table-direct-query — file_versions has no
    // tenantId. The parent file is resolved through the scoped client above,
    // which 404s on another tenant's fileId before this runs.
    const { data: versions } = await db
      .from("file_versions")
      .select("id, storageKey")
      .eq("fileId", params.fileId);

    const storageKeys = ((versions ?? []) as Array<{ storageKey: string | null }>)
      .map((v) => v.storageKey)
      .filter((k): k is string => !!k);

    if (storageKeys.length > 0) {
      const { error: storageError } = await db.storage.from("vault").remove(storageKeys);
      if (storageError) {
        throw conflict(
          `Could not remove the stored file contents: ${storageError.message}. ` +
            `Nothing was deleted — the file is still in the trash.`
        );
      }
    }

    // lint-conventions-allow: child-table-direct-query — see above.
    const { error: versionsError } = await db
      .from("file_versions")
      .delete()
      .eq("fileId", params.fileId);
    if (versionsError) {
      throw conflict(
        `Could not delete the file's version history: ${versionsError.message}. ` +
          `The stored contents have already been removed, so this file is now ` +
          `incomplete and should be purged again.`
      );
    }

    const { error: fileError } = await db.from("files").delete().eq("id", params.fileId);
    if (fileError) {
      throw conflict(`Could not delete the file record: ${fileError.message}.`);
    }

    /**
     * Logged after the fact, and it is the only surviving trace.
     *
     * Audit rows are append-only and are not touched by this route, so the
     * record that a file called `bracket.sldprt` once existed and who destroyed
     * it outlives the file. That is the entire compliance value of the
     * operation — a permanent deletion that erased its own evidence would be
     * worse than no permanent deletion at all.
     */
    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.purge",
      entityType: "file",
      entityId: params.fileId,
      details: {
        name: file.name,
        folderId: file.folderId,
        versionsDestroyed: versions?.length ?? 0,
        storageObjectsDestroyed: storageKeys.length,
      },
    });

    return { success: true, name: file.name };
  }
);
