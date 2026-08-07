import { describe, it, expect } from "vitest";
import { parseCsvRecords } from "./csv";
import {
  looksLikeQuickBooksExport,
  parseQuickBooksExport,
  groupByPartNumber,
  chooseRowForPart,
  isUnapplied,
  looksLikeNumberingCollision,
} from "./quickbooks-import";

/**
 * The fixture below is synthetic but is modelled row-for-row on a real PACE
 * QuickBooks export, including the things that make that file awkward. The
 * real export is deliberately not committed — it carries every cost, preferred
 * vendor and sales price in the business.
 *
 * Preserved from the real file, because each one broke something:
 *
 *   - `Item` is a colon-delimited path, not a part number
 *   - one part number appears once per revision (four times, for the casting)
 *   - `Type` mixes Inventory Part with Service, Sales Tax Item and Discount
 *   - inactive rows are included
 *   - there is no `Name` column at all
 *   - a vendor name contains a literal backslash-n
 *   - `N1S-M-006` describes two different components under one number
 */
const QB_CSV = [
  `,"Active Status","Type","Item","Description","Sales Tax Code","Account","COGS Account","Asset Account","Accumulated Depreciation","Purchase Description","Quantity On Hand","Cost","Preferred Vendor","Tax Agency","Price","Reorder Pt (Min)","MPN","Barcode","Schedule B tariff code","Weight"`,
  // Four entries for one casting, sourcing moving vendor with each revision.
  `,"Active","Inventory Part","PACE Equipment:NANO-1000S-parts:Mechanical Components:N1S-M-001","NANO 1000S Base Aluminum Casting","Tax","Sales:Equipment","COGS","Inventory Asset",0.00,,0,332.13,"DongGuan RX\\n& LinFeiTeng",,900.00,"","N1S-M-001","060102080010","0","10"`,
  `,"Active","Inventory Part","PACE Equipment:NANO-1000S-parts:Mechanical Components:N1S-M-001-R1","NANO 1000S Base Aluminum Casting with Machining and Powder Coating","Tax","Sales:Equipment","COGS","Inventory Asset",0.00,,0,332.13,"DongGuan RX\\n& LinFeiTeng",,900.00,"","","","0","10"`,
  `,"Active","Inventory Part","PACE Equipment:NANO-1000S-parts:N1S-M-001-R2","NANO-1000S Base Aluminum Casting with Machining and Powder Coating. (Part No. N1S-M-001-R2)","Tax","Sales:Equipment","COGS","Inventory Asset",0.00,,0,332.13,"PACE Kunshan Imp&Exp Co Ltd",,900.00,"","","QB:01036425077469","0","0"`,
  `,"Active","Inventory Part","PACE Equipment:NANO-1200S-parts:Casting:N1S-M-001-R3","NANO-1000S Base Aluminum Casting with Machining and Powder Coating. (Part No. N1S-M-001-R3)","Tax","Sales:Equipment","COGS","Inventory Asset",0.00,,0,332.13,"Suzhou Nishiki Intelligent Technology Co.",,900.00,"","","","0","1"`,
  // Two genuinely different components sharing a number.
  `,"Active","Inventory Part","PACE Equipment:NANO-1200S-parts:Machined Components:N1S-M-006-R1","NANO-S Control Box Swivel Connector(part no. N1S-M-006-R1)","Tax","Sales:Equipment","COGS","Inventory Asset",0.00,,0,5.67,"PACE Kunshan Imp&Exp Co Ltd",,0.00,"","","","0",".5"`,
  `,"Active","Inventory Part","PACE Equipment:NANO-1200S-parts:N1S-M-006-R2","NANO-S Faucet hose retracred mechanism-base.(part no. N1S-M-006-R2)","Tax","Sales:Equipment","COGS","Inventory Asset",0.00,,0,5.67,"Lucent Ind Manufacturing Ltd",,0.00,"","","","0","1"`,
  // A single unversioned part.
  `,"Active","Inventory Part","PACE Equipment:NANO-1000S-parts:N1S-M-009","NANO-1000S Splash Guard","Tax","Sales:Equipment","COGS","Inventory Asset",0.00,,0,12.40,"Hemei",,40.00,"","","","0","2"`,
  // Everything below here is not a part.
  `,"Active","Service","Labor",,"Tax","Sales:Services:Labor Charges",,,0.00,,"",0.00,,,125.00,"",,"Labor",,`,
  `,"Active","Sales Tax Item","AZ State Tax","Arizona","Tax","Sales Tax Payable",,,0.00,,"",0.00,,,0.00,"",,"",,`,
  `,"Not-active","Inventory Part","PACE Equipment:Retired:N1S-M-099","Discontinued bracket","Tax","Sales:Equipment","COGS","Inventory Asset",0.00,,0,99.99,"Old Vendor",,0.00,"","","","0","1"`,
].join("\n");

function parseFixture() {
  const { headers, rows } = parseCsvRecords(QB_CSV);
  return { headers, ...parseQuickBooksExport(rows) };
}

describe("looksLikeQuickBooksExport", () => {
  it("recognises the export", () => {
    expect(looksLikeQuickBooksExport(parseCsvRecords(QB_CSV).headers)).toBe(true);
  });

  /** Our own template must keep going down the existing path. */
  it("does not claim our own parts template", () => {
    const ours = parseCsvRecords("Part Number,Name,Revision\nPN-1,Bracket,A").headers;
    expect(looksLikeQuickBooksExport(ours)).toBe(false);
  });

  it("is not fooled by a file that merely has an Item column", () => {
    expect(looksLikeQuickBooksExport(parseCsvRecords("Item,Cost\nA,1").headers)).toBe(false);
  });
});

describe("parseQuickBooksExport — what counts as a part", () => {
  it("keeps active inventory parts and drops everything else", () => {
    const { rows, skipped } = parseFixture();
    expect(rows).toHaveLength(7);
    expect(skipped).toHaveLength(3);
  });

  it.each([
    ["Service", /Not a part/],
    ["Sales Tax Item", /Not a part/],
  ])("explains why a %s row was dropped", (_type, pattern) => {
    const { skipped } = parseFixture();
    expect(skipped.some((s) => pattern.test(s.reason))).toBe(true);
  });

  it("drops rows QuickBooks marks inactive", () => {
    const { rows, skipped } = parseFixture();
    expect(rows.some((r) => r.partNumber === "N1S-M-099")).toBe(false);
    expect(skipped.some((s) => /Inactive/.test(s.reason))).toBe(true);
  });
});

describe("parseQuickBooksExport — reading a row", () => {
  /** The single most important one: `Item` is ancestry, not an identifier. */
  it("takes the part number from the last path segment", () => {
    const { rows } = parseFixture();
    const row = rows.find((r) => r.leaf === "N1S-M-001-R2")!;
    expect(row.itemPath).toBe("PACE Equipment:NANO-1000S-parts:N1S-M-001-R2");
    expect(row.partNumber).toBe("N1S-M-001");
    expect(row.revision).toBe("R2");
  });

  it("leaves an unversioned leaf alone", () => {
    const { rows } = parseFixture();
    const row = rows.find((r) => r.leaf === "N1S-M-009")!;
    expect(row.partNumber).toBe("N1S-M-009");
    expect(row.revision).toBeNull();
  });

  it("reads cost, vendor and weight", () => {
    const { rows } = parseFixture();
    const row = rows.find((r) => r.leaf === "N1S-M-001-R2")!;
    expect(row.unitCost).toBe(332.13);
    expect(row.vendor).toBe("PACE Kunshan Imp&Exp Co Ltd");
    expect(row.weight).toBe(0);
  });

  /** `DongGuan RX\n& LinFeiTeng` is an un-escaped escape, not a line break. */
  it("cleans a literal backslash-n out of a vendor name", () => {
    const { rows } = parseFixture();
    const row = rows.find((r) => r.leaf === "N1S-M-001")!;
    expect(row.vendor).toBe("DongGuan RX & LinFeiTeng");
    expect(row.vendor).not.toContain("\\n");
  });

  /**
   * There is no name column in a QuickBooks export at all, and the parts
   * importer requires a name. The description is the human label.
   */
  it("uses the description as the name, since no name column exists", () => {
    const { rows } = parseFixture();
    expect(rows.find((r) => r.leaf === "N1S-M-009")!.name).toBe("NANO-1000S Splash Guard");
  });

  it("falls back to the leaf when a row has no description", () => {
    const { rows } = parseQuickBooksExport([
      { item: "A:B:PN-7", type: "Inventory Part", "active status": "Active", description: "" },
    ]);
    expect(rows[0].name).toBe("PN-7");
  });

  it("records the source row so a warning can name a line", () => {
    const { rows } = parseFixture();
    expect(rows[0].sourceRow).toBe(2);
  });
});

// ── Choosing between revisions ─────────────────────────────────────────────
//
// QuickBooks holds one item per revision; the PDM holds one part carrying its
// current revision. So the file always has more rows than the library has
// parts, and applying them all makes the last row win — which is how a current
// casting silently acquires a vendor from a revision superseded years ago.

describe("chooseRowForPart", () => {
  const castings = () => groupByPartNumber(parseFixture().rows).get("N1S-M-001")!;

  it("has four entries for the one casting, which is the whole problem", () => {
    expect(castings().map((c) => c.leaf)).toEqual([
      "N1S-M-001",
      "N1S-M-001-R1",
      "N1S-M-001-R2",
      "N1S-M-001-R3",
    ]);
  });

  it("picks the entry matching the revision the PDM holds", () => {
    const chosen = chooseRowForPart(castings(), "R2")!;
    expect(chosen.row.leaf).toBe("N1S-M-001-R2");
    expect(chosen.row.vendor).toBe("PACE Kunshan Imp&Exp Co Ltd");
    expect(chosen.rejected).toHaveLength(3);
    expect(isUnapplied(chosen, "R2")).toBe(false);
  });

  it("picks a different entry when the PDM is on a different revision", () => {
    expect(chooseRowForPart(castings(), "R3")!.row.vendor).toBe(
      "Suzhou Nishiki Intelligent Technology Co."
    );
  });

  it("matches a revision case-insensitively", () => {
    expect(chooseRowForPart(castings(), "r2")!.row.leaf).toBe("N1S-M-001-R2");
  });

  it("says which entries it passed over", () => {
    const chosen = chooseRowForPart(castings(), "R2")!;
    expect(chosen.warning).toContain("4 entries");
    expect(chosen.warning).toContain("N1S-M-001-R3");
  });

  /**
   * Falls back to the unversioned entry, which is the generic one — better
   * than guessing between R1 and R3.
   */
  it("uses the bare entry when no revision matches", () => {
    const chosen = chooseRowForPart(castings(), "R9")!;
    expect(chosen.row.leaf).toBe("N1S-M-001");
    expect(chosen.warning).toMatch(/check this is the right one/i);
  });

  /**
   * The case that must not silently resolve: only versioned entries, none of
   * which is the one the PDM holds. Picking the highest would look helpful and
   * would be a guess about what is physically on the shelf.
   */
  it("applies nothing when only non-matching revisions exist", () => {
    const only = castings().filter((c) => c.revision !== null);
    const chosen = chooseRowForPart(only, "R9")!;
    expect(isUnapplied(chosen, "R9")).toBe(true);
    expect(chosen.warning).toMatch(/^Skipped/);
    expect(chosen.warning).toMatch(/reconcile the revision/i);
  });

  it("needs no warning for a part with a single entry", () => {
    const one = groupByPartNumber(parseFixture().rows).get("N1S-M-009")!;
    const chosen = chooseRowForPart(one, null)!;
    expect(chosen.warning).toBeNull();
    expect(chosen.rejected).toEqual([]);
    expect(isUnapplied(chosen, null)).toBe(false);
  });

  it("returns null for a part with no entries at all", () => {
    expect(chooseRowForPart([], "A")).toBeNull();
  });
});

// ── Numbering collisions ───────────────────────────────────────────────────

describe("looksLikeNumberingCollision", () => {
  /**
   * `N1S-M-006-R1` is a "Control Box Swivel Connector" and `-R2` is a "Faucet
   * hose retracted mechanism". Those are two components sharing a number, not
   * revisions of one, and no importer may quietly pick between them.
   */
  it("flags two different components sharing a number", () => {
    const group = groupByPartNumber(parseFixture().rows).get("N1S-M-006")!;
    expect(group).toHaveLength(2);
    expect(looksLikeNumberingCollision(group)).toBe(true);
  });

  /**
   * The casting's four entries differ only by having "with Machining and
   * Powder Coating" appended and a "(Part No. …)" tail. That is one part
   * described at four moments, and flagging it would train people to ignore
   * the warning.
   */
  it("does not flag real revisions of one part", () => {
    const group = groupByPartNumber(parseFixture().rows).get("N1S-M-001")!;
    expect(looksLikeNumberingCollision(group)).toBe(false);
  });

  it("does not flag a single entry", () => {
    const group = groupByPartNumber(parseFixture().rows).get("N1S-M-009")!;
    expect(looksLikeNumberingCollision(group)).toBe(false);
  });
});

describe("groupByPartNumber", () => {
  it("collapses every revision onto the part number it resolves to", () => {
    const groups = groupByPartNumber(parseFixture().rows);
    expect(groups.get("N1S-M-001")).toHaveLength(4);
    expect(groups.get("N1S-M-006")).toHaveLength(2);
    expect(groups.get("N1S-M-009")).toHaveLength(1);
    // 7 part rows collapse to 3 part numbers.
    expect(groups.size).toBe(3);
  });
});
