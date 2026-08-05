import { withTenant, conflict } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { loadFile } from "@/lib/folder-access-guards";
import { z, uuid } from "@/lib/validation";

const ParamsSchema = z.object({ fileId: uuid });

export const DELETE = withTenant(
  { permission: PERMISSIONS.FILE_DELETE, params: ParamsSchema },
  async ({ db, tenantUser, params }) => {
    // `loadFile` already excludes soft-deleted rows, so a second delete of the
    // same file now 404s as "File not found" rather than "File already
    // deleted". Same status, and it stops the endpoint confirming that a
    // deleted file ever existed.
    const file = await loadFile(db, tenantUser, params.fileId, "edit");

    if (file.isCheckedOut) {
      throw conflict("Cannot delete a checked-out file");
    }
    if (file.lifecycleState === "Released") {
      throw conflict("Cannot delete a released file. Mark it as obsolete first.");
    }

    // Soft-delete: mark the file as deleted instead of removing the row.
    // Child rows (versions, metadata) are left intact for audit trail, and
    // the storage blob is never touched — which is what makes
    // `POST /api/files/[fileId]/undelete` a metadata-only operation.
    //
    // `deletedById` is stamped alongside so the trash view can show who
    // deleted a file without joining the audit log.
    const { error } = await db
      .from("files")
      .update({ deletedAt: new Date().toISOString(), deletedById: tenantUser.id })
      .eq("id", params.fileId);
    if (error) throw new Error(error.message);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.delete",
      entityType: "file",
      entityId: params.fileId,
      details: { name: file.name },
    });

    return { success: true };
  }
);
