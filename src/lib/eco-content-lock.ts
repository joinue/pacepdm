// Is a file or part locked by a change order, and may a file change right now.
//
// `implement_eco` releases what an ECO carries as it stands at the moment of
// implementation: the files listed on it, and every file linked to a part
// listed on it. Reviewers approve what they saw. So from submission until
// implementation that content has to stay exactly as it was — the same rule
// `bom-lock.ts` applies to carried BOMs, and for the same reason.
//
// Only a file's own lifecycle transition used to lock it (`pending-approval`).
// A drawing checked in after its ECO was approved was what implement released,
// unreviewed; a drawing moved to the trash was released from the trash; and a
// file linked to a carried part after approval was released without anyone
// having seen it (AUD-003 CHG-2).
//
// Every route that changes a file's content, identity or state asks
// `fileChangeRefusal`, and every route that changes a part's file links asks
// `lockingEcoForPart`, so the answer cannot differ between them.

import { getServiceClient } from "@/lib/db";
import { selectAllIn } from "@/lib/paged-query";
import { pendingApprovalRefusal } from "@/lib/pending-approval";
import { ECO_STATES_LOCKING_CARRIED_BOMS, ECO_STATUS_LABELS } from "@/lib/status-flows";

export interface LockingEco {
  id: string;
  ecoNumber: string;
  status: string;
}

/**
 * The ECO statuses that lock carried content: submitted, in review, approved.
 * Shared with carried BOMs. Draft is still being authored; rework and recall
 * return an ECO to Draft, which releases the lock until it is submitted again.
 */
const LOCKING_STATUSES = [...ECO_STATES_LOCKING_CARRIED_BOMS];

/** The first of these ECOs, in the caller's tenant, that locks what it carries. */
async function firstLockingEco(tenantId: string, ecoIds: string[]): Promise<LockingEco | null> {
  if (ecoIds.length === 0) return null;
  const db = getServiceClient();
  const ecos = await selectAllIn<LockingEco>(ecoIds, (chunk, from, to) =>
    db
      .from("ecos")
      .select("id, ecoNumber, status")
      .eq("tenantId", tenantId)
      .in("id", chunk)
      .in("status", LOCKING_STATUSES)
      .is("deletedAt", null)
      .order("id")
      .range(from, to)
  );
  return ecos[0] ?? null;
}

function throwOn(error: { message: string } | null, what: string) {
  if (error) throw new Error(`Could not check whether ${what}: ${error.message}`);
}

/**
 * The ECO locking this part's file links, if any: one that lists the part and
 * is submitted, in review or approved. Linking or unlinking a file there would
 * change what implement releases.
 *
 * Throws on a failed lookup: failing open is the bug this closes.
 */
export async function lockingEcoForPart(
  tenantId: string,
  partId: string
): Promise<LockingEco | null> {
  const { data, error } = await getServiceClient()
    .from("eco_items")
    .select("ecoId")
    .eq("partId", partId);
  throwOn(error, "the part is on a change order");
  return firstLockingEco(tenantId, [...new Set((data ?? []).map((r) => r.ecoId as string))]);
}

/**
 * The ECO locking this file, if any: one that lists the file, or lists a part
 * the file is linked to, and is submitted, in review or approved.
 *
 * Throws on a failed lookup.
 */
export async function lockingEcoForFile(
  tenantId: string,
  fileId: string
): Promise<LockingEco | null> {
  const db = getServiceClient();
  const [{ data: direct, error: directError }, { data: links, error: linkError }] =
    await Promise.all([
      db.from("eco_items").select("ecoId").eq("fileId", fileId),
      db.from("part_files").select("partId").eq("fileId", fileId),
    ]);
  throwOn(directError, "the file is on a change order");
  throwOn(linkError, "the file is linked to a part on a change order");

  const ecoIds = new Set((direct ?? []).map((r) => r.ecoId as string));
  const partIds = [...new Set((links ?? []).map((r) => r.partId as string))];
  if (partIds.length > 0) {
    const viaParts = await selectAllIn<{ id: string; ecoId: string }>(partIds, (chunk, from, to) =>
      db.from("eco_items").select("id, ecoId").in("partId", chunk).order("id").range(from, to)
    );
    for (const item of viaParts) ecoIds.add(item.ecoId);
  }
  return firstLockingEco(tenantId, [...ecoIds]);
}

export function ecoLockMessage(eco: LockingEco, subject: string, action: string): string {
  const status = ECO_STATUS_LABELS[eco.status] ?? eco.status;
  return (
    `${subject} is on ${eco.ecoNumber}, which is ${status} and will release it as it stands, ` +
    `so it cannot be ${action} until the ECO is implemented, or recalled or sent back for rework.`
  );
}

/**
 * Why a file may not change right now, or null if it may.
 *
 * Two locks, either of which refuses: a lifecycle transition on the file
 * awaiting approval, and a change order that will release the file.
 *
 * @param action what the caller was refused, phrased to follow "cannot be" —
 *   e.g. "checked out", "given a new version", "moved to the trash".
 */
export async function fileChangeRefusal(
  tenantId: string,
  fileId: string,
  action: string
): Promise<string | null> {
  const pending = await pendingApprovalRefusal(tenantId, fileId, action);
  if (pending) return pending;
  const eco = await lockingEcoForFile(tenantId, fileId);
  return eco ? ecoLockMessage(eco, "This file", action) : null;
}
