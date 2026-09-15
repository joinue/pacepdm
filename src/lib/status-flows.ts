/**
 * Single source of truth for entity state machines.
 *
 * Both client pages and API routes import from here so the rules
 * never drift out of sync.
 */

// ─── BOM ──────────────────────────────────────────────────────────────────
export const BOM_STATUS_FLOW: Record<string, string[]> = {
  DRAFT: ["IN_REVIEW"],
  IN_REVIEW: ["APPROVED", "DRAFT"],
  APPROVED: ["RELEASED", "DRAFT"],
  RELEASED: ["OBSOLETE"],
  OBSOLETE: [],
};

export const BOM_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  IN_REVIEW: "In Review",
  APPROVED: "Approved",
  RELEASED: "Released",
  OBSOLETE: "Obsolete",
};

export function bomCanTransition(from: string, to: string): boolean {
  return (BOM_STATUS_FLOW[from] || []).includes(to);
}

/**
 * Statuses from which `implement_eco` will release a BOM carried on an ECO.
 *
 * This is deliberately wider than `BOM_STATUS_FLOW`, which only allows
 * APPROVED → RELEASED. When a BOM revision travels on a change order, the
 * ECO's own approval *is* its review — making the revision also complete an
 * independent DRAFT → IN_REVIEW → APPROVED cycle is ceremony rather than
 * control, and in practice means the ECO gets implemented and the BOM
 * quietly does not.
 *
 * It lives here rather than only in PL/pgSQL so the exception is written
 * down next to the rule it breaks. `status-flows.test.ts` pins it against
 * the migration text, so editing one without the other fails the build.
 *
 * Not included, and not oversights:
 *   - RELEASED — nothing to do; implement counts it and moves on.
 *   - OBSOLETE — implement raises. Shipping a change whose structure is
 *     obsolete is a mistake worth failing on.
 *
 * See supabase/migrations/migration-049-implement-eco-boms.sql, and 056 for the
 * function's current definition.
 */
export const BOM_STATES_RELEASABLE_BY_ECO = ["DRAFT", "IN_REVIEW", "APPROVED"] as const;

export function bomCanBeReleasedByEco(status: string): boolean {
  return (BOM_STATES_RELEASABLE_BY_ECO as readonly string[]).includes(status);
}

// ─── ECO ──────────────────────────────────────────────────────────────────
export const ECO_STATUS_FLOW: Record<string, string[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["IN_REVIEW", "REJECTED"],
  IN_REVIEW: ["APPROVED", "REJECTED"],
  // Rejecting an approved ECO is its way back. Implementing was the only move,
  // items cannot change outside DRAFT and an approved ECO cannot be deleted, so
  // one that implement refused was stuck for good — with its files locked
  // (AUD-003 CHG-3). REJECTED → DRAFT reopens it. Nothing has been released
  // yet at APPROVED, so rejecting undoes nothing but the approval.
  APPROVED: ["IMPLEMENTED", "REJECTED"],
  REJECTED: ["DRAFT"],
  IMPLEMENTED: ["CLOSED"],
  CLOSED: [],
};

export const ECO_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  IN_REVIEW: "In Review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  IMPLEMENTED: "Implemented",
  CLOSED: "Closed",
};

export function ecoCanTransition(from: string, to: string): boolean {
  return (ECO_STATUS_FLOW[from] || []).includes(to);
}

/**
 * ECO statuses during which a BOM the ECO carries (`eco_items.bomId`) is
 * locked against edits to its lines, name and revision.
 *
 * `implement_eco` releases whatever the carried BOM holds at the moment of
 * implementation, and `BOM_STATES_RELEASABLE_BY_ECO` lets it do so straight
 * from DRAFT on the grounds that the ECO's approval is the review. That only
 * holds if the content cannot move between being reviewed and being
 * released, so the lock runs from submission to implementation.
 *
 * Not included, and not oversights:
 *   - DRAFT — the change is still being authored.
 *   - REJECTED — the ECO is back with its author for rework (or deletion,
 *     which the ECO route allows here). It cannot be implemented without
 *     passing SUBMITTED → IN_REVIEW → APPROVED again, each of which re-locks,
 *     so anything changed now is reviewed before it can ship. Locking it
 *     would strand the BOM on an ECO nobody intends to pursue.
 *   - IMPLEMENTED / CLOSED — implementation released the BOM, and RELEASED
 *     is locked on its own account.
 *
 * See src/lib/bom-lock.ts.
 */
export const ECO_STATES_LOCKING_CARRIED_BOMS = ["SUBMITTED", "IN_REVIEW", "APPROVED"] as const;

/**
 * The ECO statuses an approval workflow can be assigned to, and so the only
 * statuses an ECO can be in while its approval request is out.
 *
 * `PUT /api/ecos/[ecoId]` starts a workflow when an ECO enters one of these,
 * and the approval engine only writes a request's outcome onto an ECO that is
 * still in one. An ECO anywhere else has moved on without the approval, and
 * overwriting it is how a late rejection used to reach an implemented ECO.
 */
export const ECO_STATUSES_AWAITING_APPROVAL = ["SUBMITTED", "IN_REVIEW"] as const;

export function ecoAwaitsApproval(status: string): boolean {
  return (ECO_STATUSES_AWAITING_APPROVAL as readonly string[]).includes(status);
}

// ─── Approval ─────────────────────────────────────────────────────────────
export const APPROVAL_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
  REWORK_REQUESTED: "Rework Requested",
};

export const APPROVAL_MODE_LABELS: Record<string, string> = {
  ANY: "Any approver",
  ALL: "All approvers",
  MAJORITY: "Majority",
};
