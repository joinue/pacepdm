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

export type EffectivityType = "IMMEDIATE" | "DATE" | "SERIAL";

export interface Effectivity {
  effectivityType?: EffectivityType | null;
  effectiveFrom?: string | null;
  effectiveSerial?: string | null;
}

export const EFFECTIVITY_LABELS: Record<EffectivityType, string> = {
  IMMEDIATE: "Immediately on implementation",
  DATE: "From a date",
  SERIAL: "From a serial number",
};

/**
 * The two forms in general use, plus immediate. Deliberately not a free list:
 * every extra option is one more thing a downstream query has to understand,
 * and lot-based effectivity is a different model rather than a fourth entry.
 */
export const EFFECTIVITY_TYPES: EffectivityType[] = ["IMMEDIATE", "DATE", "SERIAL"];

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
