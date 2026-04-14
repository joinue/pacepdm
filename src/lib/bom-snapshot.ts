// BOM baseline snapshots.
//
// The `captureBomSnapshot` function reads every item currently on a BOM
// along with its joined part/file data, denormalizes it into a JSONB
// payload, computes a few rollup metrics, and writes a single
// `bom_snapshots` row. It's called from:
//
//   - PUT /api/boms/[bomId] when the status transitions to RELEASED
//     (automatic baseline)
//   - A future "Capture baseline" UI action (manual baseline)
//
// The snapshot payload is the canonical shape the read-side UI expects
// — see `BomSnapshotItem` below. It intentionally flattens the joins so
// that deleting a part later doesn't break old snapshots. The price is
// some storage duplication, which is fine at PDM scale.

import { v4 as uuid } from "uuid";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Each line item frozen in time. Joined part/file fields are inlined. */
export interface BomSnapshotItem {
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
  /** Snapshotted part data (null for free-text / file-only items). */
  part: {
    id: string;
    partNumber: string;
    name: string;
    revision: string;
    lifecycleState: string;
    category: string;
    material: string | null;
    unit: string | null;
    unitCost: number | null;
  } | null;
  /** Snapshotted file data (null for part-only items). */
  file: {
    id: string;
    name: string;
    partNumber: string | null;
    revision: string;
    lifecycleState: string;
  } | null;
  /** Pointer to a sub-BOM if this row was a sub-assembly link. */
  linkedBom: {
    id: string;
    name: string;
    revision: string;
    status: string;
  } | null;
}

/** Flat rollup totals captured at snapshot time. */
export interface BomSnapshotMetrics {
  itemCount: number;
  /** Sum of `quantity * unitCost` across every line that has both. */
  flatTotalCost: number;
  /** Three-letter currency code picked from the first item that reports one. */
  currency: string | null;
}

export interface BomSnapshotPayload {
  items: BomSnapshotItem[];
  metrics: BomSnapshotMetrics;
}

export type SnapshotTrigger = "RELEASE" | "MANUAL" | "ECO_IMPLEMENT";

export interface CaptureBomSnapshotArgs {
  db: SupabaseClient;
  tenantId: string;
  bomId: string;
  /** The user responsible for this snapshot (null-safe for system actions). */
  userId: string | null;
  trigger: SnapshotTrigger;
  /** Optional: the ECO that caused this snapshot (set when trigger = ECO_IMPLEMENT). */
  ecoId?: string | null;
  /** Optional free-text note (only surfaced for MANUAL snapshots today). */
  note?: string | null;
}

export interface CaptureBomSnapshotResult {
  snapshotId: string;
  itemCount: number;
  flatTotalCost: number;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Read the current state of a BOM and write it to `bom_snapshots` as an
 * immutable baseline. Throws on any DB error — callers should decide
 * whether a baseline failure is fatal (it isn't, for automatic
 * release-triggered snapshots) or should surface to the user.
 */
export async function captureBomSnapshot(
  args: CaptureBomSnapshotArgs
): Promise<CaptureBomSnapshotResult> {
  const { db, tenantId, bomId, userId, trigger, ecoId, note } = args;

  // Step 1: read the BOM itself so we can denormalize name/revision/status
  // into the snapshot row (not relying on the live BOM for display).
  const { data: bom, error: bomError } = await db
    .from("boms")
    .select("id, tenantId, name, revision, status")
    .eq("id", bomId)
    .maybeSingle();
  if (bomError) throw bomError;
  if (!bom || bom.tenantId !== tenantId) {
    throw new Error("BOM not found or not in tenant");
  }

  // Step 2: read every item with the same joins the live items GET uses,
  // so the snapshot shape matches what the UI is already familiar with.
  // Sub-BOM linkage is intentionally followed one level only — a baseline
  // captures this BOM as it is, not the transitive tree. The parent-child
  // rollup can re-walk from any snapshot because linkedBom.id is stored.
  const { data: rawItemsData, error: itemsError } = await db
    .from("bom_items")
    .select(
      "id, itemNumber, partNumber, name, description, quantity, unit, level, parentItemId, material, vendor, unitCost, sortOrder, " +
        "part:parts!bom_items_partId_fkey(id, partNumber, name, revision, lifecycleState, category, material, unit, unitCost, currency), " +
        "file:files!bom_items_fileId_fkey(id, name, partNumber, revision, lifecycleState), " +
        "linkedBom:boms!bom_items_linkedBomId_fkey(id, name, revision, status)"
    )
    .eq("bomId", bomId)
    .order("sortOrder");
  if (itemsError) throw itemsError;

  // Supabase's generated type narrows to an error shape when an embed
  // string gets complicated; the runtime rows are fine. Cast once to a
  // loose row shape so the mapper below can read known columns without
  // fighting the compiler per-field.
  const rawItems = (rawItemsData ?? []) as unknown as Array<Record<string, unknown>>;

  const items: BomSnapshotItem[] = rawItems.map((r) => {
    // Supabase returns joined rows as a single object OR a single-element
    // array depending on FK cardinality; normalize both shapes up front.
    const part = narrowJoin(r.part) as
      | {
          id: string;
          partNumber: string;
          name: string;
          revision: string;
          lifecycleState: string;
          category: string;
          material: string | null;
          unit: string | null;
          unitCost: number | null;
        }
      | null;
    const file = narrowJoin(r.file) as
      | {
          id: string;
          name: string;
          partNumber: string | null;
          revision: string;
          lifecycleState: string;
        }
      | null;
    const linkedBom = narrowJoin(r.linkedBom) as
      | { id: string; name: string; revision: string; status: string }
      | null;

    return {
      id: r.id as string,
      itemNumber: (r.itemNumber as string) ?? "",
      partNumber: (r.partNumber as string | null) ?? null,
      name: (r.name as string) ?? "",
      description: (r.description as string | null) ?? null,
      quantity: (r.quantity as number) ?? 0,
      unit: (r.unit as string) ?? "EA",
      level: (r.level as number) ?? 0,
      parentItemId: (r.parentItemId as string | null) ?? null,
      material: (r.material as string | null) ?? null,
      vendor: (r.vendor as string | null) ?? null,
      unitCost: (r.unitCost as number | null) ?? null,
      sortOrder: (r.sortOrder as number) ?? 0,
      part,
      file,
      linkedBom,
    };
  });

  // Step 3: compute flat rollup metrics. This is the cheap/flat total
  // (quantity × unitCost per line); the full tree rollup lives in
  // `bom-rollup.ts` and is re-runnable from the snapshot if needed.
  let flatTotalCost = 0;
  let currency: string | null = null;
  for (const item of items) {
    // Prefer the live part's unitCost+currency (which was captured just
    // now anyway) over the denormalized bom_items columns. Matches the
    // logic in the existing items GET endpoint.
    const cost =
      (item.part?.unitCost ?? item.unitCost) != null
        ? (item.part?.unitCost ?? item.unitCost) as number
        : 0;
    flatTotalCost += cost * (item.quantity || 0);
    if (!currency) {
      const partAsAny = item.part as unknown as { currency?: string | null } | null;
      if (partAsAny?.currency) currency = partAsAny.currency;
    }
  }
  const metrics: BomSnapshotMetrics = {
    itemCount: items.length,
    flatTotalCost,
    currency,
  };

  // Step 4: write the snapshot row. We do NOT serialize to a TEXT blob —
  // Supabase accepts a JS object for jsonb columns and the payload size
  // is bounded by the live BOM's item count.
  const id = uuid();
  const payload: BomSnapshotPayload = { items, metrics };
  const { error: insertError } = await db.from("bom_snapshots").insert({
    id,
    tenantId,
    bomId,
    bomName: bom.name,
    bomRevision: bom.revision,
    bomStatus: bom.status,
    trigger,
    ecoId: ecoId ?? null,
    items: payload.items,
    metrics: payload.metrics,
    snapshotAt: new Date().toISOString(),
    createdById: userId,
    note: note ?? null,
  });
  if (insertError) throw insertError;

  return { snapshotId: id, itemCount: items.length, flatTotalCost };
}

/**
 * Normalize Supabase's loose join cardinality (single object vs
 * single-element array) into `T | null`. Used for every `part:`,
 * `file:`, `linkedBom:` embed in this file.
 */
function narrowJoin<T>(raw: unknown): T | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return (raw[0] as T) ?? null;
  return raw as T;
}
