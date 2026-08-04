// Minimal CSV read/write utilities.
//
// We deliberately don't pull in papaparse / csv-parse — the formats we
// read and write are engineering data (parts, BOMs, vendors), where the
// rows are short, the input is small (a few thousand lines at most),
// and the features we need are modest: RFC-4180-ish quoting, embedded
// commas, embedded newlines, and doubled-quote escaping. Writing is
// even simpler.
//
// If these ever need to handle truly adversarial CSV, swap to papaparse
// at the call sites — the exported shape is intentionally thin so the
// migration is local.

/**
 * True when a string would be interpreted as a formula by Excel / Sheets /
 * LibreOffice rather than as text. Our exports carry user-supplied content
 * (part names, descriptions, vendor names), so a value like
 * `=cmd|'/c calc'!A1` in a part name executes on the machine of whoever
 * opens the export. See CWE-1236.
 *
 * `-` is in the dangerous set (`-1+1+cmd|...` is a valid formula) but is
 * also how every negative number starts, so we only treat a leading `-` as
 * dangerous when the value isn't just a number. Numeric values are never
 * escaped, which keeps `unitCost` and `weight` columns parsing as numbers.
 */
function isFormulaLike(s: string): boolean {
  if (/^[=+@\t\r]/.test(s)) return true;
  if (s.startsWith("-")) return !Number.isFinite(Number(s));
  return false;
}

/**
 * Serialize a single CSV field: quote it if it contains any of comma,
 * newline, or double-quote; double up embedded quotes. Numbers, nulls,
 * and `undefined` are coerced to their string representation (empty
 * string for null/undefined). Booleans become `"true"`/`"false"`.
 *
 * Formula-like strings are prefixed with a single quote and force-quoted,
 * which spreadsheets render as literal text. `parseCsvRecords` strips that
 * prefix back off, so an export → edit → re-import round trip is lossless.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const raw = String(value);
  const s = isFormulaLike(raw) ? `'${raw}` : raw;
  if (/[",\r\n]/.test(s) || s !== raw) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Undo the formula-injection guard applied by `csvField`. Strips exactly
 * one leading apostrophe when what follows would have been escaped on the
 * way out, so re-importing our own export yields the original value.
 */
export function unescapeCsvFormula(s: string): string {
  if (s.startsWith("'") && isFormulaLike(s.slice(1))) return s.slice(1);
  return s;
}

/**
 * Serialize a list of header strings and a list of row arrays into a
 * CSV string. The row arrays are zipped to the header length so a short
 * row is padded with empty fields and a long row is truncated.
 */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvField).join(",")];
  for (const row of rows) {
    const cells: string[] = [];
    for (let i = 0; i < headers.length; i++) cells.push(csvField(row[i]));
    lines.push(cells.join(","));
  }
  // CRLF keeps Excel happy without breaking anything else.
  return lines.join("\r\n");
}

/**
 * Parse a CSV string into an array of row arrays (the header, if any,
 * is returned as the first row — callers decide what to do with it).
 * Handles:
 *   - quoted fields that contain commas, newlines, or escaped quotes
 *     (`""` → `"`)
 *   - trailing newlines and stray `\r`
 *   - empty cells
 *
 * Does NOT handle: schema validation, type coercion, BOMs other than
 * the UTF-8 BOM at the very start. Those are caller concerns.
 */
export function parseCsv(input: string): string[][] {
  // Strip UTF-8 BOM if present — Excel adds it on Save As CSV.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // Escaped quote (`""`) collapses to one quote; a lone quote
        // ends the quoted section.
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      current.push(field);
      field = "";
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      // Flush the current row unless it's a pure empty trailing newline.
      if (field !== "" || current.length > 0) {
        current.push(field);
        rows.push(current);
        current = [];
        field = "";
      }
      // \r\n should only flush once — skip the \n in that pair.
      if (ch === "\r" && text[i + 1] === "\n") i++;
      continue;
    }

    field += ch;
  }

  // Flush the final field/row if the file didn't end with a newline.
  if (field !== "" || current.length > 0) {
    current.push(field);
    rows.push(current);
  }

  return rows;
}

/**
 * Parse a CSV string into an array of objects keyed by the header row.
 * Header names are normalized (trim, lowercase) and unknown headers are
 * kept as-is so the caller can spot typos.
 *
 * Returns `{ rows, headers }` where `headers` is the normalized header
 * array (same order as in the CSV) — useful for validation messages.
 */
export function parseCsvRecords(input: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const grid = parseCsv(input);
  if (grid.length === 0) return { headers: [], rows: [] };
  const headers = grid[0].map((h) => h.trim().toLowerCase());
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (row.length === 1 && row[0] === "") continue; // skip blank lines
    const rec: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      rec[headers[c]] = unescapeCsvFormula((row[c] ?? "").trim());
    }
    rows.push(rec);
  }
  return { headers, rows };
}
