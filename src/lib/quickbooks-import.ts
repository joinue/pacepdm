import { splitRevision } from "@/lib/bom-import";

/**
 * Reading a raw QuickBooks item export.
 *
 * The constraint that shapes all of this: **QuickBooks will not filter the
 * export.** You get the whole item list — 7,000+ rows covering consumables,
 * services, sales tax items and every machine — or nothing. So the filtering
 * has to happen here, and the file has to be accepted exactly as QuickBooks
 * writes it.
 *
 * Six things about that file are not guessable from its header row, and each
 * one silently ruins an import that does not expect it.
 *
 *   1. **`Item` is a path, not a part number.** QuickBooks items are
 *      hierarchical and the export writes the whole ancestry:
 *      `PACE Equipment:NANO-1000S-parts:Mechanical Components:N1S-M-001`.
 *      The part number is the last segment.
 *
 *   2. **There is no name column.** `Item` and `Description` are all there is,
 *      and the parts importer requires a name. `Description` is the human
 *      label, so that becomes the name and the leaf is the fallback.
 *
 *   3. **Several rows describe one part.** A part number appears once per
 *      revision — `N1S-M-001`, `-R1`, `-R2`, `-R3` are four rows for one
 *      casting. Importing them all makes the last one win, which is how a
 *      current part silently acquires a superseded vendor. See
 *      `chooseRowForPart`.
 *
 *   4. **`Type` and `Active Status` are load-bearing.** Services, sales tax
 *      items, discounts and subtotals are all in there, as are inactive rows.
 *      None are parts.
 *
 *   5. **The file is Windows-1252, not UTF-8.** Decoding it as UTF-8 corrupts
 *      µm, °C and quotation marks. Handled in the route, at the point the
 *      bytes are read.
 *
 *   6. **Vendor names can contain a literal backslash-n** —
 *      `DongGuan RX\n& LinFeiTeng` — which is an escape that was never
 *      un-escaped somewhere upstream, not a line break.
 *
 * What this module deliberately does NOT do is decide anything a human should.
 * It cannot know that `N1S-M-006-R1` ("Control Box Swivel Connector") is a
 * different component from `N1S-M-006-R2` ("Faucet hose retracted mechanism")
 * rather than a revision of it. It surfaces the collision and moves on.
 */

/** Item types that represent something a PDM would call a part. */
const PART_TYPES = new Set(["Inventory Part", "Inventory Assembly", "Non-inventory Part"]);

/**
 * Header names unique enough to identify a QuickBooks export. `item` alone is
 * too common; `active status` alongside it is not.
 *
 * Lowercase, because `parseCsvRecords` lowercases every header — which is also
 * why the record keys below are lowercase.
 */
const SIGNATURE = ["item", "type", "active status"];

export interface QuickBooksRow {
  /** Full colon-delimited path, kept for diagnostics. */
  itemPath: string;
  /** Last path segment — `N1S-M-001-R2`. Stored as `externalId`. */
  leaf: string;
  /** Leaf with any `-R<n>` suffix removed — the PACE part number. */
  partNumber: string;
  /** The `R2` from `N1S-M-001-R2`, or null when the leaf carries no suffix. */
  revision: string | null;
  name: string;
  description: string | null;
  unitCost: number | null;
  vendor: string | null;
  weight: number | null;
  /** Row number in the source file, so a warning can name a line. */
  sourceRow: number;
}

/** True when the headers look like a QuickBooks item export rather than ours. */
export function looksLikeQuickBooksExport(headers: string[]): boolean {
  const present = new Set(headers.map((h) => h.trim().toLowerCase()));
  return SIGNATURE.every((h) => present.has(h));
}

/**
 * QuickBooks writes `\n` as two literal characters inside vendor names, and
 * trailing spaces are common throughout. Neither is meaningful.
 */
function cleanText(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
  return cleaned === "" ? null : cleaned;
}

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.replace(/[$,]/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

export interface SkipReason {
  sourceRow: number;
  item: string;
  reason: string;
}

export interface ParsedQuickBooksExport {
  rows: QuickBooksRow[];
  /** Rows deliberately not treated as parts, with why. Counted, not listed in full. */
  skipped: SkipReason[];
}

/**
 * Turn raw CSV records into part-shaped rows, dropping everything that is not
 * an active part.
 *
 * `records` are keyed by lowercased header, matching `parseCsvRecords`.
 */
export function parseQuickBooksExport(
  records: Array<Record<string, string>>
): ParsedQuickBooksExport {
  const rows: QuickBooksRow[] = [];
  const skipped: SkipReason[] = [];

  records.forEach((record, index) => {
    const sourceRow = index + 2; // +1 for the header, +1 for 1-based
    const itemPath = (record["item"] ?? "").trim();
    const type = (record["type"] ?? "").trim();
    const active = (record["active status"] ?? "").trim();

    if (!itemPath) {
      skipped.push({ sourceRow, item: "", reason: "No item name" });
      return;
    }
    if (!PART_TYPES.has(type)) {
      skipped.push({ sourceRow, item: itemPath, reason: `Not a part (${type || "no type"})` });
      return;
    }
    if (active && active !== "Active") {
      skipped.push({ sourceRow, item: itemPath, reason: "Inactive in QuickBooks" });
      return;
    }

    // The part number is the last path segment. A QuickBooks item name may
    // itself contain a colon only through its ancestry, so splitting on ":"
    // and taking the tail is safe.
    const leaf = itemPath.split(":").pop()!.trim();
    const { partNumber, revision } = splitRevision(leaf);

    const description =
      cleanText(record["description"]) ?? cleanText(record["purchase description"]);

    rows.push({
      itemPath,
      leaf,
      partNumber,
      revision,
      // No name column exists. The description is the human label; the leaf is
      // the fallback so a part is never nameless.
      name: description ?? leaf,
      description,
      unitCost: parseNumber(record["cost"]),
      vendor: cleanText(record["preferred vendor"]),
      weight: parseNumber(record["weight"]),
      sourceRow,
    });
  });

  return { rows, skipped };
}

export interface ChosenRow {
  row: QuickBooksRow;
  /** The other entries for this part number that were not used. */
  rejected: QuickBooksRow[];
  /** Set when the choice is worth a human looking at it. */
  warning: string | null;
}

/**
 * Pick the one QuickBooks row that describes a part, given what revision the
 * PDM holds.
 *
 * This is the heart of it. A part number appears once per revision in
 * QuickBooks, and the PDM holds exactly one revision, so the file always has
 * more rows than the PDM has parts. Applying them all makes the last row win
 * — which is how a current casting silently acquires the vendor from a
 * revision that was superseded two years ago.
 *
 * Order of preference:
 *
 *   1. **The row whose revision matches the PDM's.** Unambiguous.
 *   2. **A row with no revision suffix at all**, when nothing matches. The
 *      bare entry is the generic one, and it is better than guessing between
 *      `-R1` and `-R3`.
 *   3. **Nothing.** If the file has only revisions the PDM does not hold, no
 *      row is applied and the caller is told. Picking the highest would look
 *      helpful and would be a guess about which physical part is on the shelf.
 *
 * Case 3 is real rather than defensive: the PDM holds `N1S-M-001` at `R2`
 * while QuickBooks also carries an `R3` filed under a different machine. That
 * is a genuine divergence between the two systems, and the honest response is
 * to report it rather than to resolve it.
 */
export function chooseRowForPart(
  candidates: QuickBooksRow[],
  pdmRevision: string | null
): ChosenRow | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    return { row: candidates[0], rejected: [], warning: null };
  }

  const others = (chosen: QuickBooksRow) => candidates.filter((c) => c !== chosen);

  const exact = pdmRevision
    ? candidates.find((c) => c.revision?.toUpperCase() === pdmRevision.toUpperCase())
    : undefined;
  if (exact) {
    const rejected = others(exact);
    return {
      row: exact,
      rejected,
      warning:
        `QuickBooks has ${candidates.length} entries for this part ` +
        `(${candidates.map((c) => c.leaf).join(", ")}). Used ${exact.leaf} to match ` +
        `revision ${pdmRevision}.`,
    };
  }

  const bare = candidates.find((c) => c.revision === null);
  if (bare) {
    return {
      row: bare,
      rejected: others(bare),
      warning:
        `No QuickBooks entry matches revision ${pdmRevision ?? "(none)"} ` +
        `(found ${candidates.map((c) => c.leaf).join(", ")}). Used the unversioned ` +
        `entry ${bare.leaf} — check this is the right one.`,
    };
  }

  return {
    row: candidates[0],
    rejected: others(candidates[0]),
    warning:
      `Skipped: QuickBooks has ${candidates.map((c) => c.leaf).join(", ")} but this part ` +
      `is at revision ${pdmRevision ?? "(none)"} here. Nothing was applied — reconcile the ` +
      `revision in one system or the other.`,
  };
}

/** True when `chooseRowForPart` declined to apply anything. */
export function isUnapplied(chosen: ChosenRow, pdmRevision: string | null): boolean {
  if (chosen.rejected.length === 0) return false;
  const matchesRevision =
    pdmRevision && chosen.row.revision?.toUpperCase() === pdmRevision.toUpperCase();
  return !matchesRevision && chosen.row.revision !== null;
}

/**
 * Group parsed rows by the part number they resolve to, so the caller can ask
 * `chooseRowForPart` once per part rather than once per row.
 */
export function groupByPartNumber(rows: QuickBooksRow[]): Map<string, QuickBooksRow[]> {
  const groups = new Map<string, QuickBooksRow[]>();
  for (const row of rows) {
    const list = groups.get(row.partNumber) ?? [];
    list.push(row);
    groups.set(row.partNumber, list);
  }
  return groups;
}

/**
 * Flag part numbers whose entries describe visibly different things.
 *
 * `N1S-M-006-R1` is "NANO-S Control Box Swivel Connector" and `-R2` is
 * "Faucet hose retracted mechanism". Those are not revisions of one component;
 * they are two components sharing a number. No importer can resolve that, and
 * quietly picking one would put the wrong description and vendor on a part
 * that a BOM already references.
 *
 * The test is deliberately crude — the first few significant words — because
 * the goal is to raise a hand, not to be clever. A false positive costs
 * someone ten seconds; a miss costs a wrong part on a bill of materials.
 */
export function looksLikeNumberingCollision(candidates: QuickBooksRow[]): boolean {
  const fingerprints = new Set(
    candidates
      .map((c) => c.description ?? "")
      .filter(Boolean)
      .map((d) =>
        d
          .toLowerCase()
          .replace(/\(.*?\)/g, "") // drop "(part no. …)" tails
          .replace(/[^a-z0-9 ]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 3)
          .slice(0, 3)
          .join(" ")
      )
      .filter(Boolean)
  );
  return fingerprints.size > 1;
}
