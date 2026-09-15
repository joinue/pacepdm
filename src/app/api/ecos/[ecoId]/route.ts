import { withTenant, badRequest, notFound, forbidden, conflict } from "@/lib/api-route";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { notify, sideEffect } from "@/lib/notifications";
import {
  startWorkflow,
  findWorkflowForTrigger,
  findEcoApprovalWorkflow,
} from "@/lib/approval-engine";
import { ECO_STATUS_FLOW as VALID_TRANSITIONS, ecoAwaitsApproval } from "@/lib/status-flows";
import { z, optionalString, uuid } from "@/lib/validation";
import { blocksSelfApproval, selfApprovalRefusal } from "@/lib/self-approval";

// Update body: status transitions and field updates can be combined.
// Field updates are only allowed in DRAFT (enforced after parse). The
// state-transition rule is also enforced after parse against ECO_STATUS_FLOW.
const UpdateEcoSchema = z
  .object({
    status: z.string().optional(),
    title: z.string().trim().min(1).optional(),
    description: optionalString,
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    reason: optionalString,
    changeType: optionalString,
    costImpact: optionalString,
    disposition: optionalString,
    effectivity: optionalString,
    /**
     * Typed effectivity. The prose `effectivity` field above stays for notes.
     *
     *   IMMEDIATE — in effect the moment the ECO is implemented
     *   DATE      — in effect from `effectiveFrom`
     *   SERIAL    — in effect from unit `effectiveSerial` onward
     *   USE_UP    — in effect once existing stock of the old design is consumed
     *
     * Only the first two are answerable here. SERIAL needs the unit's serial
     * and USE_UP needs inventory levels; both live in the ERP, so the app
     * displays those and defers rather than computing an answer that would be
     * wrong in practice. See docs/decisions/erp-ownership.md.
     *
     * USE_UP is the common case in equipment manufacture and was missing, so
     * anyone recording such a change invented a date or left the field blank.
     */
    effectivityType: z.enum(["IMMEDIATE", "DATE", "SERIAL", "USE_UP"]).nullable().optional(),
    effectiveFrom: z.string().datetime().nullable().optional(),
    effectiveSerial: optionalString,
  })
  .refine((v) => v.effectivityType !== "DATE" || v.effectiveFrom !== null, {
    message: "Date effectivity needs a date",
    path: ["effectiveFrom"],
  })
  .refine((v) => v.effectivityType !== "SERIAL" || !!v.effectiveSerial, {
    message: "Serial effectivity needs a starting serial number",
    path: ["effectiveSerial"],
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No changes specified" });

const ParamsSchema = z.object({ ecoId: uuid });

const WITH_CREATOR = "*, createdBy:tenant_users!ecos_createdById_fkey(fullName, email)";

export const GET = withTenant({ params: ParamsSchema }, async ({ db, params }) => {
  // maybeSingle returns (data: null, error: null) cleanly when the row
  // doesn't exist, instead of wrapping "0 rows" in an error object. That
  // lets us tell an empty result apart from an actual query failure
  // (broken join, connection drop, etc.) without parsing error codes.
  const { data: eco, error } = await db
    .from("ecos")
    .select(WITH_CREATOR)
    .eq("id", params.ecoId)
    .is("deletedAt", null)
    .maybeSingle();

  if (error) throw new Error(`Query failed: ${error.message}`);
  if (!eco) throw notFound("ECO not found");

  return eco;
});

/**
 * Transitions that decide an ECO's fate rather than move it along.
 *
 * These require ECO_APPROVE on top of the ECO_EDIT the route already
 * declares. Without that second check the permission was dead: it is
 * defined in PERMISSION_INFO, granted to Admin and Manager in
 * DEFAULT_ROLES, asserted in permissions.test.ts — and read by nothing, so
 * anyone who could edit an ECO could also approve it.
 *
 * That mattered more than a missing check usually does. `findWorkflowForTrigger`
 * falls through to a direct status update when no workflow is assigned to
 * the trigger, and no tenant is seeded with an ECO workflow — the seeded
 * assignment covers a file transition (`ecoTrigger: null`). So the approval
 * gate was not merely unenforced, it was absent: one Engineer could take an
 * ECO DRAFT → SUBMITTED → IN_REVIEW → APPROVED alone, then implement it,
 * which releases parts, freezes files and (since migration 049) releases the
 * BOM revisions it carries.
 *
 * It also undercut the reasoning migration 049 was written on — that
 * releasing a BOM straight from DRAFT is safe because "the ECO's approval is
 * the review". That is only true if approving an ECO means something.
 */
const DECISION_STATUSES = new Set(["APPROVED", "REJECTED"]);

type EffectivityFields = {
  effectivityType?: string | null;
  effectiveFrom?: string | null;
  effectiveSerial?: string | null;
};

/**
 * The typed effectivity columns as they should be after this update.
 *
 * Resolved against the stored row because the update can be partial: a body
 * that only changes the type must not leave a DATE ECO without a date, and a
 * switch away from DATE or SERIAL clears the value that no longer applies so
 * the row cannot contradict itself. A value sent for a type that does not use
 * it is refused rather than dropped — silently dropping what the user entered
 * is the bug this replaced.
 */
function resolveEffectivity(stored: EffectivityFields, change: EffectivityFields) {
  const type =
    change.effectivityType !== undefined
      ? change.effectivityType
      : (stored.effectivityType ?? null);

  if (change.effectiveFrom && type !== "DATE") {
    throw badRequest("A start date only applies to date effectivity");
  }
  if (change.effectiveSerial && type !== "SERIAL") {
    throw badRequest("A starting serial number only applies to serial effectivity");
  }

  const effectiveFrom =
    type === "DATE"
      ? change.effectiveFrom !== undefined
        ? change.effectiveFrom
        : (stored.effectiveFrom ?? null)
      : null;
  const effectiveSerial =
    type === "SERIAL"
      ? change.effectiveSerial !== undefined
        ? change.effectiveSerial
        : (stored.effectiveSerial ?? null)
      : null;

  if (type === "DATE" && !effectiveFrom) throw badRequest("Date effectivity needs a date");
  if (type === "SERIAL" && !effectiveSerial) {
    throw badRequest("Serial effectivity needs a starting serial number");
  }

  return { effectivityType: type, effectiveFrom, effectiveSerial };
}

export const PUT = withTenant(
  { permission: PERMISSIONS.ECO_EDIT, body: UpdateEcoSchema, params: ParamsSchema },
  async ({ db, tenantUser, params, body, permissions }) => {
    const { ecoId } = params;
    const {
      status,
      title,
      description,
      priority,
      reason,
      changeType,
      costImpact,
      disposition,
      effectivity,
      effectivityType,
      effectiveFrom,
      effectiveSerial,
    } = body;

    const { data: eco } = await db
      .from("ecos")
      .select("*")
      .eq("id", ecoId)
      .is("deletedAt", null)
      .maybeSingle();
    if (!eco) throw notFound("ECO not found");

    const now = new Date().toISOString();

    /** The ECO creator hears about every status change. notify() filters the actor. */
    async function notifyCreator(to: string) {
      if (!eco.createdById) return;
      await sideEffect(
        notify({
          tenantId: tenantUser.tenantId,
          userIds: [eco.createdById],
          title: `ECO ${eco.ecoNumber} ${to.toLowerCase()}`,
          message: `${tenantUser.fullName} moved ${eco.ecoNumber} to ${to}`,
          type: "eco",
          link: `/ecos/${eco.id}`,
          refId: eco.id,
          actorId: tenantUser.id,
        }),
        `notify ECO ${eco.ecoNumber} status change`
      );
    }

    // Field updates are only legal in DRAFT — once submitted, the content is frozen.
    const hasFieldUpdate = [
      title,
      description,
      priority,
      reason,
      changeType,
      costImpact,
      disposition,
      effectivity,
      effectivityType,
      effectiveFrom,
      effectiveSerial,
    ].some((v) => v !== undefined);

    if (hasFieldUpdate) {
      if (eco.status !== "DRAFT") {
        throw badRequest("Can only edit fields when ECO is in DRAFT");
      }

      const updates: Record<string, unknown> = { updatedAt: now };
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (priority !== undefined) updates.priority = priority;
      if (reason !== undefined) updates.reason = reason;
      if (changeType !== undefined) updates.changeType = changeType;
      if (costImpact !== undefined) updates.costImpact = costImpact;
      if (disposition !== undefined) updates.disposition = disposition;
      if (effectivity !== undefined) updates.effectivity = effectivity;
      // The schema accepted these three and nothing wrote them, so choosing
      // "From a date" reported "ECO updated" and was gone on the next load.
      if (
        effectivityType !== undefined ||
        effectiveFrom !== undefined ||
        effectiveSerial !== undefined
      ) {
        Object.assign(
          updates,
          resolveEffectivity(eco, { effectivityType, effectiveFrom, effectiveSerial })
        );
      }

      if (!status) {
        const { data: updated, error } = await db
          .from("ecos")
          .update(updates)
          .eq("id", ecoId)
          .select(WITH_CREATOR)
          .single();
        if (error) throw new Error(error.message);
        return updated;
      }
    }

    if (status) {
      const validNext = VALID_TRANSITIONS[eco.status] || [];
      if (!validNext.includes(status)) {
        throw badRequest(
          `Cannot transition from ${eco.status} to ${status}. Valid: ${validNext.join(", ") || "none"}`
        );
      }

      // While a workflow's approval request is out, that request is the
      // decision. Moving the ECO around it let a Manager approve or reject
      // directly (or anyone move SUBMITTED → IN_REVIEW) with the request still
      // pending — whose outcome would later land on top — and a resubmitted
      // ECO was handed its stale request by startWorkflow's one-pending-
      // request-per-entity guard. `.limit(1)` rather than maybeSingle, which
      // errors when there are two and would read as "none".
      const { data: openRequests, error: openRequestError } = await db
        .from("approval_requests")
        .select("id")
        .eq("entityType", "eco")
        .eq("entityId", ecoId)
        .eq("status", "PENDING")
        .limit(1);
      if (openRequestError) {
        throw new Error(
          `Could not check for an open approval request: ${openRequestError.message}`
        );
      }
      if (openRequests && openRequests.length > 0) {
        throw conflict(
          `${eco.ecoNumber} has an approval request in progress, so its status cannot be ` +
            `changed directly. Its approvers decide it on the Approvals page, where the ` +
            `requester can also recall it.`
        );
      }

      // Deciding an ECO is a different act from editing one. See
      // DECISION_STATUSES above for why this was missing and what it let
      // through. Checked here rather than declared in the route options
      // because it depends on the target status, which the wrapper cannot
      // see — this is the documented exception, not a hand-rolled gate.
      if (DECISION_STATUSES.has(status) && !hasPermission(permissions, PERMISSIONS.ECO_APPROVE)) {
        throw forbidden(
          `Moving an ECO to ${status} requires the "Approve ECOs" permission. ` +
            `Ask an approver to decide it.`
        );
      }

      // While the tenant routes ECO approvals through a workflow, approving
      // one is the workflow's job. The pending-request check above only covered
      // an ECO whose request was still out: once a request was recalled or sent
      // back for rework, the ECO sat in SUBMITTED or IN_REVIEW with nothing
      // pending, and a Manager could approve it here — the multi-step workflow
      // never ran (AUD-003 CHG-1). Recall and rework now return the ECO to
      // DRAFT; this refuses what is left, including an ECO submitted before the
      // workflow was assigned. A direct rejection stays allowed: it releases
      // nothing, and REJECTED → DRAFT is how such an ECO gets back in line.
      if (status === "APPROVED") {
        const governing = await findEcoApprovalWorkflow(tenantUser.tenantId);
        if (governing) {
          throw conflict(
            `ECO approvals go through the "${governing.name}" workflow, so ${eco.ecoNumber} ` +
              `cannot be approved directly. Its approvers decide it on the Approvals page once ` +
              `it has been submitted into that workflow; if it was submitted before the ` +
              `workflow existed, reject it and submit it again.`
          );
        }
      }

      // Self-approval, if the tenant has turned it off.
      //
      // This is the path that matters. `findWorkflowForTrigger` falls through
      // to a direct status update when no workflow is assigned, and no tenant
      // is seeded with an ECO workflow — so for most tenants an ECO is decided
      // here and never touches the approval engine. Gating only the engine
      // would leave the setting looking enforced and doing nothing, which is
      // finding 2 of the functional audit repeated exactly.
      if (
        DECISION_STATUSES.has(status) &&
        eco.createdById === tenantUser.id &&
        (await blocksSelfApproval(
          db.unscoped("tenant settings are read by tenant id, which is the caller's own"),
          tenantUser.tenantId
        ))
      ) {
        throw forbidden(selfApprovalRefusal("decide"));
      }

      // Check for an approval workflow on SUBMITTED / IN_REVIEW transitions.
      if (ecoAwaitsApproval(status)) {
        const workflow = await findWorkflowForTrigger({
          tenantId: tenantUser.tenantId,
          ecoTrigger: status,
        });

        if (workflow) {
          // The ECO has to reach this status before the workflow starts, or
          // the approval request references a state the ECO is not in.
          const { error: statusError } = await db
            .from("ecos")
            .update({ status, updatedAt: now })
            .eq("id", ecoId);
          if (statusError) {
            throw new Error(`Could not move the ECO to ${status}: ${statusError.message}`);
          }

          const result = await startWorkflow({
            tenantId: tenantUser.tenantId,
            userId: tenantUser.id,
            // `fullName` is nullable on tenant_users (SSO can provision a row
            // before a name is known). The old untyped client hid that.
            userFullName: tenantUser.fullName ?? tenantUser.email ?? "Unknown user",
            workflowId: workflow.id,
            type: "ECO",
            entityType: "eco",
            entityId: ecoId,
            title: `ECO ${eco.ecoNumber}: ${eco.title}`,
            description: `ECO ${eco.ecoNumber} submitted for approval`,
          });

          // A failed start (no steps, an empty ALL/MAJORITY group, a seat
          // that would not write) used to return 200 with the ECO left in the
          // new status and no request behind it — waiting on an approval that
          // did not exist. Put it back and say why.
          if (!result.success) {
            const { error: revertError } = await db
              .from("ecos")
              .update({ status: eco.status, updatedAt: now })
              .eq("id", ecoId)
              .eq("status", status);
            if (revertError) {
              throw new Error(
                `The approval workflow could not start (${result.error}), and ${eco.ecoNumber} ` +
                  `could not be moved back to ${eco.status}: ${revertError.message}`
              );
            }
            throw badRequest(
              `${eco.ecoNumber} stays in ${eco.status} because its approval workflow could not ` +
                `start: ${result.error}`
            );
          }

          await logAudit({
            tenantId: tenantUser.tenantId,
            userId: tenantUser.id,
            action: "eco.status_change",
            entityType: "eco",
            entityId: ecoId,
            details: {
              ecoNumber: eco.ecoNumber,
              from: eco.status,
              to: status,
              workflowTriggered: true,
            },
          });

          await notifyCreator(status);

          const { data: updated } = await db
            .from("ecos")
            .select(WITH_CREATOR)
            .eq("id", ecoId)
            .single();

          return {
            ...updated,
            pendingApproval: true,
            message: "ECO submitted for approval",
          };
        }
      }

      // No workflow — update status directly
      const { data: updated, error } = await db
        .from("ecos")
        .update({ status, updatedAt: now })
        .eq("id", ecoId)
        .select(WITH_CREATOR)
        .single();

      if (error) throw new Error(error.message);

      await logAudit({
        tenantId: tenantUser.tenantId,
        userId: tenantUser.id,
        action: "eco.status_change",
        entityType: "eco",
        entityId: ecoId,
        details: { ecoNumber: eco.ecoNumber, from: eco.status, to: status },
      });

      await notifyCreator(status);

      return updated;
    }

    throw badRequest("No changes specified");
  }
);

export const DELETE = withTenant(
  { permission: PERMISSIONS.ECO_EDIT, params: ParamsSchema },
  async ({ db, tenantUser, params }) => {
    const { ecoId } = params;

    const { data: eco } = await db
      .from("ecos")
      .select("id, status, ecoNumber")
      .eq("id", ecoId)
      .is("deletedAt", null)
      .maybeSingle();
    if (!eco) throw notFound("ECO not found");

    if (eco.status !== "DRAFT" && eco.status !== "REJECTED" && eco.status !== "CLOSED") {
      throw badRequest("Can only delete ECOs in DRAFT, REJECTED, or CLOSED status");
    }

    // Soft-delete: mark as deleted instead of removing the row.
    // Child rows (eco_items) are left intact for audit trail.
    const { error } = await db
      .from("ecos")
      .update({ deletedAt: new Date().toISOString() })
      .eq("id", ecoId);
    if (error) throw new Error(error.message);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "eco.delete",
      entityType: "eco",
      entityId: ecoId,
      details: { ecoNumber: eco.ecoNumber },
    });

    return { success: true };
  }
);
