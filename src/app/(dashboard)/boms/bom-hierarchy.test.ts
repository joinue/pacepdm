import { describe, it, expect } from "vitest";
import { groupBoms } from "./bom-hierarchy";
import type { BOM } from "./types";

/**
 * The grouping exists because a flat list misrepresents an imported product:
 * 26 BOMs, one machine, 25 children. These tests use that real shape rather
 * than a two-item toy, because the ordering rules only matter at scale.
 */

function bom(name: string, usedIn: string[] = [], orphanHint: string | null = null): BOM {
  return {
    id: `id-${name}`,
    name,
    revision: "A",
    status: "DRAFT",
    createdAt: "2026-08-05T00:00:00Z",
    usedIn: usedIn.map((n) => ({ id: `id-${n}`, name: n })),
    orphanHint,
  };
}

describe("groupBoms", () => {
  it("separates the product from its sub-assemblies", () => {
    const groups = groupBoms([
      bom("NANO-1000S Electrical-Components", ["NANO-1000S"]),
      bom("NANO-1000S"),
      bom("NANO-1000S Machined-Components", ["NANO-1000S"]),
    ]);

    expect(groups.topLevel.map((b) => b.name)).toEqual(["NANO-1000S"]);
    expect(groups.subAssemblies).toHaveLength(2);
  });

  it("treats a BOM referenced by more than one parent as a sub-assembly", () => {
    // A shared group like NANO-S Standard-Components belongs to every machine
    // in the family once the 2000S exists.
    const groups = groupBoms([
      bom("NANO-S Standard-Components", ["NANO-1000S", "NANO-2000S"]),
      bom("NANO-1000S"),
      bom("NANO-2000S"),
    ]);

    expect(groups.topLevel.map((b) => b.name)).toEqual(["NANO-1000S", "NANO-2000S"]);
    expect(groups.subAssemblies.map((b) => b.name)).toEqual(["NANO-S Standard-Components"]);
  });

  it("keeps a sub-assembly's siblings together, then sorts by name", () => {
    const groups = groupBoms([
      bom("Z-group", ["NANO-1000S"]),
      bom("A-group", ["NANO-2000S"]),
      bom("A-second", ["NANO-1000S"]),
      bom("NANO-1000S"),
      bom("NANO-2000S"),
    ]);

    expect(groups.subAssemblies.map((b) => b.name)).toEqual([
      // Children of NANO-1000S first, alphabetical within the parent...
      "A-second",
      "Z-group",
      // ...then children of NANO-2000S.
      "A-group",
    ]);
  });

  it("sorts top-level BOMs alphabetically, ignoring case", () => {
    const groups = groupBoms([bom("beta"), bom("Alpha"), bom("Gamma")]);
    expect(groups.topLevel.map((b) => b.name)).toEqual(["Alpha", "beta", "Gamma"]);
  });

  it("flags a top-level BOM the server identified as a broken link", () => {
    // The real case: NANO-1000S references "NANO1000S Casting-Components"
    // (no hyphen), so the casting BOM has no parents and reads as a product.
    const casting = bom("NANO-1000S Casting-Components", [], "NANO1000S Casting-Components");
    const groups = groupBoms([bom("NANO-1000S"), casting]);

    expect(groups.orphans.map((b) => b.name)).toEqual(["NANO-1000S Casting-Components"]);
    // Still listed as top-level — it genuinely has no parent. The flag is
    // about how to describe it, not about hiding it.
    expect(groups.topLevel).toHaveLength(2);
  });

  it("does not flag a genuine product as an orphan", () => {
    const groups = groupBoms([bom("NANO-1000S"), bom("NANO-2000S")]);
    expect(groups.orphans).toEqual([]);
  });

  it("treats a missing usedIn as unknown rather than top-level-with-confidence", () => {
    // Endpoints other than GET /api/boms omit the field. A BOM with no
    // information still has to land somewhere; top-level is the honest
    // default, and it must not throw.
    const legacy: BOM = {
      id: "x",
      name: "Legacy",
      revision: "A",
      status: "DRAFT",
      createdAt: "2026-08-05T00:00:00Z",
    };
    const groups = groupBoms([legacy]);
    expect(groups.topLevel).toHaveLength(1);
    expect(groups.orphans).toEqual([]);
  });

  it("handles an empty list", () => {
    expect(groupBoms([])).toEqual({ topLevel: [], subAssemblies: [], orphans: [] });
  });
});
