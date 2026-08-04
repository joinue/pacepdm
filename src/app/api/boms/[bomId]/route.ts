import { withTenant, badRequest, notFound } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { notify, sideEffect } from "@/lib/notifications";
import { BOM_STATUS_FLOW, BOM_STATUS_LABELS } from "@/lib/status-flows";
import { captureBomSnapshot } from "@/lib/bom-snapshot";
import { z, uuid } from "@/lib/validation";

// Partial-update shape: any of name/status/revision can be supplied. The
// state-transition rule (only valid next-states allowed) is enforced after
// parse against the shared BOM_STATUS_FLOW map.
const UpdateBomSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    status: z.string().optional(),
    revision: z.string().optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined || v.revision !== undefined, {
    message: "At least one field is required",
  });

const ParamsSchema = z.object({ bomId: uuid });

export const GET = withTenant({ params: ParamsSchema }, async ({ db, params }) => {
  const { data: bom } = await db
    .from("boms")
    .select("*")
    .eq("id", params.bomId)
    .is("deletedAt", null)
    .maybeSingle();

  if (!bom) throw notFound("BOM not found");
  return bom;
});

export const PUT = withTenant(
  { permission: PERMISSIONS.FILE_EDIT, body: UpdateBomSchema, params: ParamsSchema },
  async ({ db, tenantUser, params, body }) => {
    const { bomId } = params;

    const { data: existing } = await db
      .from("boms")
      .select("status, name, createdById")
      .eq("id", bomId)
      .is("deletedAt", null)
      .maybeSingle();

    if (!existing) throw notFound("BOM not found");

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    const changes: Record<string, string | null> = {};

    if (body.name !== undefined && body.name !== existing.name) {
      updates.name = body.name;
      changes.name = body.name;
    }

    // Status transition — guarded by the shared state machine
    if (body.status && body.status !== existing.status) {
      const allowed = BOM_STATUS_FLOW[existing.status] || [];
      if (!allowed.includes(body.status)) {
        throw badRequest(
          `Cannot change status from ${existing.status} to ${body.status}. Allowed: ${allowed.join(", ") || "none"}`
        );
      }
      updates.status = body.status;
      changes.status = `${existing.status} → ${body.status}`;
    }

    if (body.revision !== undefined) {
      updates.revision = body.revision;
      changes.revision = body.revision;
    }

    const { data: bom, error } = await db
      .from("boms")
      .update(updates)
      .eq("id", bomId)
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Auto-capture a baseline when the BOM transitions to RELEASED.
    // This is the "immutable record of what we shipped" that the ECO
    // trail deliberately doesn't carry — ECOs track files, not BOMs, so
    // without this snapshot a later revision of the BOM would silently
    // overwrite the picture. Failures are logged but non-fatal: a missed
    // baseline is a documentation gap, not a correctness problem, and
    // we don't want to block the release on it.
    if (updates.status === "RELEASED") {
      try {
        const result = await captureBomSnapshot({
          // Takes a raw SupabaseClient and scopes every query by the tenantId
          // it is handed, which is the caller's own — see lib/bom-snapshot.ts.
          db: db.unscoped("bom-snapshot takes a raw client and scopes by the tenantId passed in"),
          tenantId: tenantUser.tenantId,
          bomId,
          userId: tenantUser.id,
          trigger: "RELEASE",
        });
        console.info(
          `[boms/${bomId}] auto-baseline captured ${result.snapshotId} ` +
            `(${result.itemCount} items, $${result.flatTotalCost.toFixed(2)})`
        );
      } catch (err) {
        console.error(`[boms/${bomId}] baseline capture failed:`, err);
      }
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "bom.update",
      entityType: "bom",
      entityId: bomId,
      details: changes,
    });

    // Notify the BOM creator on status transitions. Only fires when the
    // status actually changed (not on bare name/revision edits) — those
    // are noisy and the audit log already covers them.
    if (updates.status && existing.createdById) {
      const friendlyStatus = BOM_STATUS_LABELS[body.status!] || body.status!;
      await sideEffect(
        notify({
          tenantId: tenantUser.tenantId,
          userIds: [existing.createdById],
          title: `BOM moved to ${friendlyStatus}`,
          message: `${tenantUser.fullName} moved "${existing.name}" to ${friendlyStatus}`,
          type: "transition",
          link: `/boms/${bomId}`,
          refId: bomId,
          actorId: tenantUser.id,
        }),
        `notify BOM ${bomId} status change`
      );
    }

    return bom;
  }
);

export const DELETE = withTenant(
  { permission: PERMISSIONS.FILE_EDIT, params: ParamsSchema },
  async ({ db, tenantUser, params }) => {
    const { bomId } = params;

    const { data: existing } = await db
      .from("boms")
      .select("name, status")
      .eq("id", bomId)
      .is("deletedAt", null)
      .maybeSingle();

    if (!existing) throw notFound("BOM not found");

    if (existing.status === "RELEASED") {
      throw badRequest("Cannot delete a released BOM. Obsolete it first.");
    }

    // Soft-delete: mark as deleted instead of removing the row.
    // Child rows (bom_items, snapshots) are left intact for audit trail.
    const { error } = await db
      .from("boms")
      .update({ deletedAt: new Date().toISOString() })
      .eq("id", bomId);
    if (error) throw new Error(error.message);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "bom.delete",
      entityType: "bom",
      entityId: bomId,
      details: { name: existing.name },
    });

    return { success: true };
  }
);
