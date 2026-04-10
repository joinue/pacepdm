// Display variants and labels for BOM status, file lifecycle state, and
// part category. Kept here so badge styling stays consistent across the
// page, sub-components, and any future export views.

export const statusVariants: Record<string, "muted" | "info" | "warning" | "success" | "purple"> = {
  DRAFT: "muted",
  IN_REVIEW: "warning",
  APPROVED: "info",
  RELEASED: "success",
  OBSOLETE: "purple",
};

export const statusLabels: Record<string, string> = {
  DRAFT: "Draft",
  IN_REVIEW: "In Review",
  APPROVED: "Approved",
  RELEASED: "Released",
  OBSOLETE: "Obsolete",
};

export const stateVariants: Record<string, "warning" | "info" | "success" | "error"> = {
  WIP: "warning",
  "In Review": "info",
  Released: "success",
  Obsolete: "error",
};

export const categoryVariants: Record<string, "info" | "success" | "muted" | "warning" | "purple"> = {
  MANUFACTURED: "info",
  PURCHASED: "success",
  STANDARD_HARDWARE: "muted",
  RAW_MATERIAL: "warning",
  SUB_ASSEMBLY: "purple",
};
