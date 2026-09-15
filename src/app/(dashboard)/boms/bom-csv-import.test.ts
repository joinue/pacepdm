import { describe, it, expect } from "vitest";
import { parseBomLinesCsv, describeSkippedRows, type BomCsvParseResult } from "./bom-csv-import";

/**
 * The CSV a user appends to a BOM. The version this replaced split on
 * newlines, matched headers by substring and coerced numbers, so each case
 * below is one of the ways that version put a wrong value on a line without
 * saying so.
 */

const options = { firstItemNumber: 1, firstSortOrder: 0 };

function parsed(text: string, opts = options) {
  const result: BomCsvParseResult = parseBomLinesCsv(text, opts);
  if (!result.ok) throw new Error(`expected a parse, got: ${result.error}`);
  return result;
}

describe("parseBomLinesCsv — reading the file", () => {
  it("keeps a quoted description with a comma and a line break in one field", () => {
    const { lines, skipped } = parsed(
      'Part Number,Name,Description,Qty\nP-1,Bracket,"Bent, then\npainted",2\nP-2,Bolt,M6,4'
    );
    expect(skipped).toEqual([]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ partNumber: "P-1", description: "Bent, then\npainted" });
    expect(lines[1]).toMatchObject({ partNumber: "P-2", quantity: 4 });
  });

  it('does not read "Unit Cost" as the unit column', () => {
    const { lines } = parsed("Name,Unit Cost,Unit\nBracket,4.25,kg");
    expect(lines[0]).toMatchObject({ unit: "kg", unitCost: 4.25 });
  });

  it("matches headers exactly, not by substring", () => {
    // "Units per pack" and "Costing notes" used to be picked up as unit and cost.
    const { lines } = parsed("Name,Units per pack,Costing notes\nBracket,12,quote pending");
    expect(lines[0]).toMatchObject({ unit: "EA", unitCost: null });
  });

  it("ignores case and surrounding space in headers", () => {
    const { lines } = parsed("  PART NUMBER , QTY.\nP-1,3");
    expect(lines[0]).toMatchObject({ partNumber: "P-1", quantity: 3 });
  });

  it("reads a SolidWorks-style BOM table export", () => {
    const { lines } = parsed("ITEM NO.,PART NUMBER,DESCRIPTION,QTY.\n1,N1S-002,Spindle,2");
    expect(lines[0]).toMatchObject({
      itemNumber: "1",
      partNumber: "N1S-002",
      name: "",
      description: "Spindle",
      quantity: 2,
    });
  });

  it("refuses a file with neither a Name nor a Part Number column", () => {
    const result = parseBomLinesCsv("Description,Qty\nBracket,2", options);
    expect(result.ok).toBe(false);
  });

  it("refuses an empty file", () => {
    expect(parseBomLinesCsv("\n\n", options).ok).toBe(false);
  });

  it("strips the formula guard our own exports add", () => {
    const { lines } = parsed(`Name,Description\nBracket,"'=SUM(A1)"`);
    expect(lines[0].description).toBe("=SUM(A1)");
  });

  it("skips blank rows without counting them", () => {
    const { lines, skipped } = parsed("Name,Qty\nBracket,1\n,\n\nBolt,2\n");
    expect(lines).toHaveLength(2);
    expect(skipped).toEqual([]);
  });
});

describe("parseBomLinesCsv — values are refused, not coerced", () => {
  it("keeps a quantity of 0", () => {
    expect(parsed("Name,Qty\nReference,0").lines[0].quantity).toBe(0);
  });

  it("refuses a quantity that is not a number, naming the row", () => {
    const { lines, skipped } = parsed("Name,Qty\nBracket,1\nBolt,two\nNut,3");
    expect(lines.map((l) => l.name)).toEqual(["Bracket", "Nut"]);
    expect(skipped).toEqual([{ row: 3, reason: expect.stringContaining('"two"') }]);
  });

  it("refuses a negative quantity", () => {
    expect(parsed("Name,Qty\nBolt,-2").skipped).toHaveLength(1);
  });

  it("refuses a blank quantity when the file has a quantity column", () => {
    const { lines, skipped } = parsed("Name,Qty\nBolt,");
    expect(lines).toEqual([]);
    expect(skipped[0].reason).toMatch(/blank/i);
  });

  it("defaults to 1 only when the file has no quantity column at all", () => {
    expect(parsed("Name\nBolt").lines[0].quantity).toBe(1);
  });

  it("accepts a currency sign and thousands separator on a cost, and refuses anything else", () => {
    const { lines, skipped } = parsed('Name,Unit Cost\nPress,"$1,250.50"\nBolt,cheap');
    expect(lines[0].unitCost).toBe(1250.5);
    expect(skipped).toEqual([{ row: 3, reason: expect.stringContaining('"cheap"') }]);
  });

  it("refuses a row with neither a name nor a part number", () => {
    const { skipped } = parsed("Part Number,Name,Qty\n,,4");
    expect(skipped).toEqual([{ row: 2, reason: "No name or part number." }]);
  });
});

describe("parseBomLinesCsv — reading a BOM's own export back in", () => {
  const exported = [
    "Item #,Part Number,Name,Description,Qty,Unit,Level,Material,Vendor,Unit Cost,Part Category,File,File Rev,File State",
    '"010","SA-1","Frame weldment","","1","EA","1","","","","SUB_ASSEMBLY","","",""',
    '"010.001","P-7","Tube","","4","EA","2","","","2.00","PURCHASED","","",""',
    '"020","P-9","Cover","","1","EA","1","AL6061","Acme","12.00","MANUFACTURED","cover.sldprt","A","WIP"',
  ].join("\n");

  it("takes the top-level lines and skips the sub-assembly's own lines", () => {
    const { lines, skipped } = parsed(exported);
    expect(lines.map((l) => l.partNumber)).toEqual(["SA-1", "P-9"]);
    expect(lines[1]).toMatchObject({ material: "AL6061", vendor: "Acme", unitCost: 12 });
    expect(skipped).toEqual([{ row: 3, reason: expect.stringMatching(/sub-assembly/) }]);
  });
});

describe("parseBomLinesCsv — numbering and order", () => {
  it("numbers blank item cells from where the BOM leaves off, and appends after existing lines", () => {
    const { lines } = parsed("Name\nA\nB", { firstItemNumber: 7, firstSortOrder: 12 });
    expect(lines.map((l) => [l.itemNumber, l.sortOrder])).toEqual([
      ["007", 12],
      ["008", 13],
    ]);
  });

  it("does not hand out a number the file already uses", () => {
    const { lines } = parsed("Item,Name\n5,A\n,B");
    expect(lines.map((l) => l.itemNumber)).toEqual(["5", "006"]);
  });
});

describe("describeSkippedRows", () => {
  it("says nothing when nothing was skipped", () => {
    expect(describeSkippedRows([])).toBeUndefined();
  });

  it("lists the first few and counts the rest", () => {
    const skipped = Array.from({ length: 7 }, (_, i) => ({ row: i + 2, reason: "Bad." }));
    const text = describeSkippedRows(skipped, 2)!;
    expect(text).toContain("Row 2: Bad.");
    expect(text).toContain("Row 3: Bad.");
    expect(text).not.toContain("Row 4");
    expect(text).toContain("5 more");
  });
});
