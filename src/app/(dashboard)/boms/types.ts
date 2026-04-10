// Types for the BOMs page and its sub-components.
//
// Kept in a separate file so the page component, dialogs, and list
// rendering can all import the same shapes without re-declaring them.

export interface BOM {
  id: string;
  name: string;
  revision: string;
  status: string;
  createdAt: string;
}

export interface BOMItem {
  id: string;
  itemNumber: string;
  partNumber: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  level: number;
  parentItemId: string | null;
  material: string | null;
  vendor: string | null;
  unitCost: number | null;
  sortOrder: number;
  partId: string | null;
  linkedBomId: string | null;
  file: {
    id: string;
    name: string;
    partNumber: string | null;
    revision: string;
    lifecycleState: string;
  } | null;
  part: {
    id: string;
    partNumber: string;
    name: string;
    category: string;
    thumbnailUrl: string | null;
    unitCost: number | null;
  } | null;
  linkedBom: {
    id: string;
    name: string;
    revision: string;
    status: string;
  } | null;
}

export interface FileSearchResult {
  id: string;
  name: string;
  partNumber: string | null;
  category: string;
  lifecycleState: string;
}

export interface PartSearchResult {
  id: string;
  partNumber: string;
  name: string;
  category: string;
  unitCost: number | null;
  thumbnailUrl: string | null;
}

/**
 * Shape returned by the `/api/boms/compare` endpoint. Two BOMs in, a
 * structured diff out: per-item changes plus aggregate counts and the
 * total-cost delta.
 */
export interface CompareResult {
  bomA: { name: string; revision: string; itemCount: number; totalCost: number };
  bomB: { name: string; revision: string; itemCount: number; totalCost: number };
  changes: { type: string; itemNumber: string; name: string; diffs: string[] }[];
  summary: { added: number; removed: number; changed: number; unchanged: number };
}

/**
 * Form fields for the Add Item dialog. Strings (not numbers) so the inputs
 * stay controlled even when temporarily empty during editing.
 */
export interface NewItemForm {
  itemNumber: string;
  partNumber: string;
  name: string;
  quantity: string;
  unit: string;
  material: string;
  vendor: string;
  unitCost: string;
  description: string;
}

export const EMPTY_NEW_ITEM: NewItemForm = {
  itemNumber: "",
  partNumber: "",
  name: "",
  quantity: "1",
  unit: "EA",
  material: "",
  vendor: "",
  unitCost: "",
  description: "",
};
