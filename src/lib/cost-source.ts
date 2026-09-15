import type { ScopedDb } from "@/lib/tenant-db";

/**
 * Who is allowed to write `parts.unitCost`.
 *
 * There are two cost fields on a part and the difference is authority, not
 * precision:
 *
 *   - `estimatedCost` — an engineer's figure. Always writable. Never
 *     authoritative, never pushed to an ERP.
 *   - `unitCost` — the real number. Writable while `costSource` is `OPEN`;
 *     read-only once it is `LOCKED`, leaving an ERP sync as the only writer.
 *
 * A tenant with no ERP leaves it `OPEN` and `unitCost` is simply their cost —
 * which is why the field was not just relabelled as an estimate. A tenant with
 * NetSuite locks it, and from then on nothing typed into a form can overwrite
 * what Finance believes.
 *
 * See docs/decisions/erp-ownership.md.
 */

export const COST_SOURCE_KEY = "costSource";

export type CostSource = "OPEN" | "LOCKED";

/**
 * Read the tenant's setting. Defaults to `OPEN` on a missing row, a missing
 * key, an unrecognised value, or a read failure.
 *
 * Failing open is deliberate, and unlike a permission check it is not even a
 * close call: the consequence of getting this wrong is an editable number in a
 * form. Failing closed would make every part read-only across the tenant the
 * moment a settings read hiccuped, which looks exactly like data loss to
 * whoever is mid-edit.
 */
export async function getCostSource(
  // Only `from` is used, so both the scoped client and the raw service client
  // (in routes not yet converted) fit.
  db: Pick<ScopedDb, "from">,
  tenantId: string
): Promise<CostSource> {
  const { data } = await db.from("tenants").select("settings").eq("id", tenantId).maybeSingle();
  const settings = (data?.settings as Record<string, unknown> | null) ?? {};
  return settings[COST_SOURCE_KEY] === "LOCKED" ? "LOCKED" : "OPEN";
}

/**
 * Would writing `next` change a part's `unitCost` from `current`?
 *
 * The lock is on *changing* the figure, not on the key appearing in a request.
 * The part form sends every field it shows, cost included, so refusing any body
 * that named `unitCost` made every part uneditable — name, description,
 * anything — the moment a tenant locked cost. `undefined` means the request
 * says nothing about cost; `null` means "no cost", and clearing a cost that is
 * set is a change like any other.
 */
export function unitCostWouldChange(
  current: number | null | undefined,
  next: number | null | undefined
): boolean {
  if (next === undefined) return false;
  const before = current ?? null;
  if (before === null || next === null) return before !== next;
  return Number(before) !== next;
}

/**
 * The note an import attaches to a row whose unit cost it did not write,
 * because cost is locked. Says what happened to the value and why, so a sheet
 * of costs that did not land is not mistaken for one that did.
 */
export function unitCostNotImportedNote(raw: string): string {
  return (
    `Unit cost "${raw}" was not imported: unit cost is locked in this workspace ` +
    `and is set by the connected cost system.`
  );
}

/**
 * The refusal message. Names the setting and points at the field that *is*
 * writable, so the answer to "then where do I put my number" is in the error
 * rather than in somebody's head.
 */
export const UNIT_COST_LOCKED_MESSAGE =
  "Unit cost is locked in this workspace and is set by the connected cost " +
  "system. Put your figure in Estimated cost instead, or ask an admin to " +
  'change "Cost source" under Admin → Settings.';
