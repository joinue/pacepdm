// Display variants and labels for BOM status, file lifecycle state, and
// part category.
//
// Status tone and status label are NOT defined here — they come from the
// single definitions in components/ui/status-badge.tsx and lib/status-flows.ts,
// because the same BOM status is rendered on this page, in global search, in
// the search results page, and in the vault. Four copies is how they drift.
// Only the part-category map below is genuinely local to BOMs.

import { STATUS_TONES } from "@/components/ui/status-badge";
import { BOM_STATUS_LABELS } from "@/lib/status-flows";

export const statusVariants = STATUS_TONES.bom;
export const statusLabels = BOM_STATUS_LABELS;
export const stateVariants = STATUS_TONES.lifecycle;

export const categoryVariants: Record<string, "info" | "success" | "muted" | "warning" | "purple"> =
  {
    MANUFACTURED: "info",
    PURCHASED: "success",
    STANDARD_HARDWARE: "muted",
    RAW_MATERIAL: "warning",
    SUB_ASSEMBLY: "purple",
  };
