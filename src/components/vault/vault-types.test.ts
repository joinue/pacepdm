import { describe, it, expect } from "vitest";
import { formatFileSize, needsNeutralExport, isNeutralCadFile } from "./vault-types";

/**
 * `needsNeutralExport` decides whether the upload dialog nudges someone to
 * attach a STEP. Getting it wrong in one direction nags on every upload; in
 * the other it silently lets a vault fill with files nobody can look inside.
 */
describe("needsNeutralExport", () => {
  it.each(["bracket.sldprt", "gearbox.sldasm", "layout.slddrw"])(
    "flags %s, which can only ever render as a 2D bitmap",
    (name) => {
      expect(needsNeutralExport(name)).toBe(true);
    }
  );

  it("is case-insensitive, because Windows writes .SLDPRT", () => {
    expect(needsNeutralExport("BRACKET.SLDPRT")).toBe(true);
    expect(needsNeutralExport("Bracket.SldPrt")).toBe(true);
  });

  it.each(["bracket.step", "bracket.stp", "bracket.iges", "model.stl", "model.obj"])(
    "does not flag %s, which the viewer opens directly",
    (name) => {
      expect(needsNeutralExport(name)).toBe(false);
    }
  );

  it.each(["drawing.pdf", "notes.txt", "sheet.csv", "photo.png"])(
    "does not flag %s, which is not CAD at all",
    (name) => {
      expect(needsNeutralExport(name)).toBe(false);
    }
  );

  /** A name containing the string but not as its extension is not a match. */
  it("matches on the extension, not on the name containing it", () => {
    expect(needsNeutralExport("sldprt-notes.txt")).toBe(false);
    expect(needsNeutralExport("about-sldasm.pdf")).toBe(false);
  });

  it("handles a file with no extension", () => {
    expect(needsNeutralExport("README")).toBe(false);
    expect(needsNeutralExport("")).toBe(false);
  });

  it("uses the last extension on a multi-dotted name", () => {
    expect(needsNeutralExport("bracket.rev-b.sldprt")).toBe(true);
    expect(needsNeutralExport("bracket.sldprt.bak")).toBe(false);
  });
});

describe("isNeutralCadFile", () => {
  it.each(["a.step", "a.stp", "a.iges", "a.igs", "a.stl", "a.obj"])("accepts %s", (name) => {
    expect(isNeutralCadFile(name)).toBe(true);
  });

  it("rejects native SolidWorks documents", () => {
    expect(isNeutralCadFile("bracket.sldprt")).toBe(false);
  });

  /** The two sets must not overlap, or a file would be both. */
  it("never agrees with needsNeutralExport", () => {
    for (const name of ["a.sldprt", "a.sldasm", "a.slddrw", "a.step", "a.stl", "a.pdf"]) {
      expect(isNeutralCadFile(name) && needsNeutralExport(name)).toBe(false);
    }
  });
});

describe("formatFileSize", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1048575, "1024.0 KB"],
    [1048576, "1.0 MB"],
    [5 * 1048576, "5.0 MB"],
  ])("renders %i bytes as %s", (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });
});
