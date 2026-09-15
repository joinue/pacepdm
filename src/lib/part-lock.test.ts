import { describe, it, expect } from "vitest";
import { partEditRefusal, changedFields, lockedFieldsTouched } from "./part-lock";

/**
 * A part's revision and lifecycle state are the release record a supplier
 * sees. Anyone with `file.edit` could set either, and a Released part stayed
 * fully editable, so `PN-1042 rev C Released` could exist with no approver
 * behind it (AUD-003 CHG-4).
 */

const released = { partNumber: "PN-1042", lifecycleState: "Released", name: "Idler", unit: "EA" };
const wip = { ...released, lifecycleState: "WIP" };

describe("partEditRefusal", () => {
  it("leaves a part in WIP alone", () => {
    expect(partEditRefusal(wip, { name: "Idler, left" }, false)).toBeNull();
  });

  it("refuses a design change once the part is released, and says what to do", () => {
    const refusal = partEditRefusal(released, { name: "Idler, left" }, false);
    expect(refusal).toMatch(/PN-1042 is Released, so its name cannot be changed here/);
    expect(refusal).toMatch(/Raise an ECO/);
  });

  it("names every locked field the update touches", () => {
    const refusal = partEditRefusal(released, { name: "Idler, left", unit: "M", weight: 2 }, false);
    expect(refusal).toMatch(/its name, weight and unit cannot be changed/);
  });

  it("still allows cost, currency and notes on a released part", () => {
    expect(partEditRefusal(released, { unitCost: 9.99, notes: "Second source" }, false)).toBeNull();
  });

  it("ignores a field sent unchanged, which the part form always does", () => {
    expect(partEditRefusal(released, { name: "Idler", unitCost: 9.99 }, false)).toBeNull();
  });

  it("lets an admin fix a mistake, as on a frozen file", () => {
    expect(partEditRefusal(released, { name: "Idler, left" }, true)).toBeNull();
  });

  it("locks an obsolete part too — anything that has left WIP", () => {
    const obsolete = { ...released, lifecycleState: "Obsolete" };
    expect(partEditRefusal(obsolete, { name: "x" }, false)).toMatch(/is Obsolete/);
  });
});

describe("lockedFieldsTouched", () => {
  it("reports the design fields only", () => {
    expect(lockedFieldsTouched(released, { name: "x", notes: "y", unitCost: 1 })).toEqual(["name"]);
  });
});

describe("changedFields", () => {
  it("records what each value was, for the audit row", () => {
    expect(
      changedFields({ name: "Idler", unitCost: 4.25 }, { name: "Roller", unitCost: 4.25 })
    ).toEqual({ name: { from: "Idler", to: "Roller" } });
  });

  it("reads a missing value as null rather than dropping the field", () => {
    expect(changedFields({ name: "Idler" }, { notes: "Second source" })).toEqual({
      notes: { from: null, to: "Second source" },
    });
  });

  it("leaves out the bookkeeping the route adds", () => {
    expect(changedFields({ name: "Idler" }, { updatedAt: "2026-09-15T00:00:00Z" })).toEqual({});
  });
});
