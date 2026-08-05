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
