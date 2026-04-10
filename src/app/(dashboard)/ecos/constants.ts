// Display variants and human-readable labels for ECO enums.
//
// The transition list (`VALID_TRANSITIONS`) is enriched with UI metadata
// (button labels, button variants) on top of the underlying state machine
// in `src/lib/status-flows.ts` — that's why it lives here rather than in
// the shared file.

export const statusVariants: Record<string, "muted" | "info" | "warning" | "success" | "error" | "purple"> = {
  DRAFT: "muted",
  SUBMITTED: "info",
  IN_REVIEW: "warning",
  APPROVED: "success",
  REJECTED: "error",
  IMPLEMENTED: "purple",
  CLOSED: "muted",
};

export const priorityVariants: Record<string, "muted" | "info" | "orange" | "error"> = {
  LOW: "muted",
  MEDIUM: "info",
  HIGH: "orange",
  CRITICAL: "error",
};

export const changeTypeLabels: Record<string, { label: string; variant: "info" | "warning" | "error" }> = {
  ADD: { label: "Add", variant: "info" },
  MODIFY: { label: "Modify", variant: "warning" },
  REMOVE: { label: "Remove", variant: "error" },
};

/**
 * UI-enriched ECO state transitions. The underlying allowed-states map
 * lives in `src/lib/status-flows.ts` (`ECO_STATUS_FLOW`); this map adds
 * the human-readable button text and Button variant for each transition.
 *
 * Keep these two in sync — if you add a transition here, also add it
 * to the shared status flow.
 */
export const VALID_TRANSITIONS: Record<
  string,
  { status: string; label: string; variant?: "default" | "success" | "destructive" }[]
> = {
  DRAFT: [{ status: "SUBMITTED", label: "Submit for Review", variant: "default" }],
  SUBMITTED: [
    { status: "IN_REVIEW", label: "Begin Review", variant: "default" },
    { status: "REJECTED", label: "Reject", variant: "destructive" },
  ],
  IN_REVIEW: [
    { status: "APPROVED", label: "Approve", variant: "success" },
    { status: "REJECTED", label: "Reject", variant: "destructive" },
  ],
  APPROVED: [{ status: "IMPLEMENTED", label: "Mark Implemented", variant: "success" }],
  REJECTED: [{ status: "DRAFT", label: "Reopen as Draft" }],
  IMPLEMENTED: [{ status: "CLOSED", label: "Close", variant: "default" }],
  CLOSED: [],
};

export const reasonLabels: Record<string, string> = {
  DESIGN_IMPROVEMENT: "Design Improvement",
  COST_REDUCTION: "Cost Reduction",
  DEFECT_FIX: "Defect / Failure Fix",
  REGULATORY: "Regulatory / Compliance",
  MANUFACTURING: "Manufacturing Improvement",
  CUSTOMER_REQUEST: "Customer Request",
  OTHER: "Other",
};

export const changeTypeLabelsEco: Record<string, string> = {
  DOCUMENT_ONLY: "Document Only",
  COMPONENT: "Component",
  ASSEMBLY: "Assembly",
  PROCESS: "Process",
};

export const costImpactLabels: Record<string, string> = {
  NONE: "None",
  MINOR: "Minor",
  MODERATE: "Moderate",
  SIGNIFICANT: "Significant",
};

export const dispositionLabels: Record<string, string> = {
  USE_AS_IS: "Use As-Is",
  REWORK: "Rework",
  SCRAP: "Scrap",
  RETURN_TO_VENDOR: "Return to Vendor",
  NOT_APPLICABLE: "N/A",
};

export const DELETABLE_STATUSES = ["DRAFT", "REJECTED", "CLOSED"];

export const approvalStatusConfig: Record<
  string,
  { label: string; variant: "muted" | "warning" | "success" | "error" | "purple" }
> = {
  PENDING: { label: "Pending", variant: "warning" },
  APPROVED: { label: "Approved", variant: "success" },
  REJECTED: { label: "Rejected", variant: "error" },
  RECALLED: { label: "Recalled", variant: "muted" },
  REWORK: { label: "Rework", variant: "purple" },
  WAITING: { label: "Waiting", variant: "muted" },
};

export const modeLabels: Record<string, string> = {
  ANY: "Any one member",
  ALL: "All members",
  MAJORITY: "Majority",
};
