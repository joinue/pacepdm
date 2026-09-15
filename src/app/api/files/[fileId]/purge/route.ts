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
 * ## What refuses a purge
 *
 * A file an ECO lists, or one an ECO released. `eco_items_fileId_fkey` is
 * ON DELETE RESTRICT, so Postgres would refuse the row delete anyway — but only
 * after this route used to have destroyed the stored contents and the version
 * rows, leaving a trashed file with no versions and a release manifest whose
 * storage keys pointed at nothing. A file released through a part it is linked
 * to is not on `eco_items` at all, so the release stamp on its versions and the
 * release manifests are checked too. All of it before anything is touched.
 *
 * ## Order of operations
 *
 * Database first, storage last. The `files` row goes in one statement, and
 * `file_versions`, `metadata_values`, `file_references` and `part_files`
 * cascade from it (migration-001, migration-005), so the row delete either
 * takes the whole record or nothing. Only once it has provably happened are
 * the blobs removed.
 *
 * The other way round is what shipped, and it was wrong: a failure after the
 * storage removal destroyed the only copy of the contents while leaving the
 * record behind. A failure this way round orphans blobs with nothing pointing
 * at them — costing storage, not data — so it is logged with the keys, noted
 * on the audit row, and does not fail a purge that has already happened.
 */

const ParamsSchema = z.object({ fileId: uuid });

export const DELETE = withTenant(
  { permission: PERMISSIONS.FILE_PURGE, params: ParamsSchema },
  async ({ db, tenantUser, params }) => {
    // Resolves only files that are actually in the trash, applies the tenant
    // filter and requires edit on the containing folder. A live file cannot be
    // purged: it has to be deleted first, so the act is always two decisions.
    const file = await loadDeletedFile(db, tenantUser, params.fileId, "id, name, folderId");

    // Every read below fails closed. A purge that could not check what refers
    // to the file cannot know it is safe to destroy it.
    const unchecked = (what: string, message: string) =>
      new Error(`Could not check ${what} before purging: ${message}. Nothing was deleted.`);

    // lint-conventions-allow: child-table-direct-query — file_versions has no
    // tenantId. The parent file is resolved through the scoped client above,
    // which 404s on another tenant's fileId before this runs.
    const { data: versions, error: versionsError } = await db
      .from("file_versions")
      .select("id, storageKey, ecoId")
      .eq("fileId", params.fileId);
    if (versionsError) throw unchecked("the file's versions", versionsError.message);

    // lint-conventions-allow: child-table-direct-query — eco_items has no
    // tenantId; filtered by the file id resolved through the scoped client
    // above. Only the count and ECO ids are read, and the ECO numbers are
    // looked up through the scoped client below.
    const { data: ecoItems, error: ecoItemsError } = await db
      .from("eco_items")
      .select("ecoId")
      .eq("fileId", params.fileId);
    if (ecoItemsError) throw unchecked("the ECOs listing this file", ecoItemsError.message);

    const { data: releases, error: releasesError } = await db
      .from("releases")
      .select("ecoId, ecoNumber")
      .contains("manifest", { files: [{ fileId: params.fileId }] });
    if (releasesError) throw unchecked("the releases containing this file", releasesError.message);

    const versionRows = (versions ?? []) as Array<{
      storageKey: string | null;
      ecoId: string | null;
    }>;
    const listedEcoIds = ((ecoItems ?? []) as Array<{ ecoId: string }>).map((i) => i.ecoId);
    const releaseRows = (releases ?? []) as Array<{ ecoId: string; ecoNumber: string }>;
    const releasedEcoIds = versionRows.map((v) => v.ecoId).filter((id): id is string => !!id);

    if (listedEcoIds.length > 0 || releasedEcoIds.length > 0 || releaseRows.length > 0) {
      const ecoIds = Array.from(new Set([...listedEcoIds, ...releasedEcoIds]));
      const numberById = new Map(releaseRows.map((r) => [r.ecoId, r.ecoNumber]));
      if (ecoIds.length > 0) {
        const { data: ecos } = await db.from("ecos").select("id, ecoNumber").in("id", ecoIds);
        for (const eco of (ecos ?? []) as Array<{ id: string; ecoNumber: string }>) {
          numberById.set(eco.id, eco.ecoNumber);
        }
      }
      const names = (ids: string[]) =>
        Array.from(new Set(ids.map((id) => numberById.get(id) ?? "an ECO"))).join(", ");

      const reasons: string[] = [];
      if (listedEcoIds.length > 0) reasons.push(`it is listed on ${names(listedEcoIds)}`);
      const releasedUnder = [...releasedEcoIds, ...releaseRows.map((r) => r.ecoId)];
      if (releasedUnder.length > 0) reasons.push(`it was released under ${names(releasedUnder)}`);

      throw conflict(
        `Cannot permanently delete "${file.name}": ${reasons.join(" and ")}. ` +
          `ECOs and their releases are a permanent record of the files they changed, ` +
          `and purging would leave that record pointing at nothing. Nothing was ` +
          `deleted — the file is still in the trash.`
      );
    }

    // One statement, so the record goes whole or not at all — the version rows
    // and the rest cascade from it. `deletedAt` is re-asserted so a file
    // restored from the trash since it was loaded is not destroyed, and the
    // deleted row is returned because storage below may only be touched once
    // the row is provably gone: a delete that matched nothing is not an error.
    const { data: deleted, error: fileError } = await db
      .from("files")
      .delete()
      .eq("id", params.fileId)
      .not("deletedAt", "is", null)
      .select("id");
    if (fileError) {
      throw conflict(
        `Could not delete the file record: ${fileError.message}. ` +
          `Nothing was deleted — the file is still in the trash.`
      );
    }
    if (!deleted || deleted.length === 0) {
      throw conflict(
        `"${file.name}" is no longer in the trash — it may have just been restored. Nothing was deleted.`
      );
    }

    // Restored versions share the storage key of the version they restored.
    const storageKeys = Array.from(
      new Set(versionRows.map((v) => v.storageKey).filter((k): k is string => !!k))
    );

    let storageRemovalError: string | null = null;
    if (storageKeys.length > 0) {
      const { error: storageError } = await db.storage.from("vault").remove(storageKeys);
      if (storageError) {
        storageRemovalError = storageError.message;
        console.error(
          `[files/${params.fileId}/purge] file record purged, but its stored contents ` +
            `could not be removed and are now orphaned: ${storageError.message}`,
          storageKeys
        );
      }
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
        versionsDestroyed: versionRows.length,
        storageObjectsDestroyed: storageRemovalError ? 0 : storageKeys.length,
        // Audit details hold scalars, so the orphaned keys go as a JSON array.
        ...(storageRemovalError
          ? { storageRemovalError, orphanedStorageKeys: JSON.stringify(storageKeys) }
          : {}),
      },
    });

    if (storageRemovalError) {
      return {
        success: true,
        name: file.name,
        warnings: [
          `The file was purged, but its stored contents could not be removed ` +
            `(${storageRemovalError}). They are no longer reachable from the app.`,
        ],
      };
    }
    return { success: true, name: file.name };
  }
);
