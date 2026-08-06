/**
 * Effectivity: when a change takes effect.
 *
 * `ecos.effectivity` has always been a free-text field — "Immediate", "Next
 * lot", "SN 500+". People wrote sensible things in it and nothing could read
 * them, so "what is in effect on 1 March" and "which BOM shipped on unit 47"
 * were both unanswerable. Migration 046 added typed columns beside it.
 *
 * The prose field stays, and stays editable, for the caveats that never fit
 * a schema ("after existing stock is consumed, confirm with production").
 * The typed fields carry the part a query needs.
 */

export type EffectivityType = "IMMEDIATE" | "DATE" | "SERIAL" | "USE_UP";

export interface Effectivity {
  effectivityType?: EffectivityType | null;
  effectiveFrom?: string | null;
  effectiveSerial?: string | null;
}

export const EFFECTIVITY_LABELS: Record<EffectivityType, string> = {
  IMMEDIATE: "Immediately on implementation",
  DATE: "From a date",
  SERIAL: "From a serial number",
  USE_UP: "When existing stock is used up",
};

/**
 * Deliberately not a free list: every extra option is one more thing a
 * downstream reader has to understand.
 *
 * `USE_UP` was added because its absence was making the field lie. It is the
 * most common case in equipment manufacture — production keeps building the old
 * design until existing stock is consumed, then switches — and with only
 * IMMEDIATE, DATE and SERIAL on offer, anyone recording such a change invented
 * a date reality would not honour, or left the field blank.
 *
 * `DATE` and `SERIAL` stay even where a tenant never uses them. Serial
 * effectivity is standard in aerospace and medical devices; date cutoffs are
 * normal wherever a regulation or a supplier contract sets one. This is a
 * multi-tenant product, and removing an option because one customer does not
 * use it is not a product decision.
 */
export const EFFECTIVITY_TYPES: EffectivityType[] = ["IMMEDIATE", "DATE", "SERIAL", "USE_UP"];

/**
 * Whether this app can answer "is it in effect?" for a given type, or whether
 * the trigger lives somewhere it cannot see.
 *
 * `SERIAL` needs the unit's serial number and `USE_UP` needs inventory levels.
 * Both live in the ERP and always will, so no query here can resolve them —
 * and one that appeared to would produce a confident answer that is wrong in
 * practice, which is worse than the absence. For those two the app displays the
 * recorded intent and says where the answer lives.
 *
 * See docs/decisions/erp-ownership.md.
 */
export function isComputable(type: EffectivityType | null | undefined): boolean {
  return type === "IMMEDIATE" || type === "DATE";
}

/**
 * Where to go for the answer, when this app cannot give one. Null for the
 * types it can resolve itself.
 */
export function deferralNote(value: Effectivity): string | null {
  switch (value.effectivityType) {
    case "SERIAL":
      return "Check the unit's serial number in your ERP to see whether this applies to it.";
    case "USE_UP":
      return "Takes effect once existing stock is consumed — check inventory in your ERP.";
    default:
      return null;
  }
}

/**
 * Mirrors the two `.refine()` rules on the ECO update schema so the form can
 * refuse before a round trip. The server still validates — this is an
 * affordance, not the boundary.
 */
export function validateEffectivity(value: Effectivity): string | null {
  if (value.effectivityType === "DATE" && !value.effectiveFrom) {
    return "Pick the date the change takes effect.";
  }
  if (value.effectivityType === "SERIAL" && !value.effectiveSerial?.trim()) {
    return "Enter the serial number the change starts at.";
  }
  return null;
}

/**
 * One line describing when the change applies, or null when nothing typed
 * has been set. Callers render the prose note separately — it supplements
 * this rather than replacing it.
 */
export function formatEffectivity(value: Effectivity): string | null {
  switch (value.effectivityType) {
    case "IMMEDIATE":
      return "Immediately on implementation";
    case "DATE": {
      if (!value.effectiveFrom) return null;
      const date = new Date(value.effectiveFrom);
      if (Number.isNaN(date.getTime())) return null;
      return `From ${date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })}`;
    }
    case "SERIAL":
      return value.effectiveSerial?.trim() ? `From serial ${value.effectiveSerial.trim()}` : null;
    case "USE_UP":
      return "When existing stock is used up";
    default:
      return null;
  }
}

/**
 * `<input type="date">` speaks `YYYY-MM-DD`; the column is a timestamp. Both
 * conversions go through UTC midnight so a date entered in one timezone is
 * not read back as the day before in another — effectivity is a calendar
 * date, not an instant.
 */
export function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export function fromDateInputValue(value: string): string | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
