import { parseCsv, unescapeCsvFormula } from "@/lib/csv";

/**
 * Reading a CSV of lines to append to an existing BOM.
 *
 * This is the "Import CSV" button on a BOM, not the build-list importer
 * (`src/lib/bom-import.ts`), which creates many BOMs from one QuickBooks file.
 *
 * The version this replaces split the file on newlines and each line on a
 * regex, so a quoted description containing a comma or a line break shifted
 * or split the row. It matched headers by substring — `unit` found "Unit Cost"
 * before "Unit", so the cost landed in the unit column — and it read a
 * quantity with `parseFloat(x) || 1`, which turned a 0 into a 1 and "abc" into
 * a 1 without a word. Now:
 *
 *   - `parseCsv` handles quoting, embedded commas and newlines.
 *   - Headers match exactly (case and surrounding space aside) against the
 *     aliases below. Anything else is ignored, which is what lets a BOM's own
 *     export — with its File and Part Category columns — be read back in.
 *   - A value that does not parse refuses its row with a reason rather than
 *     being coerced into something that looks deliberate.
 *
 * Pure, so the rules are testable without a component or a server.
 */

/** Header (lowercased, whitespace collapsed) → line field. */
const HEADER_ALIASES: Record<string, LineField> = {
  "item #": "itemNumber",
  item: "itemNumber",
  "item number": "itemNumber",
  "item no": "itemNumber",
  "item no.": "itemNumber",
  "part number": "partNumber",
  "part #": "partNumber",
  "part no": "partNumber",
  "part no.": "partNumber",
  partnumber: "partNumber",
  pn: "partNumber",
  name: "name",
  description: "description",
  qty: "quantity",
  "qty.": "quantity",
  quantity: "quantity",
  unit: "unit",
  uom: "unit",
  material: "material",
  vendor: "vendor",
  "unit cost": "unitCost",
  unitcost: "unitCost",
  cost: "unitCost",
  level: "level",
};

type LineField =
  | "itemNumber"
  | "partNumber"
  | "name"
  | "description"
  | "quantity"
  | "unit"
  | "material"
  | "vendor"
  | "unitCost"
  | "level";

/** One line, shaped for `POST /api/boms/[bomId]/items` `{ items }`. */
export interface ImportedBomLine {
  itemNumber: string;
  partNumber: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  material: string | null;
  vendor: string | null;
  unitCost: number | null;
  sortOrder: number;
}

export interface SkippedRow {
  /** Spreadsheet row number: the header is row 1. */
  row: number;
  reason: string;
}

export type BomCsvParseResult =
  { ok: true; lines: ImportedBomLine[]; skipped: SkippedRow[] } | { ok: false; error: string };

export interface BomCsvOptions {
  /** Item number given to the first line whose Item # cell is blank. */
  firstItemNumber: number;
  /** Sort order of the first imported line, so imports append after existing lines. */
  firstSortOrder: number;
}

const normalizeHeader = (h: string) => h.trim().replace(/\s+/g, " ").toLowerCase();

/** A number cell. `$` and thousands separators are allowed; anything else is not. */
function parseNumberCell(raw: string): number | null {
  const n = Number(raw.replace(/^\$/, "").replace(/,/g, ""));
  return raw !== "" && Number.isFinite(n) ? n : null;
}

export function parseBomLinesCsv(text: string, options: BomCsvOptions): BomCsvParseResult {
  const grid = parseCsv(text);
  const isBlank = (row: string[]) => row.every((cell) => cell.trim() === "");
  const headerIndex = grid.findIndex((row) => !isBlank(row));
  if (headerIndex === -1) {
    return { ok: false, error: "The CSV is empty." };
  }

  // First column wins when two headers alias the same field.
  const columns = new Map<LineField, number>();
  grid[headerIndex].forEach((header, index) => {
    const field = HEADER_ALIASES[normalizeHeader(header)];
    if (field && !columns.has(field)) columns.set(field, index);
  });

  if (!columns.has("name") && !columns.has("partNumber")) {
    return {
      ok: false,
      error: 'The CSV needs a "Name" or a "Part Number" column. Check the header row.',
    };
  }

  const lines: ImportedBomLine[] = [];
  const skipped: SkippedRow[] = [];
  let nextItemNumber = options.firstItemNumber;

  for (let r = headerIndex + 1; r < grid.length; r++) {
    const row = grid[r];
    if (isBlank(row)) continue;
    const rowNumber = r + 1;
    const cell = (field: LineField) => {
      const index = columns.get(field);
      return index === undefined ? "" : unescapeCsvFormula((row[index] ?? "").trim());
    };
    const skip = (reason: string) => skipped.push({ row: rowNumber, reason });

    const partNumber = cell("partNumber");
    const name = cell("name");
    if (!name && !partNumber) {
      skip("No name or part number.");
      continue;
    }

    // A level-2 line in a BOM export is a sub-assembly's own line, expanded
    // inline. Importing it flat would count it twice: once here, and once
    // through the sub-assembly it belongs to.
    const levelRaw = cell("level");
    if (levelRaw) {
      const level = Number(levelRaw);
      if (!Number.isInteger(level) || level < 1) {
        skip(`Level "${levelRaw}" is not a whole number of 1 or more.`);
        continue;
      }
      if (level > 1) {
        skip(`Level ${level} line — it belongs to a sub-assembly, which carries its own lines.`);
        continue;
      }
    }

    let quantity = 1;
    if (columns.has("quantity")) {
      const raw = cell("quantity");
      const parsed = parseNumberCell(raw);
      if (raw === "") {
        skip("Quantity is blank.");
        continue;
      }
      if (parsed === null || parsed < 0) {
        skip(`Quantity "${raw}" is not a number of 0 or more.`);
        continue;
      }
      quantity = parsed;
    }

    let unitCost: number | null = null;
    const costRaw = cell("unitCost");
    if (costRaw) {
      const parsed = parseNumberCell(costRaw);
      if (parsed === null || parsed < 0) {
        skip(`Unit cost "${costRaw}" is not a number of 0 or more.`);
        continue;
      }
      unitCost = parsed;
    }

    let itemNumber = cell("itemNumber");
    if (!itemNumber) {
      itemNumber = String(nextItemNumber).padStart(3, "0");
      nextItemNumber++;
    } else if (/^\d+$/.test(itemNumber)) {
      // Numbers handed out for blank cells continue past any given in the file.
      nextItemNumber = Math.max(nextItemNumber, Number(itemNumber) + 1);
    }

    lines.push({
      itemNumber,
      partNumber: partNumber || null,
      // Blank when only a part number was given: the server fills it from
      // the matched part, or falls back to the part number.
      name,
      description: cell("description") || null,
      quantity,
      unit: cell("unit") || "EA",
      material: cell("material") || null,
      vendor: cell("vendor") || null,
      unitCost,
      sortOrder: options.firstSortOrder + lines.length,
    });
  }

  return { ok: true, lines, skipped };
}

/** The most lines one request may add — the items route refuses more. */
export const MAX_IMPORT_LINES = 1000;

/** What `POST /api/boms/[bomId]/items` answers to `{ items }`. */
export interface BulkImportResult {
  inserted: number;
  /** Lines that ended up linked to a part. */
  linked: number;
  /** Part numbers the tenant has no part for; those lines are free text. */
  unmatchedPartNumbers: string[];
}

/** "Row 4: Quantity "two" is not a number…" for the first few, then a count. */
export function describeSkippedRows(skipped: SkippedRow[], limit = 5): string | undefined {
  if (skipped.length === 0) return undefined;
  const shown = skipped.slice(0, limit).map((s) => `Row ${s.row}: ${s.reason}`);
  const rest = skipped.length - shown.length;
  return shown.join(" ") + (rest > 0 ? ` …and ${rest} more.` : "");
}
