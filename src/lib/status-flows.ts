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
