import { describe, it, expect } from "vitest";
import {
  formatEffectivity,
  validateEffectivity,
  toDateInputValue,
  fromDateInputValue,
  EFFECTIVITY_TYPES,
  EFFECTIVITY_LABELS,
  isComputable,
  deferralNote,
} from "./effectivity";

describe("validateEffectivity", () => {
  it("requires a date for date effectivity", () => {
    expect(validateEffectivity({ effectivityType: "DATE" })).toMatch(/pick the date/i);
    expect(
      validateEffectivity({ effectivityType: "DATE", effectiveFrom: "2026-03-01T00:00:00.000Z" })
    ).toBeNull();
  });

  it("requires a serial for serial effectivity, and rejects whitespace", () => {
    expect(validateEffectivity({ effectivityType: "SERIAL" })).toMatch(/serial number/i);
    expect(validateEffectivity({ effectivityType: "SERIAL", effectiveSerial: "   " })).toMatch(
      /serial number/i
    );
    expect(
      validateEffectivity({ effectivityType: "SERIAL", effectiveSerial: "SN-500" })
    ).toBeNull();
  });

  it("asks nothing of immediate or unset effectivity", () => {
    expect(validateEffectivity({ effectivityType: "IMMEDIATE" })).toBeNull();
    expect(validateEffectivity({})).toBeNull();
  });

  it("ignores a stale value from another type", () => {
    // Switching SERIAL → IMMEDIATE leaves the old serial in form state; that
    // must not make the form invalid.
    expect(
      validateEffectivity({ effectivityType: "IMMEDIATE", effectiveSerial: "SN-500" })
    ).toBeNull();
  });
});

describe("formatEffectivity", () => {
  it("describes each type", () => {
    expect(formatEffectivity({ effectivityType: "IMMEDIATE" })).toBe(
      "Immediately on implementation"
    );
    expect(formatEffectivity({ effectivityType: "SERIAL", effectiveSerial: "SN-500" })).toBe(
      "From serial SN-500"
    );
    expect(
      formatEffectivity({ effectivityType: "DATE", effectiveFrom: "2026-03-01T00:00:00.000Z" })
    ).toMatch(/From .*2026/);
  });

  it("returns null when nothing typed is set", () => {
    expect(formatEffectivity({})).toBeNull();
    expect(formatEffectivity({ effectivityType: null })).toBeNull();
  });

  it("returns null rather than a broken string when the value is missing", () => {
    // An ECO saved before migration 046 has a type of null and no date.
    expect(formatEffectivity({ effectivityType: "DATE" })).toBeNull();
    expect(formatEffectivity({ effectivityType: "SERIAL", effectiveSerial: "  " })).toBeNull();
  });

  it("survives an unparseable date instead of rendering Invalid Date", () => {
    expect(formatEffectivity({ effectivityType: "DATE", effectiveFrom: "not a date" })).toBeNull();
  });
});

describe("date input round trip", () => {
  it("round-trips a calendar date without slipping a day", () => {
    // The bug this guards: parsing YYYY-MM-DD as local time then formatting
    // in UTC (or the reverse) moves the date by one in most of the world.
    const iso = fromDateInputValue("2026-03-01");
    expect(iso).toBe("2026-03-01T00:00:00.000Z");
    expect(toDateInputValue(iso)).toBe("2026-03-01");
  });

  it("handles the empty and invalid cases", () => {
    expect(fromDateInputValue("")).toBeNull();
    expect(toDateInputValue(null)).toBe("");
    expect(toDateInputValue(undefined)).toBe("");
    expect(toDateInputValue("not a date")).toBe("");
  });
});

// ── USE_UP, and what this app can and cannot answer ────────────────────────
//
// The enum offered IMMEDIATE, DATE and SERIAL, and the most common case in
// equipment manufacture is none of them: a change usually takes effect when
// existing stock of the old design is used up. With no value for it, anyone
// recording such a change invented a date reality would not honour, or left
// the field blank.

describe("USE_UP", () => {
  it("is offered as an option", () => {
    expect(EFFECTIVITY_TYPES).toContain("USE_UP");
  });

  it("describes itself in the terms production actually uses", () => {
    expect(EFFECTIVITY_LABELS.USE_UP).toBe("When existing stock is used up");
    expect(formatEffectivity({ effectivityType: "USE_UP" })).toBe("When existing stock is used up");
  });

  /** It needs no companion field — there is nothing to enter. */
  it("needs no extra value to be valid", () => {
    expect(validateEffectivity({ effectivityType: "USE_UP" })).toBeNull();
  });

  /**
   * DATE and SERIAL stay even though PACE will mostly use IMMEDIATE and
   * USE_UP. Serial effectivity is standard in aerospace and medical devices,
   * and date cutoffs are normal wherever a regulation sets one. This is a
   * multi-tenant product; removing an option because one customer does not use
   * it is not a product decision.
   */
  it("does not displace the other types", () => {
    expect(EFFECTIVITY_TYPES).toEqual(["IMMEDIATE", "DATE", "SERIAL", "USE_UP"]);
  });
});

describe("isComputable", () => {
  it.each(["IMMEDIATE", "DATE"] as const)("says this app can resolve %s", (type) => {
    expect(isComputable(type)).toBe(true);
  });

  /**
   * The trigger for both is in the ERP — a unit's serial number, or an
   * inventory level. No query here can resolve them, and one that appeared to
   * would give a confident answer that is wrong in practice.
   */
  it.each(["SERIAL", "USE_UP"] as const)("says this app cannot resolve %s", (type) => {
    expect(isComputable(type)).toBe(false);
  });

  it("treats an unset type as not computable", () => {
    expect(isComputable(null)).toBe(false);
    expect(isComputable(undefined)).toBe(false);
  });
});

describe("deferralNote", () => {
  it("sends a serial question to the ERP", () => {
    expect(deferralNote({ effectivityType: "SERIAL" })).toMatch(/serial number in your ERP/i);
  });

  it("sends a use-up question to inventory", () => {
    expect(deferralNote({ effectivityType: "USE_UP" })).toMatch(/inventory in your ERP/i);
  });

  it.each(["IMMEDIATE", "DATE"] as const)("adds nothing for %s, which resolves here", (type) => {
    expect(deferralNote({ effectivityType: type })).toBeNull();
  });

  it("adds nothing when no effectivity is set", () => {
    expect(deferralNote({})).toBeNull();
  });

  /** Every non-computable type must have a note, or the UI goes silent on it. */
  it("covers exactly the types isComputable rejects", () => {
    for (const type of EFFECTIVITY_TYPES) {
      const hasNote = deferralNote({ effectivityType: type }) !== null;
      expect(hasNote).toBe(!isComputable(type));
    }
  });
});
