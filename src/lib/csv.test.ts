import { describe, it, expect } from "vitest";
import { csvField, toCsv, parseCsv, parseCsvRecords, unescapeCsvFormula } from "./csv";

describe("formula-injection round trip", () => {
  it("restores the original value on re-import", () => {
    const original = '=HYPERLINK("http://evil")';
    const csv = toCsv(["name"], [[original]]);
    const { rows } = parseCsvRecords(csv);
    expect(rows[0].name).toBe(original);
  });

  it("leaves ordinary values untouched through a round trip", () => {
    const csv = toCsv(["name", "cost"], [["Widget, large", -12.5]]);
    const { rows } = parseCsvRecords(csv);
    expect(rows[0].name).toBe("Widget, large");
    expect(rows[0].cost).toBe("-12.5");
  });

  it("only strips an apostrophe that guards a formula", () => {
    expect(unescapeCsvFormula("'=1+1")).toBe("=1+1");
    expect(unescapeCsvFormula("'Twas the night")).toBe("'Twas the night");
  });
});

describe("csvField", () => {
  it("leaves plain strings alone", () => {
    expect(csvField("hello")).toBe("hello");
  });

  it("quotes fields that contain commas", () => {
    expect(csvField("a,b")).toBe('"a,b"');
  });

  it("quotes fields that contain newlines", () => {
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("doubles embedded quotes", () => {
    expect(csvField('he said "hi"')).toBe('"he said ""hi"""');
  });

  it("coerces numbers and booleans without quoting", () => {
    expect(csvField(42)).toBe("42");
    expect(csvField(true)).toBe("true");
  });

  it("emits empty string for null / undefined", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("neutralizes formula-like strings so spreadsheets treat them as text", () => {
    expect(csvField("=cmd|'/c calc'!A1")).toBe(`"'=cmd|'/c calc'!A1"`);
    expect(csvField("+1+1")).toBe(`"'+1+1"`);
    expect(csvField("@SUM(A1)")).toBe(`"'@SUM(A1)"`);
    expect(csvField("-1+1+cmd|'/c calc'!A1")).toBe(`"'-1+1+cmd|'/c calc'!A1"`);
  });

  it("leaves negative numbers alone so cost columns still parse", () => {
    expect(csvField(-5)).toBe("-5");
    expect(csvField("-5")).toBe("-5");
    expect(csvField("-12.75")).toBe("-12.75");
  });
});

describe("toCsv", () => {
  it("writes a header row and data rows joined by CRLF", () => {
    const csv = toCsv(
      ["a", "b"],
      [
        [1, 2],
        [3, 4],
      ]
    );
    expect(csv).toBe("a,b\r\n1,2\r\n3,4");
  });

  it("pads short rows and quotes dirty data", () => {
    const csv = toCsv(
      ["a", "b", "c"],
      [
        ["x", "y,z"],
        ["one", 'he said "hi"', "last\nline"],
      ]
    );
    expect(csv).toBe('a,b,c\r\nx,"y,z",\r\none,"he said ""hi""","last\nline"');
  });
});

describe("parseCsv", () => {
  it("parses a basic grid", () => {
    expect(parseCsv("a,b,c\n1,2,3\n4,5,6")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("handles quoted fields with commas and doubled quotes", () => {
    const input = 'name,note\n"Acme, Inc.","he said ""hi"""';
    expect(parseCsv(input)).toEqual([
      ["name", "note"],
      ["Acme, Inc.", 'he said "hi"'],
    ]);
  });

  it("handles newlines inside quoted fields", () => {
    const input = 'a,b\n"line1\nline2",ok';
    expect(parseCsv(input)).toEqual([
      ["a", "b"],
      ["line1\nline2", "ok"],
    ]);
  });

  it("accepts CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("strips the UTF-8 BOM Excel adds on Save As CSV", () => {
    const input = "\uFEFFa,b\n1,2";
    expect(parseCsv(input)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("returns empty cells instead of skipping them", () => {
    expect(parseCsv("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });
});

describe("parseCsvRecords", () => {
  it("normalizes headers to lowercase and returns records", () => {
    const input = "Part Number,Name\nP-001,Widget\nP-002,Gadget";
    const { headers, rows } = parseCsvRecords(input);
    expect(headers).toEqual(["part number", "name"]);
    expect(rows).toEqual([
      { "part number": "P-001", name: "Widget" },
      { "part number": "P-002", name: "Gadget" },
    ]);
  });

  it("skips fully blank rows", () => {
    const input = "a,b\n1,2\n\n3,4";
    const { rows } = parseCsvRecords(input);
    expect(rows).toHaveLength(2);
  });

  it("returns empty result for empty input", () => {
    expect(parseCsvRecords("")).toEqual({ headers: [], rows: [] });
  });
});
