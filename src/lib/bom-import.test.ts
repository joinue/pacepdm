import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBuildList, collectParts, splitRevision, findNearMissLinks } from "./bom-import";

/**
 * Tested against the real archive file rather than a hand-written sample.
 * The format's traps — BOM rows not following the header, `Create` rows
 * being the BOM's own output, hierarchy by name reference — are exactly the
 * things a tidied-up fixture would quietly normalise away.
 *
 * The counts below were verified against the source file by hand. If a
 * parser change moves any of them, that is a real behaviour change and
 * wants a look, not a number bump.
 */

const FIXTURE = readFileSync(join(__dirname, "__fixtures__", "nano-1000s-build-list.csv"), "utf8");

describe("splitRevision", () => {
  it("splits a trailing -R<n>", () => {
    expect(splitRevision("N1S-M-001-R2")).toEqual({ partNumber: "N1S-M-001", revision: "R2" });
    expect(splitRevision("N1S-SA-A-R4")).toEqual({ partNumber: "N1S-SA-A", revision: "R4" });
  });

  it("leaves an unsuffixed part number alone", () => {
    expect(splitRevision("N1S-P-004")).toEqual({ partNumber: "N1S-P-004", revision: null });
  });

  it("does not mistake a trailing number for a revision", () => {
    // Real part numbers from the archive that end in digits or in R.
    expect(splitRevision("PS-24V-LRS75-24").revision).toBeNull();
    expect(splitRevision("POW-E-STOP-1CR").revision).toBeNull();
    expect(splitRevision("C-220V-002").revision).toBeNull();
    expect(splitRevision("TC-52-62-7").revision).toBeNull();
  });

  it("compares revisions numerically, not lexically", () => {
    expect(splitRevision("X-R10").revision).toBe("R10");
    expect(splitRevision("X-R9").revision).toBe("R9");
  });
});

describe("parseBuildList — NANO-1000S archive", () => {
  const parsed = parseBuildList(FIXTURE);

  it("parses every BOM block and no stray rows", () => {
    expect(parsed.boms).toHaveLength(26);
    expect(parsed.problems).toEqual([]);
  });

  it("excludes the `Create` row, which is the BOM's own output", () => {
    const total = parsed.boms.reduce((n, b) => n + b.items.length, 0);
    // 161 item rows in the file, 26 of them `Create` / Finished Good.
    expect(total).toBe(135);

    // The spindle assembly's own row must not appear inside itself.
    const spindle = parsed.boms.find((b) => b.partNumber === "N1S-A-SA")!;
    expect(spindle.items.map((i) => i.sourcePartNumber)).not.toContain("N1S-A-SA");
    expect(spindle.items).toHaveLength(4);
  });

  it("reads the part number and description off a BOM row's own columns", () => {
    // BOM rows do not follow the header: col 1 is the part number, col 2
    // the description. Getting this wrong yields a BOM named "Add ...".
    const spindle = parsed.boms.find((b) => b.partNumber === "N1S-A-SA")!;
    expect(spindle.description).toBe("NANO-1000/2000S Spindle Assembly");
  });

  it("drops a description that only repeats the part number", () => {
    const casting = parsed.boms.find((b) => b.partNumber === "NANO-1000S Casting-Components")!;
    expect(casting.description).toBeNull();
  });

  it("splits revisions off item part numbers", () => {
    const casting = parsed.boms.find((b) => b.partNumber === "NANO-1000S Casting-Components")!;
    expect(casting.items[0]).toMatchObject({
      partNumber: "N1S-M-001",
      revision: "R2",
      sourcePartNumber: "N1S-M-001-R2",
      quantity: 1,
    });
  });

  it("captures configure-to-order option groups", () => {
    const options = parsed.boms.flatMap((b) => b.items).filter((i) => i.optionGroup !== null);
    expect(options).toHaveLength(10);

    const byGroup = new Map<string, string[]>();
    for (const o of options) {
      const list = byGroup.get(o.optionGroup!) ?? [];
      list.push(o.partNumber);
      byGroup.set(o.optionGroup!, list);
    }
    expect([...byGroup.keys()].sort()).toEqual(["Bowl size", "Fuse", "Paper ring size", "Voltage"]);
    expect(byGroup.get("Bowl size")).toEqual(["PW-1000A", "PW-800A"]);
    expect(byGroup.get("Voltage")).toHaveLength(4);

    const prompt = options.find((o) => o.optionGroup === "Bowl size")!;
    expect(prompt.optionPrompt).toBe("What bowl size ordered");
  });

  it("keeps fractional quantities", () => {
    const hose = parsed.boms.flatMap((b) => b.items).find((i) => i.partNumber === "HOSE-25-32MM")!;
    expect(hose.quantity).toBe(0.05);
  });

  it("numbers items per BOM, starting at 1", () => {
    for (const bom of parsed.boms) {
      expect(bom.items.map((i) => i.position)).toEqual(bom.items.map((_, idx) => idx + 1));
    }
  });
});

describe("collectParts — NANO-1000S archive", () => {
  const parts = collectParts(parseBuildList(FIXTURE));

  it("collects every distinct part, components and BOMs alike", () => {
    // 132 distinct component numbers, all 26 BOM numbers among them or
    // added by the BOM pass. Revision stripping merges nothing here.
    expect(parts.size).toBe(134);
  });

  it("marks the parts that head their own BOM as sub-assemblies", () => {
    const subs = [...parts.values()].filter((p) => p.isSubAssembly);
    expect(subs).toHaveLength(26);
    expect(parts.get("N1S-A-SA")?.isSubAssembly).toBe(true);
    expect(parts.get("BB-17-40")?.isSubAssembly).toBe(false);
  });

  it("carries the revision through to the part", () => {
    expect(parts.get("N1S-M-001")).toMatchObject({ revision: "R2", revisionsSeen: ["R2"] });
  });

  it("records a part used by more than one BOM exactly once", () => {
    // N1S-SA-B-R2, BB-17-40 and SN-EX-17 each appear in two BOMs.
    expect(parts.get("N1S-SA-B")?.revisionsSeen).toEqual(["R2"]);
    expect(parts.get("BB-17-40")).toBeDefined();
  });
});

describe("parseBuildList — malformed input", () => {
  const header =
    "Flag,Description,Type,Part,Quantity,UOM,IsVariableQuantity,MinQuantity,MaxQuantity,OptionGroup,OptionGroupPrompt\n";

  it("reports an item that appears before any BOM rather than throwing", () => {
    const { boms, problems } = parseBuildList(`${header}Item,Add X,Raw Good,X,1,ea\n`);
    expect(boms).toEqual([]);
    expect(problems).toEqual([{ line: 2, message: "Item row appears before any BOM row" }]);
  });

  it("rejects a non-numeric quantity and keeps the rest of the BOM", () => {
    const csv =
      `${header}` +
      `BOM,ASSY-1,Assembly One,TRUE,1\n` +
      `Item,Create ASSY-1,Finished Good,ASSY-1,1,ea\n` +
      `Item,Add GOOD,Raw Good,GOOD,2,ea\n` +
      `Item,Add BAD,Raw Good,BAD,many,ea\n` +
      `Item,Add ZERO,Raw Good,ZERO,0,ea\n`;
    const { boms, problems } = parseBuildList(csv);
    expect(boms[0].items.map((i) => i.partNumber)).toEqual(["GOOD"]);
    expect(problems.map((p) => p.message)).toEqual([
      'BAD: quantity "many" is not a positive number',
      'ZERO: quantity "0" is not a positive number',
    ]);
  });

  it("reports a BOM row with no part number and detaches following items", () => {
    const csv = `${header}BOM,,No number,TRUE,1\nItem,Add X,Raw Good,X,1,ea\n`;
    const { boms, problems } = parseBuildList(csv);
    expect(boms).toEqual([]);
    expect(problems.map((p) => p.message)).toEqual([
      "BOM row has no part number",
      "Item row appears before any BOM row",
    ]);
  });

  it("defaults a missing unit to EA", () => {
    const csv = `${header}BOM,ASSY-1,Assembly One,TRUE,1\nItem,Add X,Raw Good,X,1,\n`;
    expect(parseBuildList(csv).boms[0].items[0].unit).toBe("EA");
  });
});

describe("findNearMissLinks", () => {
  it("catches the hyphen typo in the NANO-1000S archive", () => {
    // Line 4 references `NANO1000S Casting-Components` while the BOM on line
    // 39 is `NANO-1000S Casting-Components`. Without this check the casting
    // group imports as an orphan and the reference becomes a phantom part.
    const misses = findNearMissLinks(parseBuildList(FIXTURE));
    expect(misses).toEqual([
      {
        bomPartNumber: "NANO-1000S",
        itemPartNumber: "NANO1000S Casting-Components",
        probableBom: "NANO-1000S Casting-Components",
        sourceLine: 4,
      },
    ]);
  });

  it("ignores lines that link correctly", () => {
    const csv =
      "Flag,Description,Type,Part,Quantity,UOM\n" +
      "BOM,TOP-1,Top,TRUE,1\n" +
      "Item,Create TOP-1,Finished Good,TOP-1,1,ea\n" +
      "Item,Add SUB-1,Raw Good,SUB-1,1,ea\n" +
      "BOM,SUB-1,Sub,TRUE,1\n" +
      "Item,Create SUB-1,Finished Good,SUB-1,1,ea\n" +
      "Item,Add LEAF,Raw Good,LEAF,1,ea\n";
    expect(findNearMissLinks(parseBuildList(csv))).toEqual([]);
  });

  it("does not flag genuinely different part numbers in a dense scheme", () => {
    // N1S-P-005 and N1S-P-006 are distinct parts, not a typo for each other.
    // Only punctuation and case are ignored — never a differing digit.
    const csv =
      "Flag,Description,Type,Part,Quantity,UOM\n" +
      "BOM,N1S-P-005,Part five,TRUE,1\n" +
      "Item,Create N1S-P-005,Finished Good,N1S-P-005,1,ea\n" +
      "Item,Add N1S-P-006,Raw Good,N1S-P-006,1,ea\n";
    expect(findNearMissLinks(parseBuildList(csv))).toEqual([]);
  });
});
