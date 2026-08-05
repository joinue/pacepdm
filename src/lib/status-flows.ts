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
 * See supabase/migrations/migration-049-implement-eco-boms.sql.
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
  APPROVED: ["IMPLEMENTED"],
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
