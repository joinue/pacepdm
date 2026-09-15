import { withTenant, conflict, forbidden } from "@/lib/api-route";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { notify, sideEffect } from "@/lib/notifications";
import { processMentions } from "@/lib/mentions";
import { loadFile } from "@/lib/folder-access-guards";
import { z, uuid } from "@/lib/validation";
import { readUploadGrant } from "@/lib/vault-uploads";
import { commitVersionUpload } from "@/lib/vault-version-upload";

const BodySchema = z.object({
  /**
   * From POST /api/files/[fileId]/checkin/upload, once the browser has
   * uploaded the new version. Omit to undo the checkout without a version.
   */
  uploadToken: z.string().min(1).optional(),
  comment: z.string().max(5000).nullable().optional(),
});

/**
 * Check in: record a new version and release the checkout, or with no upload,
 * undo the checkout.
 *
 * Undoing is allowed on a frozen file on purpose: it writes no version, and it
 * is the only way out for a file that is frozen and checked out at once — a
 * state an approval completing mid-checkout used to reach.
 */
export const POST = withTenant(
  { permission: PERMISSIONS.FILE_CHECKIN, params: z.object({ fileId: uuid }), body: BodySchema },
  async ({ db, tenantUser, permissions, params, body }) => {
    const file = await loadFile(db, tenantUser, params.fileId, "edit");
    const comment = body.comment?.trim() || null;
    const heldBy = file.checkedOutById as string | null;

    let version = file.currentVersion as number;
    if (body.uploadToken) {
      const grant = readUploadGrant(body.uploadToken, {
        tenantId: tenantUser.tenantId,
        userId: tenantUser.id,
        purpose: "checkin",
        fileId: params.fileId,
      });
      // The checkout and review checks run inside the commit, after it has
      // recognised a retry of a check-in that already landed.
      const result = await commitVersionUpload({
        db,
        user: { id: tenantUser.id, permissions },
        file,
        grant,
        purpose: "checkin",
        comment,
      });
      if (result.alreadyRecorded) return { success: true, version: result.version };
      version = result.version;
    } else {
      if (!file.isCheckedOut) throw conflict("File is not checked out");
      if (heldBy !== tenantUser.id && !hasPermission(permissions, "admin.settings")) {
        throw forbidden("File is checked out by another user");
      }
      // Reporting success on a failed release leaves the file locked to a user
      // who has been told they released it.
      const { error: releaseError } = await db
        .from("files")
        .update({
          isCheckedOut: false,
          checkedOutById: null,
          checkedOutAt: null,
          updatedAt: new Date().toISOString(),
        })
        .eq("id", params.fileId);
      if (releaseError) {
        throw new Error(`Could not release the checkout: ${releaseError.message}`);
      }
    }

    const checkedIn = Boolean(body.uploadToken);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: checkedIn ? "file.checkin" : "file.undo_checkout",
      entityType: "file",
      entityId: params.fileId,
      details: { name: file.name, version },
    });

    if (comment) {
      await sideEffect(
        processMentions({
          tenantId: tenantUser.tenantId,
          mentionedById: tenantUser.id,
          mentionedByName: tenantUser.fullName ?? "",
          entityType: "file_version",
          entityId: params.fileId,
          comment,
          link: `/vault?fileId=${params.fileId}`,
        }),
        `process mentions for file checkin ${params.fileId}`
      );
    }

    // An admin closing someone else's checkout tells the person who held it.
    // notify() filters out the actor, so a normal check-in sends nothing.
    if (heldBy) {
      await sideEffect(
        notify({
          tenantId: tenantUser.tenantId,
          userIds: [heldBy],
          title: checkedIn ? "File checked in by admin" : "Checkout cancelled by admin",
          message: checkedIn
            ? `"${file.name}" was checked in by ${tenantUser.fullName}`
            : `Your checkout of "${file.name}" was cancelled by ${tenantUser.fullName}`,
          type: "checkout",
          link: `/vault?fileId=${params.fileId}`,
          refId: params.fileId,
          actorId: tenantUser.id,
        }),
        `notify checkout owner about admin checkin of ${params.fileId}`
      );
    }

    return { success: true, version };
  }
);
