import { describe, it, expect } from "vitest";
import {
  formatEffectivity,
  validateEffectivity,
  toDateInputValue,
  fromDateInputValue,
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
