import { withTenant, conflict } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { loadFile } from "@/lib/folder-access-guards";
import { pendingApprovalRefusal } from "@/lib/pending-approval";
import { z, uuid } from "@/lib/validation";

const ParamsSchema = z.object({ fileId: uuid });

export const POST = withTenant(
  { permission: PERMISSIONS.FILE_CHECKOUT, params: ParamsSchema },
  async ({ db, tenantUser, params }) => {
    const file = await loadFile(db, tenantUser, params.fileId, "edit");

    if (file.isFrozen) {
      throw conflict("Cannot check out a frozen/released file. Revise it first.");
    }
    if (file.isCheckedOut) {
      throw conflict("File is already checked out");
    }
    // A checkout open when the approval completes leaves the file frozen and
    // checked out at once, which nothing but SQL could undo. See
    // lib/pending-approval.ts.
    const refusal = await pendingApprovalRefusal(tenantUser.tenantId, params.fileId, "checked out");
    if (refusal) throw conflict(refusal);

    const now = new Date().toISOString();
    const { data: updated } = await db
      .from("files")
      .update({
        isCheckedOut: true,
        checkedOutById: tenantUser.id,
        checkedOutAt: now,
        updatedAt: now,
      })
      .eq("id", params.fileId)
      .select()
      .single();

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.checkout",
      entityType: "file",
      entityId: params.fileId,
      details: { name: file.name },
    });

    return updated;
  }
);
