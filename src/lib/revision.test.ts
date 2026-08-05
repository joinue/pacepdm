import { describe, it, expect } from "vitest";
import { nextRevision, usesReservedLetter } from "./revision";

/**
 * These are the cases the old `charCodeAt(0) + 1` got wrong, plus the ones
 * it happened to get right. Every failure it had was silent — it wrote a
 * corrupt revision rather than refusing — so the refusals matter as much as
 * the increments.
 */

describe("nextRevision — alphabetic", () => {
  it("increments within the alphabet", () => {
    expect(nextRevision("A")?.next).toBe("B");
    expect(nextRevision("B")?.next).toBe("C");
  });

  it("skips the letters ASME Y14.35 reserves", () => {
    // I and O read as 1 and 0, Q as O, S as 5, X is experimental, Z as 2.
    expect(nextRevision("H")?.next).toBe("J"); // not I
    expect(nextRevision("N")?.next).toBe("P"); // not O
    expect(nextRevision("P")?.next).toBe("R"); // not Q
    expect(nextRevision("R")?.next).toBe("T"); // not S
    expect(nextRevision("W")?.next).toBe("Y"); // not X
  });

  it("carries past the end of the alphabet instead of producing punctuation", () => {
    // The old implementation turned Z into "[".
    expect(nextRevision("Y")?.next).toBe("AA");
    expect(nextRevision("AA")?.next).toBe("AB");
    expect(nextRevision("AY")?.next).toBe("BA");
    expect(nextRevision("YY")?.next).toBe("AAA");
  });

  it("refuses a revision built from reserved letters", () => {
    // We cannot know what alphabet the author was using, so we do not guess.
    expect(nextRevision("S")).toBeNull();
    expect(nextRevision("Z")).toBeNull();
  });
});

describe("nextRevision — numeric and prefixed", () => {
  it("increments a plain integer", () => {
    expect(nextRevision("1")).toEqual({ scheme: "numeric", next: "2" });
    expect(nextRevision("9")?.next).toBe("10");
  });

  it("preserves zero padding", () => {
    expect(nextRevision("09")?.next).toBe("10");
    expect(nextRevision("009")?.next).toBe("010");
    expect(nextRevision("099")?.next).toBe("100");
  });

  it("increments PACE's own R<n> scheme instead of mangling it", () => {
    // The old code turned R2 into "S" — it dropped the digit entirely and
    // moved the prefix. These come straight from the NANO-1000S build list.
    expect(nextRevision("R2")).toEqual({ scheme: "prefixed", next: "R3" });
    expect(nextRevision("R4")?.next).toBe("R5");
    expect(nextRevision("R9")?.next).toBe("R10");
  });

  it("handles a longer prefix and keeps its padding", () => {
    expect(nextRevision("Rev09")?.next).toBe("Rev10");
    expect(nextRevision("REV-01")?.next).toBe("REV-02");
  });
});

describe("nextRevision — refusals", () => {
  it("returns null rather than inventing a revision", () => {
    for (const input of ["", "   ", "1.2", "A-", "2A", "A B", "–"]) {
      expect(nextRevision(input), `expected null for ${JSON.stringify(input)}`).toBeNull();
    }
  });

  it("handles null and undefined", () => {
    expect(nextRevision(null)).toBeNull();
    expect(nextRevision(undefined)).toBeNull();
  });

  it("trims surrounding whitespace before deciding", () => {
    expect(nextRevision(" A ")?.next).toBe("B");
  });
});

describe("usesReservedLetter", () => {
  it("identifies revisions a standards-following shop would not issue", () => {
    expect(usesReservedLetter("S")).toBe(true);
    expect(usesReservedLetter("Z")).toBe(true);
    expect(usesReservedLetter("AI")).toBe(true);
  });

  it("does not flag valid alphabetic revisions", () => {
    expect(usesReservedLetter("A")).toBe(false);
    expect(usesReservedLetter("AY")).toBe(false);
  });

  it("does not flag non-alphabetic schemes", () => {
    // R2 is a fact about the source system, not a violation to report.
    expect(usesReservedLetter("R2")).toBe(false);
    expect(usesReservedLetter("1")).toBe(false);
  });
});
