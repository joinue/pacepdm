// Is a BOM's content locked, and why.
//
// "Content" is what a release puts into effect: the lines, and the name and
// revision that identify the structure. Two things lock it:
//
//   1. The BOM's own status. RELEASED and OBSOLETE are issued; changing
//      one means revising it, which creates a new row.
//   2. A change order carrying it. `implement_eco` (migration 049) releases
//      whatever a carried BOM holds at the moment of implementation, so a
//      BOM on a submitted, in-review or approved ECO has to stay exactly as
//      the reviewers saw it. Before this, only (1) was checked, and an
//      approved ECO would release lines edited after the approval.
//
// Status transitions are not content and are not gated here — they keep
// their own rules in PUT /api/boms/[bomId].
//
// Every route that writes `bom_items`, or a BOM's name or revision, asks
// this module rather than re-deriving the rule, so the answer cannot differ
// between the items editor, the relink repair and the header edit.

import type { ScopedDb } from "@/lib/tenant-db";
import {
  BOM_STATUS_LABELS,
  ECO_STATES_LOCKING_CARRIED_BOMS,
  ECO_STATUS_LABELS,
} from "@/lib/status-flows";

export type BomContentLock =
  | { reason: "status"; status: string; message: string }
  | {
      reason: "eco";
      ecoId: string;
      ecoNumber: string;
      ecoStatus: string;
      message: string;
    };

/** A BOM row the caller has already loaded through a tenant-filtered read. */
export interface LockableBom {
  id: string;
  status: string;
}

/**
 * Only `from` is used. Typed as the scoped client's surface so both the
 * scoped client and the raw service client (in routes not yet converted)
 * fit; tenant filters are applied explicitly either way.
 */
type Reader = Pick<ScopedDb, "from">;

const ISSUED_STATUSES = new Set(["RELEASED", "OBSOLETE"]);

function statusLock(status: string): BomContentLock {
  const label = BOM_STATUS_LABELS[status] ?? status;
  return {
    reason: "status",
    status,
    message:
      `This BOM is ${label}, so its lines, name and revision are locked. ` +
      `Revise it to make a change.`,
  };
}

function ecoLock(eco: { id: string; ecoNumber: string | null; status: string }): BomContentLock {
  const ecoNumber = eco.ecoNumber ?? eco.id;
  const label = ECO_STATUS_LABELS[eco.status] ?? eco.status;
  // The way out depends on where the ECO is. An approved ECO can only be
  // implemented; one still under review can be rejected back to its author.
  const wayOut =
    eco.status === "APPROVED"
      ? "To change it, implement the ECO and revise the BOM under a new change order."
      : "To change it, the ECO has to be rejected and reworked.";
  return {
    reason: "eco",
    ecoId: eco.id,
    ecoNumber,
    ecoStatus: eco.status,
    message:
      `This BOM is on ${ecoNumber}, which is ${label}, so its lines, name and ` +
      `revision are locked — implementing the ECO releases exactly what was ` +
      `reviewed. ${wayOut}`,
  };
}

/**
 * Locks for a set of BOMs, keyed by BOM id. BOMs that are free to edit are
 * absent from the map.
 *
 * `boms` must come from a read already filtered to `tenantId`: `eco_items`
 * has no tenant column and is queried by these ids. The ECOs are filtered
 * to `tenantId` here, so another tenant's ECO can never lock this tenant's
 * BOM.
 *
 * Fails closed: a query error throws rather than reporting "unlocked".
 */
export async function findBomContentLocks(
  db: Reader,
  tenantId: string,
  boms: LockableBom[]
): Promise<Map<string, BomContentLock>> {
  const locks = new Map<string, BomContentLock>();
  for (const bom of boms) {
    if (ISSUED_STATUSES.has(bom.status)) locks.set(bom.id, statusLock(bom.status));
  }

  const unissued = [...new Set(boms.filter((b) => !locks.has(b.id)).map((b) => b.id))];
  if (unissued.length === 0) return locks;

  const { data: carriedRows, error: carriedError } = await db
    .from("eco_items")
    .select("bomId, ecoId")
    .in("bomId", unissued);
  if (carriedError) {
    throw new Error(
      `Could not check whether the BOM is on a change order: ${carriedError.message}`
    );
  }
  const carried = (carriedRows ?? []) as Array<{ bomId: string | null; ecoId: string }>;
  const ecoIds = [...new Set(carried.map((r) => r.ecoId))];
  if (ecoIds.length === 0) return locks;

  const { data: ecoRows, error: ecoError } = await db
    .from("ecos")
    .select("id, ecoNumber, status")
    .eq("tenantId", tenantId)
    .is("deletedAt", null)
    .in("id", ecoIds)
    .in("status", [...ECO_STATES_LOCKING_CARRIED_BOMS]);
  if (ecoError) {
    throw new Error(`Could not check whether the BOM is on a change order: ${ecoError.message}`);
  }
  const ecos = (ecoRows ?? []) as Array<{ id: string; ecoNumber: string | null; status: string }>;

  // A BOM on more than one in-flight ECO names the lowest-numbered, so the
  // message is stable between requests.
  ecos.sort((a, b) => (a.ecoNumber ?? a.id).localeCompare(b.ecoNumber ?? b.id));
  for (const eco of ecos) {
    for (const row of carried) {
      if (row.ecoId === eco.id && row.bomId && !locks.has(row.bomId)) {
        locks.set(row.bomId, ecoLock(eco));
      }
    }
  }
  return locks;
}

/** The lock on one BOM, or null when its content may be edited. */
export async function getBomContentLock(
  db: Reader,
  tenantId: string,
  bom: LockableBom
): Promise<BomContentLock | null> {
  return (await findBomContentLocks(db, tenantId, [bom])).get(bom.id) ?? null;
}
