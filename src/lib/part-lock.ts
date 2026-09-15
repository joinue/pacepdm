// What a part's revision and lifecycle state mean, and what a released part
// may still change.
//
// A part's revision and state are the release record: `PN-1042 rev C
// Released` is what a part share link, a release package and a BOM line all
// show a supplier. Both were writable through `PUT /api/parts/[partId]` and
// `POST /api/parts` by anyone with `file.edit`, and through a CSV re-import —
// so a part could be marked Released, or re-lettered, with no approver behind
// it and no ECO in its history (AUD-003 CHG-4).
//
// Only `implement_eco` sets them now (migration 056). Everything here is the
// app's half of that: the routes refuse to write either field, and a part that
// has left WIP refuses edits to the fields its release recorded.

import type { AuditValue } from "@/lib/audit";

/**
 * The fields a release records, and a supplier sees. Locked once the part
 * leaves WIP.
 *
 * `createReleaseFromEco` snapshots partNumber, name, revision, lifecycleState
 * and category; the rest are the design the drawing carries. Cost, currency,
 * notes and the thumbnail are deliberately not here: they are commercial and
 * descriptive, they are not in the manifest, and locking them would mean an
 * ECO to correct a supplier price.
 */
export const PART_DESIGN_FIELDS = [
  "partNumber",
  "name",
  "description",
  "category",
  "material",
  "weight",
  "weightUnit",
  "unit",
  "isEndItem",
] as const;

/** The part's state while it is still being designed, and the only one that is freely editable. */
export const PART_EDITABLE_STATE = "WIP";

export const PART_REVISION_REFUSAL =
  "A part's revision and lifecycle state are set by implementing an ECO, so they cannot be " +
  "edited here. Raise a change order for the part, or, for a part that has never been " +
  "released, correct it on the way in through the parts importer.";

const FIELD_LABELS: Record<string, string> = {
  partNumber: "part number",
  name: "name",
  description: "description",
  category: "category",
  material: "material",
  weight: "weight",
  weightUnit: "weight unit",
  unit: "unit",
  isEndItem: "end-item flag",
};

/** The design fields this update would actually change, in a readable order. */
export function lockedFieldsTouched(
  part: Record<string, unknown>,
  changes: Record<string, unknown>
): string[] {
  return PART_DESIGN_FIELDS.filter(
    (field) => changes[field] !== undefined && changes[field] !== part[field]
  ).map((field) => FIELD_LABELS[field] ?? field);
}

/**
 * Why this update to a part is refused, or null.
 *
 * Admins are exempt, as they are on a frozen file's metadata
 * (`files/[fileId]/metadata`): a typo in a released part's name should not
 * need a change order to fix, and an admin can already reach the same fields
 * another way. Revision and state are refused for everyone — that check is the
 * route's, before this one.
 *
 * @param isAdmin holder of the `*` permission.
 */
export function partEditRefusal(
  part: { partNumber: string; lifecycleState: string | null },
  changes: Record<string, unknown>,
  isAdmin: boolean
): string | null {
  if (isAdmin) return null;
  const state = part.lifecycleState ?? PART_EDITABLE_STATE;
  if (state === PART_EDITABLE_STATE) return null;

  const locked = lockedFieldsTouched(part as Record<string, unknown>, changes);
  if (locked.length === 0) return null;

  const list =
    locked.length === 1
      ? locked[0]
      : `${locked.slice(0, -1).join(", ")} and ${locked[locked.length - 1]}`;
  return (
    `${part.partNumber} is ${state}, so its ${list} cannot be changed here — that is what was ` +
    `released. Raise an ECO for the part, which sets the next revision when it is implemented. ` +
    `Cost, currency and notes can still be edited.`
  );
}

/** Each field this update changes, with the value it had — for the audit row. */
export function changedFields(
  part: Record<string, unknown>,
  changes: Record<string, unknown>
): Record<string, { from: AuditValue; to: AuditValue }> {
  const diff: Record<string, { from: AuditValue; to: AuditValue }> = {};
  for (const [field, value] of Object.entries(changes)) {
    if (field === "updatedAt" || value === undefined) continue;
    if (part[field] !== value) {
      diff[field] = { from: (part[field] ?? null) as AuditValue, to: value as AuditValue };
    }
  }
  return diff;
}
