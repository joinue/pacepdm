import { describe, it, expect } from "vitest";
import { isSolidWorksFile } from "./thumbnail";

describe("isSolidWorksFile", () => {
  it("detects .sldprt files", () => {
    expect(isSolidWorksFile("bracket.sldprt")).toBe(true);
  });

  it("detects .sldasm files", () => {
    expect(isSolidWorksFile("assembly.sldasm")).toBe(true);
  });

  it("detects .slddrw files", () => {
    expect(isSolidWorksFile("drawing.slddrw")).toBe(true);
  });

  it("is case-insensitive on extension", () => {
    expect(isSolidWorksFile("Part.SLDPRT")).toBe(true);
    expect(isSolidWorksFile("ASSEMBLY.SldAsm")).toBe(true);
  });

  it("rejects non-SolidWorks files", () => {
    expect(isSolidWorksFile("model.step")).toBe(false);
    expect(isSolidWorksFile("drawing.dwg")).toBe(false);
    expect(isSolidWorksFile("readme.pdf")).toBe(false);
    expect(isSolidWorksFile("image.png")).toBe(false);
  });

  it("matches bare extension name (no dot) since pop() returns the whole string", () => {
    // "sldprt".split(".").pop() === "sldprt" which IS in the list
    expect(isSolidWorksFile("sldprt")).toBe(true);
  });

  it("rejects files with unrelated extension", () => {
    expect(isSolidWorksFile("noext")).toBe(false);
  });

  it("handles files with multiple dots", () => {
    expect(isSolidWorksFile("rev.2.bracket.sldprt")).toBe(true);
  });

  it("handles empty string", () => {
    expect(isSolidWorksFile("")).toBe(false);
  });
});
