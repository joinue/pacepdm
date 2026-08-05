import { describe, it, expect } from "vitest";
import { buildBomTree, visibleRows } from "./bom-hierarchy";
import type { BOM } from "./types";

/**
 * The tree exists because the flat list stops scaling at the second product:
 * one machine contributes 25 sub-assemblies, five contribute well over a
 * hundred. These tests use that shape — multiple parents, real nesting, and
 * the bad data that already exists — rather than a two-node toy.
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

const names = (nodes: { bom: BOM }[]) => nodes.map((n) => n.bom.name);

describe("buildBomTree", () => {
  it("puts products at the root and nests their children", () => {
    const tree = buildBomTree([
      bom("NANO-1000S Electrical-Components", ["NANO-1000S"]),
      bom("NANO-1000S"),
      bom("NANO-1000S Machined-Components", ["NANO-1000S"]),
    ]);

    expect(names(tree.roots)).toEqual(["NANO-1000S"]);
    expect(names(tree.roots[0].children)).toEqual([
      "NANO-1000S Electrical-Components",
      "NANO-1000S Machined-Components",
    ]);
  });

  it("nests to the depth the data actually has", () => {
    // The real chain: NANO-1000S → Assemblies → N1S-A-SA.
    const tree = buildBomTree([
      bom("NANO-1000S"),
      bom("NANO-1000S_2000S Assemblies", ["NANO-1000S"]),
      bom("N1S-A-SA", ["NANO-1000S_2000S Assemblies"]),
    ]);

    const assemblies = tree.roots[0].children[0];
    expect(assemblies.bom.name).toBe("NANO-1000S_2000S Assemblies");
    expect(assemblies.depth).toBe(1);
    expect(assemblies.children[0].bom.name).toBe("N1S-A-SA");
    expect(assemblies.children[0].depth).toBe(2);
  });

  it("counts every descendant, not just direct children", () => {
    const tree = buildBomTree([
      bom("NANO-1000S"),
      bom("Assemblies", ["NANO-1000S"]),
      bom("N1S-A-SA", ["Assemblies"]),
      bom("P-FAUCET", ["Assemblies"]),
      bom("Electrical", ["NANO-1000S"]),
    ]);
    expect(tree.roots[0].descendantCount).toBe(4);
    expect(tree.subAssemblyCount).toBe(4);
  });

  it("shows a shared group under every product that uses it", () => {
    // NANO-S Standard-Components belongs to both machines once the 2000S
    // exists. It is one BOM appearing in two places, which is correct.
    const tree = buildBomTree([
      bom("NANO-1000S"),
      bom("NANO-2000S"),
      bom("NANO-S Standard-Components", ["NANO-1000S", "NANO-2000S"]),
    ]);

    expect(names(tree.roots)).toEqual(["NANO-1000S", "NANO-2000S"]);
    expect(names(tree.roots[0].children)).toEqual(["NANO-S Standard-Components"]);
    expect(names(tree.roots[1].children)).toEqual(["NANO-S Standard-Components"]);
    // Counted once, because it is one BOM.
    expect(tree.subAssemblyCount).toBe(1);
  });

  it("sorts roots and children alphabetically, ignoring case", () => {
    const tree = buildBomTree([
      bom("beta"),
      bom("Alpha"),
      bom("zeta", ["Alpha"]),
      bom("Gamma", ["Alpha"]),
    ]);
    expect(names(tree.roots)).toEqual(["Alpha", "beta"]);
    expect(names(tree.roots[0].children)).toEqual(["Gamma", "zeta"]);
  });

  it("flags a root the server identified as a broken link", () => {
    const casting = bom("NANO-1000S Casting-Components", [], "NANO1000S Casting-Components");
    const tree = buildBomTree([bom("NANO-1000S"), casting]);

    expect(tree.orphans.map((b) => b.name)).toEqual(["NANO-1000S Casting-Components"]);
    // Still a root — it genuinely has no parent. The flag describes it.
    expect(tree.roots).toHaveLength(2);
  });

  it("keeps a child reachable when its parent is not in the list", () => {
    // The endpoint caps at 500 BOMs, and a parent can be soft-deleted. A
    // child must not disappear from the page because of either.
    const tree = buildBomTree([bom("Stranded", ["Missing-Parent"])]);
    expect(names(tree.roots)).toEqual(["Stranded"]);
  });

  it("terminates on a cycle instead of hanging the page", () => {
    // The API refuses to create one, but a row written before that guard, or
    // by hand in SQL, must not take the browser with it.
    const tree = buildBomTree([bom("A", ["B"]), bom("B", ["A"])]);
    expect(tree.roots).toEqual([]);
  });

  it("handles an empty list", () => {
    expect(buildBomTree([])).toEqual({ roots: [], orphans: [], subAssemblyCount: 0 });
  });
});

describe("visibleRows", () => {
  const tree = buildBomTree([
    bom("NANO-1000S"),
    bom("Assemblies", ["NANO-1000S"]),
    bom("N1S-A-SA", ["Assemblies"]),
    bom("Electrical", ["NANO-1000S"]),
  ]);

  it("shows only roots when nothing is expanded", () => {
    expect(names(visibleRows(tree.roots, new Set()))).toEqual(["NANO-1000S"]);
  });

  it("reveals one level per expanded node", () => {
    expect(names(visibleRows(tree.roots, new Set(["id-NANO-1000S"])))).toEqual([
      "NANO-1000S",
      "Assemblies",
      "Electrical",
    ]);
  });

  it("keeps a grandchild hidden while its parent is collapsed", () => {
    // Expanding the product must not blow the whole tree open.
    const rows = visibleRows(tree.roots, new Set(["id-NANO-1000S"]));
    expect(names(rows)).not.toContain("N1S-A-SA");
  });

  it("shows a grandchild once both ancestors are expanded", () => {
    const rows = visibleRows(tree.roots, new Set(["id-NANO-1000S", "id-Assemblies"]));
    expect(names(rows)).toEqual(["NANO-1000S", "Assemblies", "N1S-A-SA", "Electrical"]);
  });
});
