import { describe, it, expect } from "vitest";
import {
  computeBomRollup,
  wouldCreateCycle,
  BomCycleError,
  BomNotFoundError,
  type RollupBom,
  type RollupBomItem,
} from "./bom-rollup";

// ─── helpers ──────────────────────────────────────────────────────────────

function bom(id: string, name: string, items: RollupBomItem[]): RollupBom {
  return { id, name, revision: "A", items };
}

function leaf(
  id: string,
  itemNumber: string,
  name: string,
  quantity: number,
  unitCost: number | null
): RollupBomItem {
  return {
    id,
    bomId: "",
    linkedBomId: null,
    itemNumber,
    partNumber: null,
    name,
    quantity,
    unit: "EA",
    unitCost,
  };
}

function sub(
  id: string,
  itemNumber: string,
  name: string,
  quantity: number,
  linkedBomId: string
): RollupBomItem {
  return {
    id,
    bomId: "",
    linkedBomId,
    itemNumber,
    partNumber: null,
    name,
    quantity,
    unit: "EA",
    unitCost: null,
  };
}

function mapOf(...boms: RollupBom[]): Map<string, RollupBom> {
  return new Map(boms.map((b) => [b.id, b]));
}

// ─── tests ────────────────────────────────────────────────────────────────

describe("computeBomRollup — flat BOMs", () => {
  it("sums extended cost across leaf items", () => {
    const root = bom("root", "Widget", [
      leaf("a", "001", "Bolt", 4, 0.5),
      leaf("b", "002", "Plate", 1, 12),
      leaf("c", "003", "Spring", 2, 1.25),
    ]);
    const result = computeBomRollup("root", mapOf(root));

    // 4 × 0.5 + 1 × 12 + 2 × 1.25 = 2 + 12 + 2.5 = 16.5
    expect(result.totalCost).toBe(16.5);
    expect(result.leafItemCount).toBe(3);
    expect(result.maxDepth).toBe(0);
    expect(result.itemsMissingCost).toBe(0);
  });

  it("treats null unit cost as 0 contribution and counts the gap", () => {
    const root = bom("root", "Widget", [
      leaf("a", "001", "Bolt", 4, 0.5),
      leaf("b", "002", "Mystery part", 1, null),
    ]);
    const result = computeBomRollup("root", mapOf(root));

    expect(result.totalCost).toBe(2);
    expect(result.itemsMissingCost).toBe(1);
    expect(result.leafItemCount).toBe(2);
  });
});

describe("computeBomRollup — sub-assemblies", () => {
  it("multiplies child quantities by parent quantity", () => {
    // Bicycle: 1 frame + 2 wheels. Each wheel has 1 hub ($5) + 32 spokes ($0.10).
    // Per wheel: 5 + 32×0.10 = 8.20
    // Total: 1 frame ($20) + 2 × 8.20 = 20 + 16.40 = 36.40
    const wheel = bom("wheel", "Wheel", [
      leaf("h", "001", "Hub", 1, 5),
      leaf("s", "002", "Spoke", 32, 0.1),
    ]);
    const bike = bom("bike", "Bicycle", [
      leaf("f", "001", "Frame", 1, 20),
      sub("w", "002", "Wheel assembly", 2, "wheel"),
    ]);

    const result = computeBomRollup("bike", mapOf(bike, wheel));

    expect(result.totalCost).toBeCloseTo(36.4, 5);
    expect(result.leafItemCount).toBe(3); // Frame + Hub + Spoke (the leaves of the tree)
    expect(result.maxDepth).toBe(1);
    // Spoke quantity at the leaf level should be 2 wheels × 32 spokes = 64
    const spokeLine = result.lines.find((l) => l.name === "Spoke");
    expect(spokeLine?.effectiveQuantity).toBe(64);
  });

  it("handles three-level nesting with quantity multiplication", () => {
    const screw = bom("screw", "Screw kit", [leaf("s", "001", "Screw", 4, 0.25)]);
    const wheel = bom("wheel", "Wheel", [sub("sk", "001", "Screws", 2, "screw")]);
    const bike = bom("bike", "Bike", [sub("w", "001", "Wheels", 2, "wheel")]);

    const result = computeBomRollup("bike", mapOf(bike, wheel, screw));

    // 2 wheels × 2 screw kits × 4 screws × 0.25 = 4
    expect(result.totalCost).toBe(4);
    expect(result.maxDepth).toBe(2);
    const screwLine = result.lines.find((l) => l.name === "Screw");
    expect(screwLine?.effectiveQuantity).toBe(16);
  });

  it("emits a placeholder line when a sub-BOM is missing", () => {
    const root = bom("root", "Root", [sub("a", "001", "Ghost", 1, "nonexistent")]);
    const result = computeBomRollup("root", mapOf(root));

    expect(result.lines.length).toBe(1);
    expect(result.lines[0].name).toContain("missing");
    expect(result.lines[0].extendedCost).toBeNull();
  });
});

describe("computeBomRollup — cycle detection", () => {
  it("throws on direct self-reference", () => {
    const root = bom("root", "Root", [sub("a", "001", "Self", 1, "root")]);
    expect(() => computeBomRollup("root", mapOf(root))).toThrow(BomCycleError);
  });

  it("throws on indirect cycle (A → B → A)", () => {
    const a = bom("a", "Alpha", [sub("ab", "001", "→ Beta", 1, "b")]);
    const b = bom("b", "Beta", [sub("ba", "001", "→ Alpha", 1, "a")]);
    expect(() => computeBomRollup("a", mapOf(a, b))).toThrow(BomCycleError);
  });

  it("throws BomNotFoundError when the root BOM is missing", () => {
    expect(() => computeBomRollup("nope", mapOf())).toThrow(BomNotFoundError);
  });
});

describe("wouldCreateCycle", () => {
  it("returns a path for self-link", () => {
    const a = bom("a", "Alpha", []);
    expect(wouldCreateCycle("a", "a", mapOf(a))).not.toBeNull();
  });

  it("returns null for an unrelated link", () => {
    const a = bom("a", "Alpha", []);
    const b = bom("b", "Beta", []);
    expect(wouldCreateCycle("a", "b", mapOf(a, b))).toBeNull();
  });

  it("detects indirect cycle (linking B into A when B already contains A)", () => {
    const a = bom("a", "Alpha", []);
    const b = bom("b", "Beta", [sub("x", "001", "uses A", 1, "a")]);
    // Adding B as a sub of A would create A → B → A
    expect(wouldCreateCycle("a", "b", mapOf(a, b))).not.toBeNull();
  });

  it("allows linking a deeper sub-BOM that doesn't loop back", () => {
    const c = bom("c", "Gamma", []);
    const b = bom("b", "Beta", [sub("x", "001", "uses C", 1, "c")]);
    const a = bom("a", "Alpha", []);
    // Adding B into A is fine: A → B → C, no loop
    expect(wouldCreateCycle("a", "b", mapOf(a, b, c))).toBeNull();
  });
});

describe("computeBomRollup — configure-to-order options", () => {
  // The NANO-1000S pattern: a BOM carries every variant of an option group
  // side by side, and exactly one of them ships on any given machine.
  const optionLeaf = (
    id: string,
    itemNumber: string,
    name: string,
    quantity: number,
    unitCost: number | null,
    optionGroup: string
  ): RollupBomItem => ({
    id,
    bomId: "",
    linkedBomId: null,
    itemNumber,
    partNumber: null,
    name,
    quantity,
    unit: "EA",
    unitCost,
    optionGroup,
  });

  const machine = bom("b1", "NANO-1000S", [
    leaf("i1", "1", "Frame", 1, 100),
    leaf("i2", "2", "Motor", 1, 250),
    optionLeaf("i3", "3", "C-110V-001", 1, 40, "Voltage"),
    optionLeaf("i4", "4", "C-220V-002", 1, 55, "Voltage"),
    optionLeaf("i5", "5", "PW-1000A", 3, 10, "Bowl size"),
  ]);
  const result = computeBomRollup("b1", new Map([["b1", machine]]));

  it("excludes option lines from the base-configuration total", () => {
    // Frame 100 + Motor 250. Neither voltage nor the bowl is included.
    expect(result.totalCost).toBe(350);
  });

  it("totals option lines separately as an upper bound", () => {
    // 40 + 55 + (3 × 10). Not a buildable configuration, and documented
    // as such — both voltages cannot ship on one machine.
    expect(result.optionCost).toBe(125);
    expect(result.optionItemCount).toBe(3);
  });

  it("counts only base lines as leaf items", () => {
    expect(result.leafItemCount).toBe(2);
    // Every line is still emitted, options included, so the UI can group them.
    expect(result.totalLineCount).toBe(5);
  });

  it("tags each line with its group so the UI can partition", () => {
    const byName = new Map(result.lines.map((l) => [l.name, l.optionGroup]));
    expect(byName.get("Frame")).toBeNull();
    expect(byName.get("C-110V-001")).toBe("Voltage");
    expect(byName.get("PW-1000A")).toBe("Bowl size");
  });

  it("still reports missing costs across both base and option lines", () => {
    const withGaps = bom("b2", "X", [
      leaf("i1", "1", "NoCost", 1, null),
      optionLeaf("i2", "2", "OptNoCost", 1, null, "Voltage"),
    ]);
    const r = computeBomRollup("b2", new Map([["b2", withGaps]]));
    expect(r.itemsMissingCost).toBe(2);
    expect(r.totalCost).toBe(0);
    expect(r.optionCost).toBe(0);
  });
});

// ── Cost basis ─────────────────────────────────────────────────────────────
//
// A part can be priced three ways, in descending order of authority: an
// override typed on the BOM line, the part's authoritative `unitCost`, or the
// part's `estimatedCost`. The engine is handed the resolved number and its
// basis — the route resolves it, since only the route knows where a figure
// came from. What the engine owes is counting how much of a total is guesswork.

/** A leaf whose cost was resolved from something other than a line override. */
function leafWithBasis(
  id: string,
  itemNumber: string,
  unitCost: number | null,
  costBasis: RollupBomItem["costBasis"],
  quantity = 1
): RollupBomItem {
  return { ...leaf(id, itemNumber, `Part ${itemNumber}`, quantity, unitCost), costBasis };
}

describe("computeBomRollup — cost basis", () => {
  it("counts nothing as estimated when every line is real", () => {
    const root = bom("b1", "Root", [
      leafWithBasis("i1", "1", 10, "line"),
      leafWithBasis("i2", "2", 20, "part"),
    ]);
    const result = computeBomRollup("b1", mapOf(root));
    expect(result.totalCost).toBe(30);
    expect(result.itemsUsingEstimate).toBe(0);
  });

  it("counts the estimated lines", () => {
    const root = bom("b1", "Root", [
      leafWithBasis("i1", "1", 10, "part"),
      leafWithBasis("i2", "2", 20, "estimate"),
      leafWithBasis("i3", "3", 5, "estimate"),
    ]);
    const result = computeBomRollup("b1", mapOf(root));
    expect(result.itemsUsingEstimate).toBe(2);
    // The estimate still contributes — the point is that the total says so,
    // not that it is withheld.
    expect(result.totalCost).toBe(35);
  });

  it("carries the basis onto each line so the table can mark it", () => {
    const root = bom("b1", "Root", [
      leafWithBasis("i1", "1", 10, "part"),
      leafWithBasis("i2", "2", 20, "estimate"),
    ]);
    const { lines } = computeBomRollup("b1", mapOf(root));
    expect(lines.map((l) => l.costBasis)).toEqual(["part", "estimate"]);
  });

  /** Backwards compatible: a caller that predates the field still typechecks. */
  it("treats an unlabelled priced line as a line override", () => {
    const root = bom("b1", "Root", [leaf("i1", "1", "Widget", 1, 10)]);
    const { lines, itemsUsingEstimate } = computeBomRollup("b1", mapOf(root));
    expect(lines[0].costBasis).toBe("line");
    expect(itemsUsingEstimate).toBe(0);
  });

  it("gives an unpriced line a null basis rather than calling it an override", () => {
    const root = bom("b1", "Root", [leaf("i1", "1", "Widget", 1, null)]);
    const { lines, itemsMissingCost } = computeBomRollup("b1", mapOf(root));
    expect(lines[0].costBasis).toBeNull();
    expect(itemsMissingCost).toBe(1);
  });

  /**
   * Missing and estimated are different warnings and must not double-count: a
   * line has no cost, or it has one from some source, never both.
   */
  it("never counts a line as both missing and estimated", () => {
    const root = bom("b1", "Root", [
      leaf("i1", "1", "No cost", 1, null),
      leafWithBasis("i2", "2", 20, "estimate"),
    ]);
    const result = computeBomRollup("b1", mapOf(root));
    expect(result.itemsMissingCost).toBe(1);
    expect(result.itemsUsingEstimate).toBe(1);
  });

  it("counts estimated lines inside sub-assemblies too", () => {
    const child = bom("b2", "Child", [leafWithBasis("i2", "1", 5, "estimate")]);
    const root = bom("b1", "Root", [sub("s1", "1", "Sub", 2, "b2")]);
    const result = computeBomRollup("b1", mapOf(root, child));
    expect(result.itemsUsingEstimate).toBe(1);
    expect(result.totalCost).toBe(10); // 5 × 2
  });

  /**
   * An option line is not part of any single machine's price — only one member
   * of a group ever ships — so folding its basis into the warning would
   * overstate how much of `totalCost` is guesswork.
   */
  it("excludes option lines from the estimate count", () => {
    const root = bom("b1", "Root", [
      leafWithBasis("i1", "1", 10, "part"),
      { ...leafWithBasis("i2", "2", 50, "estimate"), optionGroup: "Voltage" },
    ]);
    const result = computeBomRollup("b1", mapOf(root));
    expect(result.itemsUsingEstimate).toBe(0);
    expect(result.optionItemCount).toBe(1);
  });

  it("gives a sub-assembly header line no basis of its own", () => {
    const child = bom("b2", "Child", [leafWithBasis("i2", "1", 5, "part")]);
    const root = bom("b1", "Root", [sub("s1", "1", "Sub", 1, "b2")]);
    const { lines } = computeBomRollup("b1", mapOf(root, child));
    const header = lines.find((l) => l.isSubAssembly)!;
    expect(header.costBasis).toBeNull();
    expect(header.unitCost).toBeNull();
  });
});
