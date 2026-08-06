import { withTenant, badRequest, notFound, forbidden } from "@/lib/api-route";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { notify, sideEffect } from "@/lib/notifications";
import { BOM_STATUS_FLOW, BOM_STATUS_LABELS } from "@/lib/status-flows";
import { captureBomSnapshot } from "@/lib/bom-snapshot";
import { z, uuid } from "@/lib/validation";
import { attachThumbnailUrl } from "@/lib/thumbnails";
import { nextRevision, usesReservedLetter } from "@/lib/revision";

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

  // The client reads `thumbnailUrl`; the storage key never leaves the server.
  return attachThumbnailUrl(db.storage, bom);
});

/**
 * BOM statuses that put a structure into, or out of, effect.
 *
 * These require ECO_APPROVE on top of the FILE_EDIT the route declares —
 * the same split the ECO route makes between editing and deciding.
 *
 * Before this, releasing a BOM took three PUTs from anyone holding
 * `file.edit`, with no approval, no second person and no change order. The
 * DRAFT → IN_REVIEW → APPROVED → RELEASED flow existed and nothing enforced
 * any of it, so the two middle states were decoration.
 *
 * The asymmetry is what settles it rather than any theory about BOMs. In
 * this same tenant a *drawing* cannot reach Released without the "Approve &
 * Release" transition, its workflow, and a member of the Approvers group
 * signing it. The bill of materials that drives what gets purchased needed
 * less than the drawing did.
 *
 * OBSOLETE is included because taking a released structure out of effect is
 * as consequential as putting one in.
 *
 * Deliberately NOT done: requiring that a release go through an ECO. First
 * release of a new BOM legitimately has no change order behind it — there
 * are 26 imported BOMs waiting on exactly that — and `revise` already
 * carries an optional `ecoId` for the case that does.
 */
const GOVERNED_BOM_STATUSES = new Set(["RELEASED", "OBSOLETE"]);

/** Render the first few offending lines into something a user can go and fix. */
function describeUnresolvedLines(
  lines: Array<{ itemNumber: string | null; name: string | null }>
): string {
  const shown = lines
    .slice(0, 5)
    .map((l) => `${l.itemNumber ?? "?"} ${l.name ?? "(unnamed)"}`.trim())
    .join(", ");
  return lines.length > 5 ? `${shown}, and ${lines.length - 5} more` : shown;
}

export const PUT = withTenant(
  { permission: PERMISSIONS.FILE_EDIT, body: UpdateBomSchema, params: ParamsSchema },
  async ({ db, tenantUser, params, body, permissions }) => {
    const { bomId } = params;

    const { data: existing } = await db
      .from("boms")
      .select("status, name, createdById, previousRevisionId")
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
      // Putting a structure into or out of effect is a decision, not an
      // edit. See GOVERNED_BOM_STATUSES above.
      if (
        GOVERNED_BOM_STATUSES.has(body.status) &&
        !hasPermission(permissions, PERMISSIONS.ECO_APPROVE)
      ) {
        throw forbidden(
          `Moving a BOM to ${body.status} requires the "Approve ECOs" permission. ` +
            `Ask an approver to release it.`
        );
      }

      // Every line must resolve to something the rest of the system can
      // identify before the BOM leaves DRAFT.
      //
      // `bom_items.partId` is nullable and sits beside plain `partNumber` /
      // `name` / `vendor` columns, so a line can be pure free text. That
      // flexibility is genuinely useful while drafting — you type what the
      // drawing says and resolve it later — and useless afterwards: a
      // free-text line cannot map to an ERP item, cannot be found by
      // where-used, and rolls up no cost.
      //
      // The check belongs on the transition rather than at sync time. At sync
      // time the error reaches whoever is running the integration, months
      // later, about a BOM they did not write. Here it reaches the person who
      // typed the line, while they still remember what they meant.
      //
      // A sub-assembly line legitimately has no `partId` — it carries
      // `linkedBomId` and points at another BOM. Requiring `partId` outright
      // would make every nested assembly unreleasable, so the rule is
      // "resolves to a part **or** to a BOM".
      //
      // Only DRAFT → IN_REVIEW is gated. Coming back the other way
      // (IN_REVIEW → DRAFT, APPROVED → DRAFT) stays open, or a BOM that
      // acquired a bad line could never be sent back to be fixed.
      if (existing.status === "DRAFT" && body.status === "IN_REVIEW") {
        // lint-conventions-allow: child-table-direct-query — bom_items has no
        // tenantId. The parent BOM is resolved through the scoped client
        // above, which 404s on another tenant's bomId before this runs.
        const { data: unresolved } = await db
          .from("bom_items")
          .select("itemNumber, name")
          .eq("bomId", bomId)
          .is("partId", null)
          .is("linkedBomId", null)
          .order("sortOrder");

        const lines = (unresolved ?? []) as Array<{
          itemNumber: string | null;
          name: string | null;
        }>;
        if (lines.length > 0) {
          throw badRequest(
            `${lines.length} line${lines.length === 1 ? "" : "s"} on this BOM ` +
              `${lines.length === 1 ? "is" : "are"} not linked to a part or a ` +
              `sub-assembly: ${describeUnresolvedLines(lines)}. Link each one to a ` +
              `part before sending the BOM for review.`
          );
        }
      }

      updates.status = body.status;
      changes.status = `${existing.status} → ${body.status}`;
    }

    if (body.revision !== undefined) {
      // The revision has to stay in a scheme `nextRevision` can continue from.
      //
      // `revise` sequences properly, but this route took any string at all, so
      // a BOM could be dragged to a value the sequencer would never produce —
      // and then the *next* revise fails, on a released BOM, with no obvious
      // connection to the edit that caused it. Refusing here puts the error
      // next to the typo.
      //
      // Accepted schemes are alphabetic (ASME Y14.35), plain integer, and
      // prefixed-integer (`R2`, `Rev09`) — see src/lib/revision.ts. That
      // deliberately still allows a manual correction, which is legitimate:
      // fixing a typo, or matching what the ERP already calls this revision.
      // What it refuses is a value with no successor.
      const revision = body.revision.trim();
      if (!revision) {
        throw badRequest("Revision cannot be empty.");
      }
      if (usesReservedLetter(revision)) {
        throw badRequest(
          `Revision "${revision}" uses a letter ASME Y14.35 reserves ` +
            `(I, O, Q, S, X and Z read as 1, 0, O, 5, experimental and 2). ` +
            `Use the next letter in sequence instead.`
        );
      }
      if (!nextRevision(revision)) {
        throw badRequest(
          `Revision "${revision}" is not in a format that can be sequenced, so ` +
            `the next revision after it could not be worked out. Use letters ` +
            `(A, B, C…), a number (1, 2, 3…), or a prefixed number (R1, R2…).`
        );
      }

      updates.revision = revision;
      changes.revision = revision;
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
      // Releasing a revision retires the one it came from. Done here rather
      // than when the revision is drafted, because until B is released A is
      // still the revision in effect — a draft supersedes nothing.
      //
      // The ECO comment above is now only half true: `eco_items.bomId`
      // (migration 046) lets a change order carry a BOM, but the baseline is
      // still what makes the released structure immutable.
      const previousRevisionId = (existing as { previousRevisionId?: string | null })
        .previousRevisionId;
      if (previousRevisionId) {
        const { error: supersedeError } = await db
          .from("boms")
          .update({ supersededById: bomId, updatedAt: new Date().toISOString() })
          .eq("id", previousRevisionId);
        // Non-fatal, and deliberately so: the release itself has already
        // committed, and a stale `supersededById` shows an extra revision in
        // the list rather than losing anything.
        if (supersedeError) {
          console.error(
            `[boms/${bomId}] failed to supersede ${previousRevisionId}:`,
            supersedeError
          );
        }
      }

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
