import { describe, it, expect } from "vitest";
import { unitCostWouldChange, unitCostNotImportedNote } from "./cost-source";

/**
 * A locked cost source forbids *changing* `unitCost`. It used to forbid the
 * key appearing in a request at all, and the part form always sends it, so a
 * locked tenant could not edit any part.
 */
describe("unitCostWouldChange", () => {
  it("is false when the request says nothing about cost", () => {
    expect(unitCostWouldChange(4.25, undefined)).toBe(false);
    expect(unitCostWouldChange(null, undefined)).toBe(false);
  });

  it("is false when the same figure is sent back", () => {
    expect(unitCostWouldChange(4.25, 4.25)).toBe(false);
    expect(unitCostWouldChange(0, 0)).toBe(false);
  });

  it("is false when a part with no cost is sent no cost", () => {
    expect(unitCostWouldChange(null, null)).toBe(false);
    expect(unitCostWouldChange(undefined, null)).toBe(false);
  });

  it("is true for a different figure", () => {
    expect(unitCostWouldChange(4.25, 4.5)).toBe(true);
  });

  it("is true for setting a cost where there was none, and for clearing one", () => {
    expect(unitCostWouldChange(null, 3)).toBe(true);
    expect(unitCostWouldChange(3, null)).toBe(true);
  });

  it("does not treat zero as no cost", () => {
    expect(unitCostWouldChange(null, 0)).toBe(true);
    expect(unitCostWouldChange(0, null)).toBe(true);
  });
});

describe("unitCostNotImportedNote", () => {
  it("names the value and the reason", () => {
    const note = unitCostNotImportedNote("4.25");
    expect(note).toContain('"4.25"');
    expect(note).toMatch(/locked/i);
  });
});
