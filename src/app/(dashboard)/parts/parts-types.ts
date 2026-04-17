// Shared types and constants for the parts feature.

// --- Types ---

export interface Part {
  id: string;
  partNumber: string;
  name: string;
  description: string | null;
  category: string;
  revision: string;
  lifecycleState: string;
  material: string | null;
  weight: number | null;
  weightUnit: string;
  unitCost: number | null;
  currency: string;
  unit: string;
  thumbnailUrl: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PartDetail extends Part {
  vendors: PartVendorLink[];
  files: {
    id: string;
    fileId: string;
    role: string;
    isPrimary: boolean;
    file: {
      id: string;
      name: string;
      partNumber: string | null;
      revision: string;
      lifecycleState: string;
      fileType: string;
    };
  }[];
  whereUsed: {
    bomId: string;
    bomName: string;
    bomRevision: string;
    bomStatus: string;
    quantity: number;
    unit: string;
  }[];
  ecoHistory: {
    ecoId: string;
    ecoNumber: string;
    title: string;
    status: string;
    implementedAt: string | null;
    createdAt: string;
    fromRevision: string | null;
    toRevision: string | null;
  }[];
}

// A row from `part_vendors` joined with the canonical `vendors` record.
// `vendor.name` is the source of truth for display; the legacy `vendorName`
// text column on part_vendors is kept in sync until migration 010 drops it.
export interface PartVendorLink {
  id: string;
  vendorId: string;
  vendor: { id: string; name: string } | null;
  vendorPartNumber: string | null;
  unitCost: number | null;
  currency: string;
  leadTimeDays: number | null;
  isPrimary: boolean;
  notes: string | null;
}

export interface VendorSearchResult {
  id: string;
  name: string;
}

// --- Constants ---

export const CATEGORIES = [
  { value: "MANUFACTURED", label: "Manufactured" },
  { value: "PURCHASED", label: "Purchased" },
  { value: "STANDARD_HARDWARE", label: "Standard Hardware" },
  { value: "RAW_MATERIAL", label: "Raw Material" },
  { value: "SUB_ASSEMBLY", label: "Sub-Assembly" },
] as const;

export const FILE_ROLE_LABELS: Record<string, string> = {
  DRAWING: "Drawing",
  MODEL_3D: "3D Model",
  SPEC_SHEET: "Spec Sheet",
  DATASHEET: "Datasheet",
  OTHER: "Other",
};

export const categoryVariants: Record<string, "info" | "success" | "muted" | "warning" | "purple"> = {
  MANUFACTURED: "info",
  PURCHASED: "success",
  STANDARD_HARDWARE: "muted",
  RAW_MATERIAL: "warning",
  SUB_ASSEMBLY: "purple",
};

export const stateVariants: Record<string, "warning" | "info" | "success" | "error"> = {
  WIP: "warning",
  "In Review": "info",
  Released: "success",
  Obsolete: "error",
};
